import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { findContainer, inspectContainer } from "../docker/docker-client.js";
import { workspacePath } from "./environment-manager.js";
import { addVolumeMount } from "./compose-override.js";
import { getCatalogEntry, listServiceNames } from "../config/service-catalog.js";
import { appError, ErrorCodes } from "../utils/errors.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ORCHESTRATOR_IMAGE = "praxis-orchestrator:latest";
const ORCHESTRATOR_PORT = 8000;
const ORCHESTRATOR_REPO_URL = "https://github.com/devchopra999/orchestrator.git";
const DEFAULT_ROUTES_PATH = path.resolve(__dirname, "../../orchestrator/routes.default.json");

// Not a SERVICE_CATALOG entry (orchestrator is hidden/forced, never user-selectable), so
// waitForHealthy needs this passed explicitly instead of resolving it from the catalog.
export const ORCHESTRATOR_CATALOG_ENTRY = { port: ORCHESTRATOR_PORT, healthcheck: { type: "http", path: "/healthz" } };

function dataDir() {
  return process.env.PRAXIS_DATA_DIR || path.resolve(__dirname, "../../data");
}

function orchestratorSrcDir() {
  return path.join(dataDir(), "orchestrator-src");
}

async function buildOrchestratorImage() {
  const src = orchestratorSrcDir();
  try {
    if (fs.existsSync(path.join(src, ".git"))) {
      await execFileAsync("git", ["pull"], { cwd: src });
    } else {
      fs.mkdirSync(path.dirname(src), { recursive: true });
      await execFileAsync("git", ["clone", ORCHESTRATOR_REPO_URL, src]);
    }
    await execFileAsync("docker", ["build", "-t", ORCHESTRATOR_IMAGE, src], { maxBuffer: 20 * 1024 * 1024 });
  } catch (err) {
    throw appError(ErrorCodes.IMAGE_BUILD_FAILED, "Failed to build the orchestrator image", {
      cause: String(err.stderr || err.message || err),
      hint: "See cause for the underlying git/docker build failure; verify the orchestrator repo is reachable."
    });
  }
}

// Pulls the latest orchestrator source and rebuilds praxis-orchestrator:latest on every call, so
// environment creation always picks up source changes. Concurrent environment-creation jobs that
// land while a build is already in flight await that same build instead of racing separate
// `docker build`s; the cache is cleared once it settles so the next create-env call rebuilds fresh.
let imageReady = null;
export async function ensureOrchestratorImage() {
  if (!imageReady) {
    imageReady = buildOrchestratorImage().finally(() => {
      imageReady = null;
    });
  }
  return imageReady;
}

// Seeds a fresh routes.json from the committed default (only on first provision - never clobbers
// routes an agent already registered/edited) and wires it in as the orchestrator's data volume.
export function provisionOrchestratorWorkspace(environmentId) {
  const dir = path.join(workspacePath(environmentId), "orchestrator", "data");
  fs.mkdirSync(dir, { recursive: true });
  const routesFile = path.join(dir, "routes.json");
  if (!fs.existsSync(routesFile)) {
    fs.copyFileSync(DEFAULT_ROUTES_PATH, routesFile);
  }
  addVolumeMount(environmentId, "orchestrator", dir, "/app/data");
}

// Same "publish to an OS-assigned host port, then look it up via container inspection" approach
// the old vault-manager.js used for Vault's port.
async function getOrchestratorHostUrl(project) {
  const container = await findContainer(project, "orchestrator");
  if (!container) {
    throw appError(ErrorCodes.ORCHESTRATOR_UNAVAILABLE, "orchestrator container not found in environment", {
      hint: "Wait for the environment's create job to finish before calling orchestrator endpoints."
    });
  }
  const info = await inspectContainer(container.Id);
  const hostPort = info.NetworkSettings?.Ports?.[`${ORCHESTRATOR_PORT}/tcp`]?.[0]?.HostPort;
  if (!hostPort) {
    throw appError(ErrorCodes.ORCHESTRATOR_UNAVAILABLE, "orchestrator port is not published to host", {
      hint: "The orchestrator container exists but isn't ready yet; wait for its health check and retry."
    });
  }
  return `http://127.0.0.1:${hostPort}`;
}

async function request(project, method, urlPath, body) {
  const baseUrl = await getOrchestratorHostUrl(project);
  let res;
  try {
    res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    throw appError(ErrorCodes.ORCHESTRATOR_UNAVAILABLE, "Failed to reach the orchestrator", {
      cause: String(err.message || err),
      hint: "The orchestrator container may still be starting; retry shortly."
    });
  }
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw appError(ErrorCodes.ORCHESTRATOR_UNAVAILABLE, `orchestrator responded with ${res.status}`, {
      cause: text,
      hint: "See cause for the orchestrator's error response."
    });
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// Optional per-service override for orchestrator targets that live outside the docker network
// (e.g. a mock server on a public EC2 host) - takes precedence over the catalog's internal
// address. Follows the same `process.env.X_IMAGE`-style override convention as service-catalog.js.
const EXTERNAL_TARGET_OVERRIDES = {
  "mock-server": process.env.MOCK_SERVER_EXTERNAL_URL
};

// A route's `target` is always given as a catalog service name (never a raw URL) - this resolves
// it to the actual address, so callers of putRoute/bulkRegisterRoutes never need to know or
// construct a target URL themselves. Only HTTP-catalogued services (mob/edi/mock-server, not raw
// TCP infra like mysql/redis) are valid orchestrator targets.
function resolveTargetUrl(name) {
  const override = EXTERNAL_TARGET_OVERRIDES[name];
  if (override) return override;

  const entry = getCatalogEntry(name);
  if (!entry || entry.healthcheck?.type !== "http") {
    const httpServiceNames = listServiceNames().filter((n) => getCatalogEntry(n)?.healthcheck?.type === "http");
    throw appError(ErrorCodes.VALIDATION_ERROR, `"${name}" is not a valid orchestrator target service`, {
      name,
      hint: `target must be one of the HTTP-catalogued services: ${httpServiceNames.join(", ")}`
    });
  }
  return `http://${name}:${entry.port}`;
}

export async function listRoutes(project) {
  const { data } = await request(project, "GET", "/api/routes");
  return data;
}

// Exact (from, to) match only - no wildcard fallback (matches the orchestrator's own semantics).
export async function getRoute(project, from, to) {
  const { status, data } = await request(project, "GET", `/api/routes/${encodeURIComponent(from)}/${encodeURIComponent(to)}`);
  if (status === 404) {
    throw appError(ErrorCodes.ORCHESTRATOR_ROUTE_NOT_FOUND, `No route registered for (from="${from}", to="${to}")`, {
      from,
      to,
      hint: "PUT .../orchestrator/routes/:from/:to to register one first."
    });
  }
  return data;
}

// `target` is a catalog service name (e.g. "mock-server"), not a URL - resolved here so routes
// keyed by the (from, to) pair only ever redirect that one caller, never every caller of `to`.
export async function putRoute(project, from, to, target) {
  const resolvedTarget = resolveTargetUrl(target);
  const { data } = await request(project, "PUT", `/api/routes/${encodeURIComponent(from)}/${encodeURIComponent(to)}`, { target: resolvedTarget });
  return data;
}

// `routes` is an array of { from, to, target }; each `target` is a catalog service name, resolved
// to a URL here before being sent as the array-shaped bulk body the orchestrator now expects.
export async function bulkRegisterRoutes(project, routes) {
  const resolved = routes.map((route) => ({ ...route, target: resolveTargetUrl(route.target) }));
  const { data } = await request(project, "POST", "/api/routes/bulk", { routes: resolved });
  return data;
}

export async function deleteRoute(project, from, to) {
  const { status, data } = await request(project, "DELETE", `/api/routes/${encodeURIComponent(from)}/${encodeURIComponent(to)}`);
  if (status === 404) {
    throw appError(ErrorCodes.ORCHESTRATOR_ROUTE_NOT_FOUND, `No route registered for (from="${from}", to="${to}")`, { from, to });
  }
  return data;
}

export async function getHealthz(project) {
  const { data } = await request(project, "GET", "/healthz");
  return data;
}

// Wires every started HTTP-catalogued service (mob/edi/mock-server, not raw TCP infra like
// mysql/redis) through to its own docker-network address, as the wildcard-from default so any
// caller without an explicit override reaches the real service. No-ops if none are HTTP services.
export async function registerCatalogRoutes(project, serviceNames) {
  const routes = serviceNames
    .filter((name) => getCatalogEntry(name)?.healthcheck?.type === "http")
    .map((name) => ({ from: "*", to: name, target: name }));
  if (routes.length === 0) return null;
  return bulkRegisterRoutes(project, routes);
}

export async function getOrchestratorInfo(project) {
  const hostUrl = await getOrchestratorHostUrl(project);
  let healthy = false;
  try {
    const health = await getHealthz(project);
    healthy = health?.status === "ok";
  } catch {
    healthy = false;
  }
  return {
    internalUrl: `http://orchestrator:${ORCHESTRATOR_PORT}`,
    hostUrl,
    dashboardUrl: hostUrl,
    healthy
  };
}
