import { findContainer, execInContainer } from "../docker/docker-client.js";
import { getEnvironment } from "./environment-manager.js";
import * as jobManager from "./job-manager.js";
import { JOB_TYPES, JOB_STATUS } from "../types/constants.js";
import { appError, AppError, ErrorCodes } from "../utils/errors.js";
import logger from "../utils/logger.js";

const DEFAULT_TIMEOUT_SEC = 10;

// Runs entirely inside the toolbox container. All caller-supplied data (method/headers/body/url)
// is only ever referenced via "$1"/"$@" positional params below, never interpolated into the
// script text itself - no shell/command injection vector regardless of what those values contain.
const CONCURRENT_HIT_SCRIPT = `set -u
count="$1"; shift
dir=$(mktemp -d)
for i in $(seq 1 "$count"); do
  ( curl -s -o /dev/null -w "%{http_code} %{time_total}\\n" "$@" > "$dir/$i.out" 2>"$dir/$i.err" ) &
done
wait
cat "$dir"/*.out
rm -rf "$dir"
`;

// Pure/testable: builds the method/header/body portion of the curl argv (caller appends --max-time + url).
export function buildCurlArgs({ method, headers = {}, body }) {
  const args = ["-X", method];
  const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
  for (const [key, value] of Object.entries(headers)) {
    args.push("-H", `${key}: ${value}`);
  }
  if (body !== undefined) {
    if (!hasContentType) args.push("-H", "Content-Type: application/json");
    args.push("--data-raw", JSON.stringify(body));
  }
  return args;
}

const RESULT_LINE_RE = /^(\d{3}) ([\d.]+)$/;

// Pure/testable: turns the script's "<httpCode> <timeTotalSeconds>" lines into an aggregate summary.
export function parseCurlOutput(stdout, hitCount) {
  const latenciesMs = [];
  const statusCodes = {};
  let succeeded = 0;

  for (const line of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const match = RESULT_LINE_RE.exec(line);
    if (!match) continue;
    const [, code, timeTotal] = match;
    statusCodes[code] = (statusCodes[code] || 0) + 1;
    latenciesMs.push(Math.round(parseFloat(timeTotal) * 1000));
    if (code[0] === "2" || code[0] === "3") succeeded++;
  }

  const completed = latenciesMs.length;
  return {
    hitCount,
    completed,
    missing: Math.max(0, hitCount - completed),
    succeeded,
    failed: completed - succeeded,
    statusCodes,
    latencyMs: completed
      ? {
          min: Math.min(...latenciesMs),
          max: Math.max(...latenciesMs),
          avg: Math.round(latenciesMs.reduce((a, b) => a + b, 0) / completed)
        }
      : { min: null, max: null, avg: null }
  };
}

async function runLoadTestJob(jobId, project, targetUrl, { method, headers, body, hitCount, timeout }) {
  jobManager.markRunning(jobId);
  const perRequestTimeoutSec = timeout || DEFAULT_TIMEOUT_SEC;
  try {
    jobManager.appendProgress(jobId, `firing ${hitCount} concurrent ${method} requests at ${targetUrl}`);

    const container = await findContainer(project, "toolbox");
    if (!container) {
      throw appError(ErrorCodes.SERVICE_NOT_FOUND, `"toolbox" container not found in this environment`, {
        service: "toolbox",
        hint: "This environment may predate toolbox support - recreate it via POST /environments."
      });
    }

    const curlArgs = [...buildCurlArgs({ method, headers, body }), "--max-time", String(perRequestTimeoutSec), targetUrl];
    const result = await execInContainer(
      container.Id,
      ["bash", "-c", CONCURRENT_HIT_SCRIPT, "load-test", String(hitCount), ...curlArgs],
      { timeoutSec: perRequestTimeoutSec + 30 }
    );

    // Same convention as execution.js: GNU coreutils' timeout exits 124, busybox's exits 143.
    if (result.exitCode === 124 || result.exitCode === 143) {
      throw appError(ErrorCodes.LOAD_TEST_TIMEOUT, `Load test timed out after ${perRequestTimeoutSec + 30}s`, {
        targetUrl,
        hitCount,
        hint: "Lower hitCount, lower timeout, or check whether the target service is hanging."
      });
    }
    if (result.exitCode !== 0) {
      throw appError(ErrorCodes.LOAD_TEST_FAILED, `Load test script exited with code ${result.exitCode}`, {
        targetUrl,
        cause: result.stderr || undefined,
        hint: "See cause for the underlying failure."
      });
    }

    const summary = parseCurlOutput(result.stdout, hitCount);
    jobManager.appendProgress(jobId, `completed: ${summary.succeeded}/${summary.hitCount} succeeded`);
    jobManager.markReady(jobId, { targetUrl, method, ...summary });
  } catch (err) {
    if (err instanceof AppError && err.code === ErrorCodes.LOAD_TEST_TIMEOUT) jobManager.markTimeout(jobId, err);
    else jobManager.markFailed(jobId, err);
    logger.error({ err, jobId, targetUrl }, "load test job failed");
  }
}

export function runLoadTest(environmentId, serviceName, { endpoint, method, headers, body, hitCount, timeout }) {
  const env = getEnvironment(environmentId);
  const baseUrl = env.service_endpoints[serviceName];
  if (!baseUrl) {
    throw appError(ErrorCodes.SERVICE_NOT_FOUND, `Service "${serviceName}" has no reachable HTTP endpoint in this environment`, {
      service: serviceName,
      serviceEndpoints: env.service_endpoints,
      hint: "Choose a service name from serviceEndpoints - it must be provisioned and have a catalogued HTTP port."
    });
  }

  const targetUrl = `${baseUrl}${endpoint}`;
  const jobId = jobManager.createJob({ environmentId, type: JOB_TYPES.LOAD_TEST });
  runLoadTestJob(jobId, env.compose_project, targetUrl, { method, headers, body, hitCount, timeout }).catch((err) =>
    logger.error({ err, jobId }, "load test job crashed")
  );
  return { jobId, status: JOB_STATUS.QUEUED };
}
