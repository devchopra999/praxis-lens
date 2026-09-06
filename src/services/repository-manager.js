import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appError, ErrorCodes } from "../utils/errors.js";
import { isCataloguedService, getRepositoryUrl, getCatalogEntry } from "../config/service-catalog.js";
import { addVolumeMount } from "./compose-override.js";

const execFileAsync = promisify(execFile);

function assertSafeUrl(url) {
  if (typeof url !== "string" || !/^https:\/\//.test(url)) {
    throw appError(ErrorCodes.REPOSITORY_CLONE_FAILED, "Only https:// repository URLs are allowed", {
      url,
      hint: 'Use an https:// clone URL (e.g. "https://github.com/org/repo.git"); ssh/git:// URLs are rejected.'
    });
  }
}

function assertSafeCommit(commit) {
  if (typeof commit !== "string" || !/^[0-9a-fA-F]{7,40}$/.test(commit)) {
    throw appError(ErrorCodes.REPOSITORY_CLONE_FAILED, "commit must be a valid git SHA", {
      commit,
      hint: '"commit" must be a 7-40 character hexadecimal git SHA (e.g. from `git rev-parse HEAD`).'
    });
  }
}

// Blocks flag injection (a leading "-" would be read by git as an option) and shell metacharacters.
function assertSafeBranch(branch) {
  if (typeof branch !== "string" || branch.startsWith("-") || !/^[\w./-]+$/.test(branch)) {
    throw appError(ErrorCodes.REPOSITORY_CLONE_FAILED, "branch must be a valid git branch name", {
      branch,
      hint: '"branch" must be a valid git branch name (letters, digits, ".", "/", "-", "_") and cannot start with "-".'
    });
  }
}

// Per-service checkout directory, distinct from the whole-environment `repo` dir used by
// cloneAndCheckout/attachRepository, since a single environment can build several services from source.
export function serviceRepoPath(workspace, serviceName) {
  return path.join(workspace, "services", serviceName, "repo");
}

export function buildImageTag(environmentId, serviceName) {
  return `praxis-env-${environmentId.replace(/^env-/, "")}-${serviceName}:latest`;
}

// Implements the "start service on branch" flow: reuse an existing checkout when present
// (inspecting it instead of re-cloning), otherwise clone fresh. When a branch is given, check it
// out and pull; when it isn't, the existing checkout is left exactly as-is ("keep current branch/state").
export async function syncServiceRepository({ environmentId, workspace, serviceName, branch }) {
  const url = getRepositoryUrl(serviceName);
  if (!url) {
    throw appError(ErrorCodes.REPOSITORY_NOT_CONFIGURED, `No repository is configured for service "${serviceName}"`, {
      service: serviceName,
      hint: "This service has no repository configured, so it can't be started from a branch; omit branch to use its default image."
    });
  }
  assertSafeUrl(url);
  if (branch) assertSafeBranch(branch);

  const dest = serviceRepoPath(workspace, serviceName);
  const alreadyCloned = fs.existsSync(path.join(dest, ".git"));

  try {
    if (!alreadyCloned) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const args = ["clone", ...(branch ? ["--branch", branch] : []), url, dest];
      await execFileAsync("git", args);
    } else if (branch) {
      await execFileAsync("git", ["fetch", "origin", branch], { cwd: dest });
      await execFileAsync("git", ["checkout", branch], { cwd: dest });
      await execFileAsync("git", ["pull", "origin", branch], { cwd: dest });
    }
    // else: no branch requested on an existing checkout -> keep current branch/state, no pull.
  } catch (err) {
    throw appError(ErrorCodes.REPOSITORY_CLONE_FAILED, `Failed to sync ${url} for service "${serviceName}"`, {
      service: serviceName,
      branch,
      cause: String(err.message || err),
      hint: "See cause for the underlying git failure (e.g. branch doesn't exist, auth required) and retry with a valid branch."
    });
  }

  const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dest });
  return { dest, branch: stdout.trim(), url, freshlyCloned: !alreadyCloned };
}

// Generic, catalog-driven Dockerfile for repos that don't ship their own (spec still requires a
// plain `docker build`, never a language-specific build plugin) - only the `build` config differs
// per service, this generation logic has no per-repo special-casing.
//
// service-manager.js always bind-mounts the checked-out source over /app for dev-mode editing,
// which replaces whatever the image baked in at that path. So anything the running process needs
// that isn't part of the live-editable source (a compiled jar, installed node_modules) must live
// outside /app or it will disappear the moment the container starts.
function generateDockerfile(build) {
  if (build.type === "maven") {
    return `FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY . .
RUN chmod +x mvnw && ./mvnw -q -DskipTests package

# debian-based (not -alpine): eclipse-temurin's 17-jre-alpine tag only publishes an amd64
# manifest, so it fails to resolve on arm64 hosts (e.g. Apple Silicon); this tag is multi-arch
FROM eclipse-temurin:17-jre
# wget isn't preinstalled here (unlike alpine's busybox) but the exec-based HTTP healthcheck needs it
RUN apt-get update && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/*
# jar lives outside /app so the dev-mode source bind mount can't shadow it
WORKDIR /opt/app
COPY --from=build /app/target/*.jar app.jar
ENTRYPOINT ["java", "-jar", "app.jar"]
`;
  }
  if (build.type === "node") {
    return `FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install --omit=dev --ignore-scripts && cp -r node_modules /opt-node-modules
# node_modules copy lives outside /app so the dev-mode source bind mount can't shadow it;
# NODE_PATH lets node still resolve dependencies from there once /app is replaced at runtime
ENV NODE_PATH=/opt-node-modules
ENTRYPOINT ["node", "${build.entry}"]
`;
  }
  throw new Error(`Unsupported build type "${build.type}"`);
}

// docker build the checked-out repo into an environment+service scoped image tag. Uses the repo's
// own Dockerfile if it has one; otherwise generates one from the service's catalog `build` config
// (real images bring their own entrypoint/build, but plain `docker build` only - never a
// language-specific build plugin like `mvnw spring-boot:build-image`).
export async function buildServiceImage({ environmentId, serviceName, repoDir }) {
  let dockerfilePath = path.join(repoDir, "Dockerfile");

  if (!fs.existsSync(dockerfilePath)) {
    const build = getCatalogEntry(serviceName)?.build;
    if (!build) {
      throw appError(ErrorCodes.IMAGE_BUILD_FAILED, `No Dockerfile found in repository for service "${serviceName}"`, {
        service: serviceName,
        repoDir,
        hint: "The repository has no Dockerfile and the catalog entry has no build config to generate one from; use the default image (omit branch) instead."
      });
    }
    dockerfilePath = path.join(repoDir, "Dockerfile.praxis-generated");
    fs.writeFileSync(dockerfilePath, generateDockerfile(build));
  }

  const tag = buildImageTag(environmentId, serviceName);
  try {
    await execFileAsync("docker", ["build", "-f", dockerfilePath, "-t", tag, repoDir], { maxBuffer: 20 * 1024 * 1024 });
  } catch (err) {
    throw appError(ErrorCodes.IMAGE_BUILD_FAILED, `docker build failed for service "${serviceName}"`, {
      service: serviceName,
      cause: String(err.stderr || err.message || err),
      hint: "See cause for the docker build error; the checked-out branch's Dockerfile/build config is likely broken."
    });
  }
  return tag;
}

// Clones into workspace/repo and checks out the exact commit; never accepts arbitrary host paths.
export async function cloneAndCheckout({ environmentId, workspace, url, commit }) {
  assertSafeUrl(url);
  assertSafeCommit(commit);

  const dest = path.join(workspace, "repo");
  fs.rmSync(dest, { recursive: true, force: true });

  try {
    await execFileAsync("git", ["clone", url, dest]);
    await execFileAsync("git", ["checkout", commit], { cwd: dest });
  } catch (err) {
    throw appError(ErrorCodes.REPOSITORY_CLONE_FAILED, `Failed to clone/checkout ${url}@${commit}`, {
      cause: String(err.message || err),
      hint: "See cause for the underlying git failure; verify the url is reachable and commit exists in that repository."
    });
  }

  // Bind-mount any top-level dir matching a catalogued service name so a coding agent can edit
  // source under the workspace and have a dev-mode container pick it up on restart (Section 25).
  const mountedServices = [];
  for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
    if (entry.isDirectory() && isCataloguedService(entry.name)) {
      addVolumeMount(environmentId, entry.name, path.join(dest, entry.name), "/app");
      mountedServices.push(entry.name);
    }
  }

  return { dest, mountedServices };
}
