// Lets a service reach the orchestrator with ZERO code changes: instead of editing every
// service's HTTP client to send `x-to-service`/`x-from-service` headers, an agent registers a
// hostname (whatever the service already has hardcoded in its own .env, e.g. "edi-qa.company.com")
// -> logical orchestrator route name. Docker's embedded DNS is then pointed at this container for
// that hostname (via a compose network alias), and this nginx sidecar tags the request with the
// right header and hands it to the orchestrator - the calling service never has to change.
//
// x-from-service is attributed by source IP ($remote_addr -> service name map), not hardcoded, so
// per-caller orchestrator routing still works for traffic funneled through here - see
// buildCallerMap/refreshCallerMap below. Unknown IPs fall back to the literal "header-injector".
//
// Caveat: this only intercepts plain HTTP (port 80). If a service's env value uses "https://",
// either flip its scheme to "http://" (via the .env update API) or the connection will fail here,
// since this sidecar doesn't provision TLS certificates for arbitrary hostnames.
import fs from "node:fs";
import path from "node:path";
import { workspacePath } from "./environment-manager.js";
import { addService } from "./compose-override.js";
import * as composeManager from "./compose-manager.js";
import { waitForHealthy } from "./health-manager.js";
import { findContainer, inspectContainer, execInContainer } from "../docker/docker-client.js";
import * as orchestratorManager from "./orchestrator-manager.js";
import db from "../db/sqlite.js";

const HEADER_INJECTOR_IMAGE = "nginx:alpine";
const HEADER_INJECTOR_SERVICE = "header-injector";

// Not a SERVICE_CATALOG entry (hidden/internal, like the orchestrator itself), so waitForHealthy
// needs this passed explicitly instead of resolving it from the catalog.
export const HEADER_INJECTOR_CATALOG_ENTRY = { port: 80, healthcheck: { type: "tcp" } };

// Fixed hostname->logical-name aliases for the fintech demo services' hardcoded direct-call
// hostnames (see compose/docker-compose.template.yml LEDGER_URL/NOTIFICATIONS_URL/PAYMENT_GATEWAY_URL),
// so payments/ledger route through the orchestrator instead of calling each other directly.
export const FINTECH_GATEWAY_ALIASES = {
  "ledger-gw.local": "ledger",
  "notifications-gw.local": "notifications",
  "api.nexpay.example.com": "payment-gateway"
};

// Any of these being (re)started means the alias set above needs to be (re)applied - the aliases
// are environment-wide, not per-caller, so it's safe/idempotent to register them every time.
const FINTECH_GATEWAY_SERVICES = new Set(["ledger", "payments", "notifications"]);

// Call alongside registerCatalogRoutes/refreshCallerMap after any of the fintech services starts,
// so their hardcoded direct-call hostnames resolve through the header injector -> orchestrator
// instead of hitting each other directly. No-ops if none of the started services are fintech ones.
export async function registerFintechGatewayRouting(environmentId, project, serviceNames) {
  if (!serviceNames.some((name) => FINTECH_GATEWAY_SERVICES.has(name))) return;
  await updateAliases(environmentId, project, FINTECH_GATEWAY_ALIASES);
  if (serviceNames.includes("payments")) {
    await orchestratorManager.putRoute(project, "payments", "payment-gateway", "payment-gateway");
  }
}

function injectorDir(environmentId) {
  return path.join(workspacePath(environmentId), "header-injector");
}

function aliasesFilePath(environmentId) {
  return path.join(injectorDir(environmentId), "aliases.json");
}

function nginxConfPath(environmentId) {
  return path.join(injectorDir(environmentId), "nginx.conf");
}

function readAliases(environmentId) {
  const file = aliasesFilePath(environmentId);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeAliases(environmentId, aliases) {
  fs.mkdirSync(injectorDir(environmentId), { recursive: true });
  fs.writeFileSync(aliasesFilePath(environmentId), JSON.stringify(aliases, null, 2));
}

// Which currently-running services (excluding the injector/orchestrator, neither of which is
// ever a real caller) could plausibly show up as $remote_addr on an aliased request.
function callerServiceNames(environmentId) {
  return db
    .prepare("SELECT service_name FROM services WHERE environment_id = ? AND status = 'running'")
    .all(environmentId)
    .map((row) => row.service_name)
    .filter((name) => name !== HEADER_INJECTOR_SERVICE && name !== "orchestrator");
}

// Container IPs are stable across a plain restart (same container) but not a recreation (new
// image/volume/env via `docker compose up`) - must be recomputed and pushed into nginx after
// every recreation, see refreshCallerMap. Single-network compose projects only (this template
// never defines extra networks), so the first entry in NetworkSettings.Networks is the right one.
async function buildCallerMap(project, environmentId) {
  const map = {};
  for (const name of callerServiceNames(environmentId)) {
    const container = await findContainer(project, name);
    if (!container) continue;
    const info = await inspectContainer(container.Id);
    const ip = Object.values(info.NetworkSettings?.Networks || {})[0]?.IPAddress;
    if (ip) map[ip] = name;
  }
  return map;
}

function generateCallerMapBlock(callerMap) {
  const entries = Object.entries(callerMap)
    .map(([ip, serviceName]) => `    ${ip} "${serviceName}";`)
    .join("\n");
  return `map $remote_addr $from_service {
    default "header-injector";
${entries}
  }`;
}

// One server block per registered hostname; each just stamps x-to-service and hands off to the
// orchestrator, preserving path/method/body untouched. Values are pre-validated against strict
// hostname/logical-name patterns (routes/orchestrator.js) before ever reaching this template, so
// they can't break out of the generated config.
function generateNginxConf(aliases, callerMap) {
  const blocks = Object.entries(aliases)
    .map(
      ([host, logicalName]) => `
  server {
    listen 80;
    server_name ${host};
    location / {
      set $upstream orchestrator:8000;
      proxy_set_header x-to-service "${logicalName}";
      proxy_set_header x-from-service $from_service;
      proxy_set_header Host $host;
      proxy_pass http://$upstream;
    }
  }`
    )
    .join("\n");

  return `worker_processes 1;
events { worker_connections 128; }
http {
  resolver 127.0.0.11 valid=10s;
  ${generateCallerMapBlock(callerMap)}

  server { listen 80 default_server; return 502; }
${blocks}
}
`;
}

function writeNginxConf(environmentId, aliases, callerMap) {
  fs.mkdirSync(injectorDir(environmentId), { recursive: true });
  fs.writeFileSync(nginxConfPath(environmentId), generateNginxConf(aliases, callerMap));
}

// Declares/updates the header-injector compose service, including the current alias list as
// Docker network aliases - this is what makes each hostname actually resolve to this container.
function declareHeaderInjectorService(environmentId, aliases) {
  addService(environmentId, HEADER_INJECTOR_SERVICE, {
    image: HEADER_INJECTOR_IMAGE,
    volumes: [`${nginxConfPath(environmentId)}:/etc/nginx/nginx.conf:ro`],
    networks: { default: { aliases: Object.keys(aliases) } }
  });
}

function nowIso() {
  return new Date().toISOString();
}

function upsertServiceRow(environmentId, status) {
  db.prepare(
    `INSERT INTO services (environment_id, service_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(environment_id, service_name) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`
  ).run(environmentId, HEADER_INJECTOR_SERVICE, status, nowIso(), nowIso());
}

// Recreates the container (network aliases can only be set when a container joins the network,
// so adding a NEW hostname always requires a brief recreate of this one container - nothing else
// in the environment is touched) and waits for it to be healthy again before returning.
async function apply(environmentId, project, aliases) {
  writeAliases(environmentId, aliases);
  const callerMap = await buildCallerMap(project, environmentId);
  writeNginxConf(environmentId, aliases, callerMap);
  declareHeaderInjectorService(environmentId, aliases);
  await composeManager.up(project, environmentId, [HEADER_INJECTOR_SERVICE]);
  await waitForHealthy(project, HEADER_INJECTOR_SERVICE, { catalogEntry: HEADER_INJECTOR_CATALOG_ENTRY });
  upsertServiceRow(environmentId, "running");
  return aliases;
}

// Call after any container recreation (new image/volume/env - never needed for a plain restart,
// which reuses the same container/IP) so aliased traffic keeps attributing to the right caller.
// No-ops if this environment has no aliases registered yet. Rewrites nginx.conf and hot-reloads
// nginx in place - no container recreate, since only the map content changed, not the network
// aliases nginx itself needs.
export async function refreshCallerMap(environmentId, project) {
  const aliases = readAliases(environmentId);
  if (Object.keys(aliases).length === 0) return;

  const container = await findContainer(project, HEADER_INJECTOR_SERVICE);
  if (!container) return;

  const callerMap = await buildCallerMap(project, environmentId);
  writeNginxConf(environmentId, aliases, callerMap);
  await execInContainer(container.Id, ["nginx", "-s", "reload"]);
}

export function getAliases(environmentId) {
  return readAliases(environmentId);
}

// Merge/patch semantics, same as config-manager's updateEnv - only the given hostnames are
// added/overwritten, everything already registered is left untouched.
export async function updateAliases(environmentId, project, patch) {
  const aliases = { ...readAliases(environmentId), ...patch };
  return apply(environmentId, project, aliases);
}

export async function removeAlias(environmentId, project, host) {
  const aliases = readAliases(environmentId);
  if (!(host in aliases)) return aliases;
  delete aliases[host];
  return apply(environmentId, project, aliases);
}
