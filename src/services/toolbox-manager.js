import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { appError, ErrorCodes } from "../utils/errors.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOOLBOX_IMAGE = "praxis-toolbox:latest";
const TOOLBOX_DOCKERFILE_DIR = path.resolve(__dirname, "../../docker/toolbox");

export const TOOLBOX_SERVICE_NAME = "toolbox";

// Not a SERVICE_CATALOG entry (forced/always-on, never user-selectable). No `type` means
// health-manager.js's checkOnce() hits its `default: return true` branch - there's no server
// process to probe, so "container is running" is all that's needed.
export const TOOLBOX_CATALOG_ENTRY = { healthcheck: {} };

export const TOOLBOX_DESCRIPTION =
  'General-purpose shell container with Python 3 and common CLI tools preinstalled ' +
  "(git, curl, wget, jq, vim, ping, dig, netstat, ssh, etc.). Use it to debug the other " +
  'services in this environment or run ad-hoc scripts via POST /environments/:id/execute ' +
  'with {"service": "toolbox", "command": [...]}. IMPORTANT: it shares a private docker ' +
  'network with every other service here, not the host machine - reach other services by ' +
  'their service name as the hostname (e.g. "ledger"), never "localhost"/127.0.0.1 (which ' +
  "resolves back to this container itself), and use the port from this response's, e.g. to hit the auth service through this tool box execute the command 'curl http://auth:8080/' - the service's actual domains are given in the service_endpoints key in the response' " +
  '"service_endpoints" map (services do not publish ports to the host), also fetchable anytime via ' +
  "GET /environments/:id/service-endpoints. Commands containing \"localhost\"/127.0.0.1/0.0.0.0/::1 are rejected.";

async function buildToolboxImage() {
  try {
    await execFileAsync("docker", ["build", "-t", TOOLBOX_IMAGE, TOOLBOX_DOCKERFILE_DIR], {
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (err) {
    throw appError(ErrorCodes.IMAGE_BUILD_FAILED, "Failed to build the toolbox image", {
      cause: String(err.stderr || err.message || err),
      hint: "See cause for the underlying docker build failure."
    });
  }
}

// Unlike the orchestrator image, the toolbox Dockerfile is local and static (no upstream repo to
// pull), so repeat builds just hit Docker's own layer cache - safe to call on every environment
// creation. Concurrent creation jobs that land mid-build await the same in-flight build instead
// of racing separate `docker build`s.
let imageReady = null;
export async function ensureToolboxImage() {
  if (!imageReady) {
    imageReady = buildToolboxImage().finally(() => {
      imageReady = null;
    });
  }
  return imageReady;
}
