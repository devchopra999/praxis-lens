import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { appError, ErrorCodes } from "../utils/errors.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(__dirname, "../../compose/docker-compose.template.yml");

function workspaceRoot() {
  return process.env.PRAXIS_WORKSPACES_DIR || path.resolve(__dirname, "../../workspaces");
}

function overridePath(environmentId) {
  return path.join(workspaceRoot(), environmentId, "docker-compose.override.yml");
}

// Per-environment override (workspace bind-mounts etc.) is optional and only applied if present.
function composeFileArgs(environmentId) {
  const args = ["-f", TEMPLATE_PATH];
  if (fs.existsSync(overridePath(environmentId))) args.push("-f", overridePath(environmentId));
  return args;
}

async function runCompose(project, environmentId, args) {
  const cmd = ["compose", "-p", project, ...composeFileArgs(environmentId), ...args];
  try {
    return await execFileAsync("docker", cmd, { env: { ...process.env }, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    throw appError(ErrorCodes.SERVICE_START_FAILED, `docker compose ${args.join(" ")} failed`, {
      cause: String(err.stderr || err.message || err),
      hint: "See cause for the underlying docker/compose error (bad image, port conflict, invalid compose config, etc.)."
    });
  }
}

export async function up(project, environmentId, serviceNames) {
  return runCompose(project, environmentId, ["up", "-d", ...serviceNames]);
}

export async function restartService(project, environmentId, serviceName) {
  return runCompose(project, environmentId, ["restart", serviceName]);
}

export async function stopService(project, environmentId, serviceName) {
  return runCompose(project, environmentId, ["stop", serviceName]);
}

export async function down(project, environmentId) {
  try {
    return await runCompose(project, environmentId, ["down", "-v", "--remove-orphans"]);
  } catch {
    // idempotent: tearing down an already-gone/never-started project is not an error
    return { stdout: "", stderr: "" };
  }
}
