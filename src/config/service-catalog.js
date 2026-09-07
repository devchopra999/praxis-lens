// Only services listed here may be started; the AI agent can never supply an arbitrary image.
//
// mob/edi/mock-server default to a plain alpine + busybox-httpd stand-in (serves a static
// "/health" file) so the catalog is runnable without private company images. Override with
// MOB_IMAGE / EDI_IMAGE / MOCK_SERVER_IMAGE to point at real images (note: real images must
// provide their own entrypoint, the compose template's stand-in `command` override only fits alpine).
export const SERVICE_CATALOG = {
  // `database` (not a shared `dependencies` entry) means this service gets its own dedicated,
  // service-named database instance by default (see worker.js provisionDefaultDatabase) instead
  // of sharing the catalog's single "mysql"/"mongodb" container.
  mob: {
    image: process.env.MOB_IMAGE || "alpine:3.19",
    port: 8080,
    dependencies: [],
    database: "mysql",
    healthcheck: { type: "http", path: "/actuator/health" },
    repository: { url: process.env.MOB_REPO_URL || "https://github.com/spring-projects/spring-petclinic.git" },
    // no Dockerfile upstream; repository-manager generates one from this when building from source
    build: { type: "maven" }
  },
  edi: {
    image: process.env.EDI_IMAGE || "alpine:3.19",
    port: 8081,
    dependencies: [],
    database: "mysql",
    healthcheck: { type: "http", path: "/health" },
    repository: { url: process.env.EDI_REPO_URL || "https://github.com/company/edi.git" }
  },
  "mock-server": {
    image: process.env.MOCK_SERVER_IMAGE || "alpine:3.19",
    port: 3000,
    dependencies: [],
    healthcheck: { type: "http", path: "/" },
    repository: { url: process.env.MOCK_SERVER_REPO_URL || "https://github.com/expressjs/express.git" },
    build: { type: "node", entry: "examples/hello-world/index.js" }
  },
  // fintech demo services (auth/ledger/payments/notifications) - each ships its own Dockerfile,
  // so no `build` fallback is needed. Services call each other directly by hostname; there is no
  // gateway/proxy in front of them.
  auth: {
    image: process.env.AUTH_IMAGE || "alpine:3.19",
    port: 4000,
    dependencies: [],
    database: "mysql",
    healthcheck: { type: "http", path: "/health" },
    repository: { url: process.env.AUTH_REPO_URL || "https://github.com/devchopra999/fintech-auth.git" }
  },
  ledger: {
    image: process.env.LEDGER_IMAGE || "alpine:3.19",
    port: 4002,
    dependencies: [],
    database: "mysql",
    healthcheck: { type: "http", path: "/health" },
    repository: { url: process.env.LEDGER_REPO_URL || "https://github.com/devchopra999/fintech-ledger.git" }
  },
  payments: {
    image: process.env.PAYMENTS_IMAGE || "alpine:3.19",
    port: 4003,
    dependencies: [],
    database: "mysql",
    healthcheck: { type: "http", path: "/health" },
    repository: { url: process.env.PAYMENTS_REPO_URL || "https://github.com/devchopra999/fintech-payments.git" }
  },
  notifications: {
    image: process.env.NOTIFICATIONS_IMAGE || "alpine:3.19",
    port: 4004,
    dependencies: [],
    database: "mysql",
    healthcheck: { type: "http", path: "/health" },
    repository: { url: process.env.NOTIFICATIONS_REPO_URL || "https://github.com/devchopra999/fintech-notifications.git" }
  },
  // dependencyOnly: never directly requestable/startable - only reachable via a service's
  // `database` field, the `databases` array, or a future `dependencies` entry naming it.
  mysql: {
    image: "mysql:8",
    port: 3306,
    dependencies: [],
    healthcheck: { type: "mysql" },
    dependencyOnly: true
  },
  mongodb: {
    image: "mongo:8",
    port: 27017,
    dependencies: [],
    healthcheck: { type: "mongodb" },
    dependencyOnly: true
  },
  redis: {
    image: "redis:7",
    port: 6379,
    dependencies: [],
    healthcheck: { type: "tcp" },
    dependencyOnly: true
  }
};

export function isCataloguedService(name) {
  const entry = SERVICE_CATALOG[name];
  return Boolean(entry) && !entry.dependencyOnly;
}

// Full list of service names that can be requested/started directly, surfaced in error responses
// so a caller that guessed wrong knows exactly what to retry with. Excludes dependencyOnly entries.
export function listServiceNames() {
  return Object.keys(SERVICE_CATALOG).filter((name) => !SERVICE_CATALOG[name].dependencyOnly);
}

// Names only ever reachable as a dependency (never directly requestable) - e.g. mysql/mongodb/redis.
export function listDependencyOnlyServiceNames() {
  return Object.keys(SERVICE_CATALOG).filter((name) => SERVICE_CATALOG[name].dependencyOnly);
}

export function getCatalogEntry(name) {
  return SERVICE_CATALOG[name];
}

// Internal docker-network address for a catalogued service. Containers in the same compose
// project reach each other by service name as the hostname (never "localhost"/127.0.0.1, which
// resolves to the calling container itself) and the port the service listens on INSIDE its own
// container (never a host-published port - most services don't publish one at all). Returns null
// for services with no catalog port.
export function getInternalUrl(name) {
  const entry = SERVICE_CATALOG[name];
  if (!entry?.port) return null;
  return `http://${name}:${entry.port}`;
}

// Service name -> repo url mapping, derived from the catalog, for callers that want the whole
// map at once (e.g. validating a per-service `branches` request) instead of one-off lookups.
export const SERVICE_REPOSITORIES = Object.fromEntries(
  Object.entries(SERVICE_CATALOG)
    .filter(([, entry]) => entry.repository?.url)
    .map(([name, entry]) => [name, entry.repository.url])
);

// Source repo mapping used to build a service from a branch (spec: start-on-branch flow); undefined if none configured.
export function getRepositoryUrl(name) {
  return SERVICE_REPOSITORIES[name];
}

// Returns requested services plus all transitive dependencies, deduped, dependency-first.
export function resolveDependencies(serviceNames) {
  const resolved = new Set();

  const visit = (name) => {
    if (resolved.has(name)) return;
    const entry = SERVICE_CATALOG[name];
    if (!entry) return;
    for (const dep of entry.dependencies || []) visit(dep);
    resolved.add(name);
  };

  serviceNames.forEach(visit);
  return [...resolved];
}
