import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireEnvironment, workspacePath } from "./environment-manager.js";
import { serviceRepoPath } from "./repository-manager.js";
import { isCataloguedService, SERVICE_REPOSITORIES } from "../config/service-catalog.js";
import { appError, ErrorCodes } from "../utils/errors.js";

const execFileAsync = promisify(execFile);

const AIDER_BIN = process.env.AIDER_BIN || "aider";
const DEFAULT_TIMEOUT_MS = Number(process.env.AIDER_TIMEOUT_MS) || 5 * 60 * 1000;
// Larger repo map = more of the codebase summarized in-context without sending full file
// contents; costs more tokens per request but no real file content is added.
const AIDER_MAP_TOKENS = Number(process.env.AIDER_MAP_TOKENS) || 4096;

// Only these prefixes are forwarded to the aider subprocess (its own config + known LLM provider
// keys, including AWS_* for Bedrock auth) - never the Docker socket, DB passwords, etc. that this
// process also holds.
const PASSTHROUGH_ENV_PATTERN =
  /^(AIDER_|OPENAI_|ANTHROPIC_|AZURE_|GEMINI_|GOOGLE_|GROQ_|DEEPSEEK_|OPENROUTER_|COHERE_|MISTRAL_|OLLAMA_|AWS_)/;

// Resolves the checked-out repo for a service from environment/service config only; the caller
// never supplies a filesystem path, so this can't be used to reach outside a workspace.
function resolveServiceRepoDir(environmentId, service) {
  requireEnvironment(environmentId);
  if (!isCataloguedService(service)) {
    throw appError(ErrorCodes.INVALID_SERVICE, `Unknown service "${service}"`, {
      service,
      validServices: Object.keys(SERVICE_REPOSITORIES),
      hint: "Only services with a configured repository can be used with aider; choose one of validServices."
    });
  }
  const repoDir = serviceRepoPath(workspacePath(environmentId), service);
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    throw appError(
      ErrorCodes.SERVICE_REPO_NOT_FOUND,
      `No repository checked out for service "${service}" in environment ${environmentId}`,
      {
        environmentId,
        service,
        hint: `Check out its repository first via POST /environments/${environmentId}/services/${service}/start with a "branch", then retry.`
      }
    );
  }
  return repoDir;
}

function aiderEnv() {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const [key, value] of Object.entries(process.env)) {
    if (PASSTHROUGH_ENV_PATTERN.test(key)) env[key] = value;
  }
  return env;
}

// Runs aider once, non-interactively, against repoDir and captures stdout/stderr/exit code.
// chatMode "ask" only answers questions; omit it (aider's default edit format) to allow edits -
// aider has no "code" chat-mode/edit-format value, so passing anything but "ask" is invalid.
function runAider(repoDir, prompt, chatMode, timeoutMs) {
  const args = [
    "--yes-always",
    "--no-auto-commits",
    "--no-check-update",
    "--no-analytics",
    "--map-tokens",
    String(AIDER_MAP_TOKENS),
    ...(chatMode ? ["--chat-mode", chatMode] : []),
    "--message",
    prompt
  ];

  return new Promise((resolve, reject) => {
    execFile(
      AIDER_BIN,
      args,
      { cwd: repoDir, env: aiderEnv(), timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          reject(
            appError(ErrorCodes.AIDER_TIMEOUT, `aider timed out after ${timeoutMs}ms`, {
              stdout,
              stderr,
              hint: 'Increase "timeoutMs" in the request, or ask a narrower/simpler question.'
            })
          );
        } else if (err && typeof err.code !== "number") {
          // spawn-level failure (e.g. aider binary not installed), not a nonzero exit code
          reject(
            appError(ErrorCodes.AIDER_FAILED, `Failed to run aider: ${err.message}`, {
              stdout,
              stderr,
              hint: "This is a server-side setup problem (aider not installed/misconfigured), not a bad request; retrying the same request won't help."
            })
          );
        } else {
          resolve({ exitCode: err ? err.code : 0, stdout, stderr });
        }
      }
    );
  });
}

// Stages untracked files as "intent to add" so `git diff` includes them too, then unstages
// (index-only, working tree untouched) so this stays a read-only inspection of aider's edits.
async function captureDiff(repoDir) {
  await execFileAsync("git", ["add", "-A", "-N"], { cwd: repoDir });
  const { stdout: diff } = await execFileAsync("git", ["diff"], { cwd: repoDir, maxBuffer: 20 * 1024 * 1024 });
  const { stdout: statusOut } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repoDir });
  await execFileAsync("git", ["reset"], { cwd: repoDir });

  const changedFiles = statusOut
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3));

  return { diff, changedFiles };
}

// Read-only: asks aider to inspect/explain the repository. Never modifies files.
export async function ask({ environmentId, service, prompt, timeoutMs }) {
  const repoDir = resolveServiceRepoDir(environmentId, service);
  const result = await runAider(repoDir, prompt, "ask", timeoutMs || DEFAULT_TIMEOUT_MS);
  return { environmentId, service, mode: "ask", ...result };
}

// Lets aider modify the repository, then returns a diff of what changed so the caller (Docker
// manager) can decide whether/how to rebuild and restart the service - this function never
// touches Docker, Compose, or any database itself.
export async function edit({ environmentId, service, prompt, timeoutMs }) {
  const repoDir = resolveServiceRepoDir(environmentId, service);
  const result = await runAider(repoDir, prompt, null, timeoutMs || DEFAULT_TIMEOUT_MS);
  const { diff, changedFiles } = await captureDiff(repoDir);
  return { environmentId, service, mode: "edit", ...result, diff, changedFiles };
}
