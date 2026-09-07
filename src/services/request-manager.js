import { findContainer, execInContainer } from "../docker/docker-client.js";
import { getEnvironment } from "./environment-manager.js";
import { buildCurlArgs } from "./load-test-manager.js";
import { appError, AppError, ErrorCodes } from "../utils/errors.js";

const DEFAULT_TIMEOUT_SEC = 10;
const HEADERS_MARKER = "---PRAXIS-HEADERS---";
const BODY_MARKER = "---PRAXIS-BODY-B64---";

// Runs entirely inside the toolbox container. All caller-supplied data (method/headers/body/url)
// is only ever referenced via "$@" positional params below, never interpolated into the script
// text itself - no shell/command injection vector regardless of what those values contain.
// Captures status/headers/body separately (unlike load-test's aggregate-only curl -w line) so the
// caller gets back a real single response instead of just a stats summary.
const SINGLE_REQUEST_SCRIPT = `set -u
tmp=$(mktemp -d)
http_code=$(curl -s -D "$tmp/headers" -o "$tmp/body" -w '%{http_code}' "$@")
curl_exit=$?
printf '%s\\n' "$curl_exit"
printf '%s\\n' "$http_code"
echo '${HEADERS_MARKER}'
cat "$tmp/headers" 2>/dev/null
echo '${BODY_MARKER}'
base64 < "$tmp/body" 2>/dev/null | tr -d '\\n'
rm -rf "$tmp"
`;

// Pure/testable: turns the raw curl header dump into a plain object, skipping the status line
// and lower-casing keys (matches the convention of Node's/fetch's header maps).
export function parseHeaderBlock(raw) {
  const headers = {};
  for (const line of raw.split("\r\n").map((l) => l.trim()).filter(Boolean)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue; // status line (e.g. "HTTP/1.1 200 OK")
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
  }
  return headers;
}

// Pure/testable: parses SINGLE_REQUEST_SCRIPT's stdout into { curlExit, statusCode, headers, body }.
// Body is JSON-parsed when the response declares a JSON content-type, otherwise returned as text
// (or null if empty) - never left as opaque base64 for the caller to decode themselves.
export function parseRequestOutput(stdout) {
  const headersIdx = stdout.indexOf(HEADERS_MARKER);
  const bodyIdx = stdout.indexOf(BODY_MARKER);
  const preamble = stdout.slice(0, headersIdx === -1 ? stdout.length : headersIdx).split("\n");
  const curlExit = parseInt(preamble[0], 10);
  const statusCode = parseInt(preamble[1], 10);

  const rawHeaders = headersIdx === -1 || bodyIdx === -1 ? "" : stdout.slice(headersIdx + HEADERS_MARKER.length, bodyIdx);
  const headers = parseHeaderBlock(rawHeaders);
  const bodyB64 = bodyIdx === -1 ? "" : stdout.slice(bodyIdx + BODY_MARKER.length).trim();

  let body = null;
  if (bodyB64) {
    const text = Buffer.from(bodyB64, "base64").toString("utf8");
    const contentType = headers["content-type"] || "";
    if (contentType.includes("json")) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    } else {
      body = text;
    }
  }

  return { curlExit, statusCode, headers, body };
}

export async function requestService(environmentId, serviceName, { endpoint, method, headers, body, timeout }) {
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

  const container = await findContainer(env.compose_project, "toolbox");
  if (!container) {
    throw appError(ErrorCodes.SERVICE_NOT_FOUND, `"toolbox" container not found in this environment`, {
      service: "toolbox",
      hint: "This environment may predate toolbox support - recreate it via POST /environments."
    });
  }

  const perRequestTimeoutSec = timeout || DEFAULT_TIMEOUT_SEC;
  const curlArgs = [...buildCurlArgs({ method, headers, body }), "--max-time", String(perRequestTimeoutSec), targetUrl];

  let result;
  try {
    result = await execInContainer(container.Id, ["bash", "-c", SINGLE_REQUEST_SCRIPT, "request", ...curlArgs], {
      timeoutSec: perRequestTimeoutSec + 10
    });
  } catch (err) {
    throw appError(ErrorCodes.REQUEST_FAILED, `Failed to reach "${serviceName}"`, {
      service: serviceName,
      targetUrl,
      cause: String(err.message || err),
      hint: "Verify the service is running and the endpoint path is correct."
    });
  }

  // Same convention as execution.js/load-test-manager.js: GNU coreutils' timeout exits 124,
  // busybox's exits 143 - both mean the outer wrapper killed the script before curl returned.
  if (result.exitCode === 124 || result.exitCode === 143) {
    throw appError(ErrorCodes.REQUEST_TIMEOUT, `Request to "${serviceName}" timed out after ${perRequestTimeoutSec}s`, {
      service: serviceName,
      targetUrl,
      hint: 'Increase "timeout" (seconds) or check whether the target service is hanging.'
    });
  }

  const { curlExit, statusCode, headers: responseHeaders, body: responseBody } = parseRequestOutput(result.stdout);

  if (curlExit === 28) {
    throw appError(ErrorCodes.REQUEST_TIMEOUT, `Request to "${serviceName}" timed out after ${perRequestTimeoutSec}s`, {
      service: serviceName,
      targetUrl,
      hint: 'Increase "timeout" (seconds) or check whether the target service is hanging.'
    });
  }
  if (curlExit !== 0) {
    throw appError(ErrorCodes.REQUEST_FAILED, `curl failed reaching "${serviceName}" (exit ${curlExit})`, {
      service: serviceName,
      targetUrl,
      cause: result.stderr || undefined,
      hint: "Verify the service is running and reachable at its service_endpoints URL."
    });
  }

  return {
    targetUrl,
    method,
    statusCode,
    headers: responseHeaders,
    body: responseBody,
    durationMs: result.durationMs
  };
}
