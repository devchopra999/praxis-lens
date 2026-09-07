# Praxis Lens — Execution Infrastructure

Controlled execution API that an AI debugging agent uses to create and manipulate isolated,
production-like debugging environments. The agent expresses intent (which services, which
snapshot, which repo/commit); this service handles Docker, networking, dependencies, health
checks, configuration, snapshots, and lifecycle. **The agent never touches Docker, shell, git, or
the host filesystem directly — everything goes through this HTTP API.**

Node.js + Express (ES modules, no TypeScript) + `dockerode` / `docker compose` CLI + SQLite
(`node:sqlite`) + Zod + Pino.

## Requirements

- Node.js 20+
- Docker Engine + Docker Compose v2 (`docker compose version`) running locally
- `git` on the host (only this service shells out to it, never the AI agent)

## Install & run

```bash
npm install
# create a .env file with the keys below (there's no committed .env.example - .env is gitignored)
npm run dev         # nodemon, reads .env
# or
npm start
```

Key `.env` variables: `PORT`, `MOB_IMAGE`/`EDI_IMAGE`/`MOCK_SERVER_IMAGE` (real-image overrides),
`MYSQL_ROOT_PASSWORD`, `PRAXIS_DATA_DIR`/`PRAXIS_WORKSPACES_DIR`, and the Aider settings
(`AIDER_MODEL`, `AIDER_TIMEOUT_MS`, plus whichever provider key it needs - `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` for Bedrock, etc.).

The server listens on `PORT` (default `3000`). SQLite data goes to `PRAXIS_DATA_DIR`
(default `./data`), per-environment workspaces to `PRAXIS_WORKSPACES_DIR` (default `./workspaces`).

### Running the service itself in Docker

```bash
docker compose up --build
```

This mounts `/var/run/docker.sock` into the container — `praxis-execution` is the **only**
component ever allowed to talk to the Docker Engine API, per the security model below.

## Service catalog

Only services listed in [src/config/service-catalog.js](src/config/service-catalog.js) can be
started — the agent can never supply an arbitrary Docker image.

| service         | role                | dependencies   | own database (default) | image (default)                        |
|-----------------|---------------------|----------------|-------------------------|-----------------------------------------|
| `mob`           | application         | —              | `mysql-mob`             | `alpine:3.19` stand-in (override via `MOB_IMAGE`) |
| `edi`           | application         | —              | `mysql-edi`             | `alpine:3.19` stand-in (override via `EDI_IMAGE`) |
| `mock-server`   | application         | —              | —                       | `alpine:3.19` stand-in (override via `MOCK_SERVER_IMAGE`) |
| `auth`          | fintech demo       | —              | `mysql-auth`            | `alpine:3.19` stand-in (override via `AUTH_IMAGE`) |
| `ledger`        | fintech demo       | —              | `mysql-ledger`          | `alpine:3.19` stand-in (override via `LEDGER_IMAGE`) |
| `payments`      | fintech demo       | —              | `mysql-payments`        | `alpine:3.19` stand-in (override via `PAYMENTS_IMAGE`) |
| `notifications` | fintech demo       | —              | `mysql-notifications`   | `alpine:3.19` stand-in (override via `NOTIFICATIONS_IMAGE`) |
| `mysql`         | dependency-only (never directly requestable) | —  | —           | `mysql:8`                               |
| `mongodb`       | dependency-only (never directly requestable) | —  | —           | `mongo:8`                               |
| `redis`         | dependency-only (never directly requestable) | —  | —           | `redis:7`                               |

`auth`/`ledger`/`payments`/`notifications` are the "fintech" demo microservices, each with its own
upstream repo under `devchopra999/fintech-*` (each ships its own Dockerfile, no `build:` fallback
needed unlike `mob`/`mock-server`). All 4 read a single `DATABASE_URL` pointing at their dedicated
`mysql-<name>` database; there is no gateway/proxy in front of them - they call each other directly
by container hostname (e.g. `payments` calls `ledger` at `http://ledger:4002`), and `auth`/
`ledger`/`payments` all verify JWTs against the same `JWT_SECRET`.

`mysql`/`mongodb`/`redis` only ever exist as `<engine>-<name>` instances provisioned on behalf of
another service — via that service's `database` catalog field or the `databases` request array
below — never as a standalone service you can name directly in `services` or `/services/:service/start`.

An `orchestrator` service (built from the [Praxis Lens orchestrator](https://github.com/devchopra999/orchestrator)
repo) is also started in **every** environment automatically — it's not in this table because it's
not user-selectable; see "Orchestrator" below.

`mob`/`edi`/`mock-server` default to a plain `alpine:3.19` container looping a busybox `nc`
listener that answers every request with `200 OK` — this makes the whole system runnable without
any private company images. Set `MOB_IMAGE`/`EDI_IMAGE`/`MOCK_SERVER_IMAGE` to point at real
images once available (real images must bring their own entrypoint/health endpoint; the stand-in
`command:` override in `compose/docker-compose.template.yml` only applies to the alpine default).
Each also gets `ORCHESTRATOR_URL`/`SERVICE_NAME` env vars so it can call other services through the
orchestrator instead of directly.

Requesting `mob`/`edi` no longer implies any shared dependency — the orchestrator is started for
every environment regardless, before any other service.

### Every service gets its own database by default

Any catalog service that declares a `database` engine (`mob`, `edi`) gets its own dedicated,
service-named database container automatically — `mob` gets `mysql-mob`, `edi` gets `mysql-edi` —
instead of sharing a single `mysql`/`mongodb` instance with every other service. This happens with
no extra request fields, whether the service is started as part of `POST /environments` or added
later via `POST /environments/:id/services/:service/start`.

Each dedicated database auto-restores a snapshot with the **same name as the service** if one
exists on disk (e.g. `snapshots/mysql/edi.sql.gz` restores automatically into `mysql-edi`) — see
[src/services/database-manager.js](src/services/database-manager.js)'s `snapshotExists`. If no
same-named snapshot exists, the database just starts empty. This is separate from — and does not
replace — the explicit `databases` array below, which still works exactly as before.

## Environment isolation model

Every `POST /environments` call creates:

- a unique `environmentId` (`env-xxxxxx`)
- a unique Docker Compose project (`praxis-env-xxxxxx`) — **every** compose command for that
  environment uses this same `-p` flag, so services added later join the same network instead of
  creating a new stack
- a unique workspace directory (`PRAXIS_WORKSPACES_DIR/env-xxxxxx`) holding the checked-out
  repository, a generated `docker-compose.override.yml` (dev-mode bind mounts, per-service config
  env files), and per-service config
- isolated containers, network, databases, and its own orchestrator — never connects to any real
  staging/production system
- an always-on `toolbox` container (Python 3 + common CLI tools: git, curl, jq, vim, ping, dig,
  etc.) for debugging/scripting against the other services via the existing `/execute` endpoint —
  see "Toolbox container" below

## Toolbox container

Every environment gets a `toolbox` service automatically — a Python 3 + common-CLI-tools container
(git, curl, wget, jq, vim, net-tools, iproute2, ping, dig, ssh, etc. — see
[docker/toolbox/Dockerfile](docker/toolbox/Dockerfile)) with no server process of its own. It exists
purely so an agent can debug or script against the environment's other services. The `POST
/environments` response's `service_descriptions.toolbox` field describes it up front (available
immediately, before the create job finishes), and it's usable like any other service once running:

```bash
curl -s -X POST http://localhost:3000/environments/env-abc123/execute \
  -H 'Content-Type: application/json' \
  -d '{"service": "toolbox", "command": ["python3", "--version"]}'
```

From inside `toolbox` (or any container), `localhost`/`127.0.0.1` only ever resolves back to that
same container — reach other services by their compose **service name** as the hostname, on the
port they listen on *inside* their own container (services don't publish ports to the host). Both
`POST /environments` and `GET /environments/:id` include a `service_endpoints` map with the exact
`http://<service>:<port>` address for every service in the environment, so an agent never has to
guess:

```bash
curl -s -X POST http://localhost:3000/environments/env-abc123/execute \
  -H 'Content-Type: application/json' \
  -d '{"service": "toolbox", "command": ["curl", "-s", "http://ledger:4002/health"]}'
```

## Health checks (no host port publishing)

Readiness is checked by running the service's own check **inside** its container via `docker exec`
(HTTP via `wget`, MySQL via `mysqladmin ping`, MongoDB via `mongosh`, TCP via `nc`/bash `/dev/tcp`,
or the container's own Docker `HEALTHCHECK`). This avoids host port collisions when multiple
isolated environments run at the same time. The one exception is the orchestrator, whose port is
published to an OS-assigned free host port so an agent can reach its dashboard/API directly (see
"Orchestrator" below).

Default startup timeout is 5 minutes, polled every 2 seconds (`PRAXIS_STARTUP_TIMEOUT_MS` /
`PRAXIS_HEALTH_POLL_INTERVAL_MS`).

## Database snapshots

`snapshots/mysql/baseline.sql.gz` (plain gzipped SQL) and `snapshots/mongodb/baseline/*.json`
(one JSON array per collection, loaded via `mongoimport`) are the example fixtures. Snapshot names
are validated against files that actually exist on disk before use — see
[src/services/database-manager.js](src/services/database-manager.js). Add more `<name>.sql.gz` /
`<name>/*.json` files to support additional snapshots.

### Per-environment database instances

`POST /environments` accepts a `databases` array to provision any number of independent,
individually-tracked database containers — use this when different services under test each need
their own isolated database rather than sharing one:

```json
{ "services": ["edi"], "databases": [
  { "name": "orders", "engine": "mysql", "snapshot": "baseline" },
  { "name": "billing", "engine": "mysql", "snapshot": "baseline" },
  { "name": "catalog", "engine": "mongodb" }
] }
```

- `name` — required, lowercase letters/digits/hyphens only.
- `engine` — `"mysql"` (default) or `"mongodb"`.
- `snapshot` — optional; a fixture name looked up in `snapshots/mysql/*.sql.gz` or
  `snapshots/mongodb/<name>/*.json`. Omit it to start with an empty database.

Each entry becomes its own `<engine>-<name>` container (e.g. `mysql-orders`) declared in that
environment's compose override — see `provisionDatabases` in [src/jobs/worker.js](src/jobs/worker.js).
The count is whatever the caller sends (3, 5, or any number), not a fixed catalog size, and it's
additive to `services` — you can use both in the same request.

Query data directly with `POST /environments/:id/services/:service/query` (see below), targeting
the specific instance by name, or fall back to `/execute` for anything the query endpoint doesn't
cover:

```bash
# rows in the dedicated "orders" instance only
curl -s -X POST http://localhost:3000/environments/env-abc123/services/mysql-orders/query \
  -H 'Content-Type: application/json' \
  -d '{"query":"SELECT * FROM users"}'

# and independently for "billing" — separate container, separate data, separate metrics
curl -s "http://localhost:3000/environments/env-abc123/services/mysql-billing/metrics"
```

`GET /environments/:id/services/:service/logs`, `/query`, `/execute`, and `/metrics` all resolve
containers by compose service name (not the static catalog), so every provisioned instance —
catalog-based or dynamic — is queryable and metered independently out of the box.

## Querying a service's database

`POST /environments/:id/services/:service/query` runs an ad-hoc read/write query against any
provisioned database instance — e.g. a service's dedicated `mysql-edi`, or a `databases`-array
instance like `mysql-orders`/`mongodb-catalog`. There's no host port published for either engine
(see "Health checks" above), so the query runs via `docker exec` using the engine's own CLI, never
a direct host TCP connection:

```bash
# mysql: query is raw SQL, executed with `mysql -e`
curl -s -X POST http://localhost:3000/environments/env-abc123/services/mysql-edi/query \
  -H 'Content-Type: application/json' \
  -d '{"query":"SELECT id, email FROM users LIMIT 10"}'
# => {"service":"mysql-edi","engine":"mysql","columns":["id","email"],"rows":[{"id":"1","email":"a@b.com"}]}

# mongodb: query is a JS expression evaluated against `db`, executed with `mongosh --eval`
curl -s -X POST http://localhost:3000/environments/env-abc123/services/mongodb-catalog/query \
  -H 'Content-Type: application/json' \
  -d '{"query":"db.incidents.find({}).toArray()"}'
# => {"service":"mongodb-catalog","engine":"mongodb","result":[{"_id":"...","title":"..."}]}
```

The query string is always passed as a single argv element straight to the database's own CLI
(never through a shell), so it can't smuggle in shell syntax — same trust model as `/execute`.
Targeting a service that isn't a mysql/mongodb instance returns `UNSUPPORTED_DATABASE_ENGINE`; see
[src/services/database-query-manager.js](src/services/database-query-manager.js).

## Orchestrator

Every environment always starts an `orchestrator` service (built once from
[devchopra999/orchestrator](https://github.com/devchopra999/orchestrator) and cached as
`praxis-orchestrator:latest` for every later environment) before anything else. Its `routes.json`
is seeded from the committed [orchestrator/routes.default.json](orchestrator/routes.default.json)
and mounted as its data volume, so registered routes survive that one container's own restarts.
Once the app services in an environment are healthy, every HTTP-catalogued one (`mob`/`edi`/
`mock-server`) is auto-registered with `POST /api/routes/bulk` as a wildcard `from: "*"` route
pointing at its docker-network address (e.g. `http://edi:8081`) — the same happens again whenever
a service is (re)started later.

Routes are keyed by the **(sourceService, destinationService)** caller/destination pair, not just
the destination: an exact `(sourceService, destinationService)` route always wins, falling back to
the wildcard `(*, destinationService)` route when no caller-specific override exists. This means
redirecting one caller's traffic never affects any other caller of the same destination.

Its port is published to an OS-assigned free host port (like Vault used to be) so an agent can
reach its dashboard/API directly; `GET /environments/:id/orchestrator` reports that URL. An agent
can then carve out a caller-specific redirect at runtime via the routes API below — e.g.
swapping `edi`'s `axis-api` dependency for a mock server mid-experiment, leaving every other
caller of `axis-api` untouched — without restarting anything. A route's `pointsTo` is always a
catalog service name (e.g. `mock-server`), never a raw URL, in both requests and responses — the
wrapper resolves it to the actual docker-network address and always translates it back to the
friendly name before responding, so callers never see or construct a raw URL themselves.

### Zero-code integration via the header injector

Routing through the orchestrator normally means a service's code has to send its request to
`$ORCHESTRATOR_URL` with an `x-to-service` header — fine for services you can rebuild, but many
services instead have a real hostname hardcoded in their own `.env` (e.g.
`AXIS_URL=https://edi-qa.company.com`) that you'd rather not touch. For that case every
environment also gets a hidden `header-injector` (`nginx:alpine`) sidecar: register a
hostname -> logical route name mapping via the aliases API below, and Docker's own embedded DNS
is pointed at the injector for that hostname (a compose network alias) instead of the real host.
The injector just stamps `x-to-service` and hands the request to the orchestrator — the calling
service keeps hitting the exact same URL it always did, no code or rebuild required.

Caveat: the injector only speaks plain HTTP (port 80). If the hardcoded value uses `https://`,
flip its scheme to `http://` first (e.g. via `PUT .../services/:service/env`) — the injector
doesn't provision TLS certificates for arbitrary hostnames.

`x-from-service` is attributed by the caller's **source IP**, not a fixed value: the injector
maintains an nginx `map $remote_addr $from_service {...}` built from every currently-running
service's actual container IP (unrecognized IPs fall back to the literal `"header-injector"`), so
per-caller route precision still works for traffic funneled through it. That map is refreshed
whenever a container is **recreated** (new image/volume/env - never on a plain restart, which
keeps the same container/IP) via `headerInjectorManager.refreshCallerMap()`, hot-reloading nginx
in place with no downtime.

## API

All bodies are JSON, all long-running operations return a `jobId` immediately (poll `GET /jobs/:id`).

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/environments` | `{ services: string[], databases?: [{ name, engine?, snapshot? }], repository?: { url, commit } }` | 202, `{ environmentId, jobId, status: "starting", service_descriptions: { toolbox: "..." }, service_endpoints: { <service>: "http://<service>:<port>", ... } }` |
| GET | `/environments/:id` | — | current status + per-service status + `service_endpoints` |
| GET | `/environments/:id/service-endpoints` | — | `{ environmentId, service_endpoints: { <service>: "http://<service>:<port>", ... } }` only, no other environment state |
| DELETE | `/environments/:id` | — | idempotent, `docker compose down -v` + workspace cleanup |
| GET | `/jobs/:jobId` | — | `{ status, progress: string[], error? }` |
| POST | `/environments/:id/services/:service/start` | `{ branch? }` | resolves deps, joins existing network; `branch` defaults to `main` when the service has a repository configured |
| POST | `/environments/:id/services/:service/stop` | — | |
| POST | `/environments/:id/services/:service/restart` | — | never recreates the environment |
| GET | `/environments/:id/services/:service/logs?tail=&since=` | — | |
| GET | `/environments/:id/services/:service/env` | — | `{ service, env }`, full contents of that service's env file |
| PUT | `/environments/:id/services/:service/env` | `{ env: { KEY: value, ... } }` | merges given keys into the env file; response includes "please restart the service for changes to reflect" |
| POST | `/environments/:id/services/:service/config` | `{ key, value }` | per-env config env file, takes effect on next restart |
| GET | `/environments/:id/orchestrator` | — | `{ hostUrl, dashboardUrl, internalUrl, healthy }` for this environment's orchestrator |
| GET | `/environments/:id/orchestrator/routes` | — | every route currently registered |
| GET | `/environments/:id/orchestrator/routes/:sourceService/:destinationService` | — | `{ sourceService, destinationService, pointsTo, updatedAt }`, exact match only (no wildcard fallback), 404 if unregistered. Use `*` as `:sourceService` to look up the wildcard route |
| PUT | `/environments/:id/orchestrator/routes/:sourceService/:destinationService` | `{ pointsTo }` | create/update one route, `pointsTo` is a catalog service name (never a raw URL); effective on the very next proxied request. Use `*` as `:sourceService` to set the wildcard (any-caller) route |
| POST | `/environments/:id/orchestrator/routes/bulk` | `{ routes: [{ sourceService, destinationService, pointsTo }, ...] }` | register/update many routes in one call, each `pointsTo` a catalog service name |
| DELETE | `/environments/:id/orchestrator/routes/:sourceService/:destinationService` | — | remove a route |
| GET | `/environments/:id/orchestrator/aliases` | — | `{ aliases: { hostname: logicalName, ... } }` currently registered with the header injector |
| PUT | `/environments/:id/orchestrator/aliases` | `{ aliases: { hostname: logicalName, ... } }` | merges given hostnames, (re)creates the header-injector sidecar so each hostname resolves to it |
| DELETE | `/environments/:id/orchestrator/aliases/:host` | — | stop intercepting one hostname |
| POST | `/environments/:id/services/:service/query` | `{ query }` | SQL (mysql) or a JS expression against `db` (mongodb); works for any provisioned per-environment database instance |
| POST | `/environments/:id/execute` | `{ service, command: string[], timeout? }` | `command` must be an argv array, never a shell string |
| POST | `/environments/:id/repository` | `{ url, commit }` | https only, exact commit checkout |
| GET | `/environments/:id/services/:service/metrics?duration=&interval=` | — | CPU/memory time series for one service |
| GET | `/environments/:id/metrics?services=&duration=&interval=` | — | CPU/memory time series for multiple services in one call, for direct comparison |
| POST | `/environments/:id/services/:service/code/ask` | `{ prompt, timeoutMs? }` | read-only aider Q&A against the service's checked-out repo, never changes files |
| POST | `/environments/:id/services/:service/code/edit` | `{ prompt, timeoutMs? }` | lets aider edit the repo, returns a diff; caller decides whether to rebuild/restart |
| POST | `/environments/:id/services/:service/request` | `{ endpoint, method?, headers?, body?, timeout? }` | proxies one HTTP request to `service` through the toolbox container; `endpoint` is a path (e.g. `/users/1`), never a full URL. Returns `{ targetUrl, method, statusCode, headers, body, durationMs }` synchronously |
| POST | `/environments/:id/services/:service/load-test` | `{ endpoint, method?, headers?, body?, hitCount, timeout? }` | fires `hitCount` concurrent requests at `service` through the toolbox container; async job, poll `GET /jobs/:id` for the aggregate summary |

Errors follow `{ "error": { "code": "...", "message": "...", ...details } }` — see
[src/utils/errors.js](src/utils/errors.js) for the full code list (`INVALID_SERVICE`,
`ENVIRONMENT_NOT_FOUND`, `SERVICE_NOT_FOUND`, `JOB_NOT_FOUND`, `SERVICE_START_FAILED`,
`SERVICE_START_TIMEOUT`, `HEALTH_CHECK_FAILED`, `DATABASE_RESTORE_FAILED`,
`ORCHESTRATOR_UNAVAILABLE`, `ORCHESTRATOR_ROUTE_NOT_FOUND`, `COMMAND_TIMEOUT`, `COMMAND_FAILED`,
`REPOSITORY_CLONE_FAILED`, `REPOSITORY_NOT_CONFIGURED`, `IMAGE_BUILD_FAILED`, `VALIDATION_ERROR`,
`UNSUPPORTED_DATABASE_ENGINE`, `DATABASE_QUERY_FAILED`, `SERVICE_REPO_NOT_FOUND`, `AIDER_FAILED`,
`AIDER_TIMEOUT`, each mapped to an HTTP status).

## Endpoint reference (curl + sample responses)

Every request/response pair below is a real example against `http://localhost:3000` with
`environmentId=env-abc123`, `jobId=job-xyz789`. Long-running operations (environment/service
create/start/stop/restart, repository attach) return a `jobId` immediately — poll `GET /jobs/:jobId`
until `status` is `"ready"`, `"failed"`, or `"timeout"`.

### Create an environment

```bash
curl -s -X POST http://localhost:3000/environments \
  -H 'Content-Type: application/json' \
  -d '{"services": ["mob","edi","mock-server"]}'
```

```json
{ "environmentId": "env-abc123", "jobId": "job-xyz789", "status": "starting" }
```

`databases` (independent, per-request-sized set of dedicated instances) and `repository`
(clone+checkout as part of creation) are both optional additions to the same body — see
"Per-environment database instances" above.

### Poll a job

```bash
curl -s http://localhost:3000/jobs/job-xyz789
```

```json
{
  "jobId": "job-xyz789",
  "environmentId": "env-abc123",
  "type": "create_environment",
  "status": "ready",
  "progress": ["workspace created", "orchestrator healthy", "mob healthy", "edi healthy", "mock-server healthy", "registered mob, edi, mock-server with orchestrator"],
  "createdAt": "2026-09-05T10:00:00.000Z",
  "startedAt": "2026-09-05T10:00:00.100Z",
  "completedAt": "2026-09-05T10:00:42.500Z"
}
```

On failure/timeout, `status` is `"failed"`/`"timeout"` and an `error` field with the failure
message is included instead of `completedAt` semantics changing.

### Get environment status

```bash
curl -s http://localhost:3000/environments/env-abc123
```

```json
{
  "environmentId": "env-abc123",
  "status": "running",
  "composeProject": "praxis-env-abc123",
  "workspace": "/app/workspaces/env-abc123",
  "services": [
    { "service_name": "orchestrator", "status": "running", "container_id": "a1b2c3d4e5f6", "updated_at": "2026-09-05T10:00:10.000Z" },
    { "service_name": "mysql-edi", "status": "running", "container_id": "b2c3d4e5f6a1", "updated_at": "2026-09-05T10:00:20.000Z" },
    { "service_name": "edi", "status": "running", "container_id": "c3d4e5f6a1b2", "updated_at": "2026-09-05T10:00:30.000Z" }
  ],
  "createdAt": "2026-09-05T10:00:00.000Z",
  "updatedAt": "2026-09-05T10:00:42.500Z"
}
```

### Delete an environment

```bash
curl -s -X DELETE http://localhost:3000/environments/env-abc123
```

```json
{ "environmentId": "env-abc123", "status": "destroyed" }
```

Idempotent — safe to call again on an already-destroyed environment.

### Attach/checkout a repository

```bash
curl -s -X POST http://localhost:3000/environments/env-abc123/repository \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/spring-projects/spring-petclinic.git","commit":"main"}'
```

```json
{ "jobId": "job-repo001", "status": "queued" }
```

https URLs only (`assertSafeUrl` rejects `git@...` SSH form) — poll `GET /jobs/:jobId` for
clone/checkout progress and any already-running services being recreated to pick up the mount.

### Start / stop / restart a service

```bash
# start (optionally from a specific branch, building the repo instead of the alpine stand-in)
curl -s -X POST http://localhost:3000/environments/env-abc123/services/mob/start \
  -H 'Content-Type: application/json' \
  -d '{"branch":"feature/my-fix"}'
# => {"jobId":"job-start001","status":"queued"}

curl -s -X POST http://localhost:3000/environments/env-abc123/services/mob/stop
# => {"jobId":"job-stop001","status":"queued"}

curl -s -X POST http://localhost:3000/environments/env-abc123/services/mob/restart
# => {"jobId":"job-restart001","status":"queued"}
```

All three return `{ "jobId": "...", "status": "queued" }`; poll `GET /jobs/:jobId` for progress.
`start` with no `branch` defaults to `main` for any service with a repository configured (building
it from source, same as an explicit `branch`); only repo-less services (`mysql`/`mongodb`/`redis`)
fall back to the catalog default image. `stop`/`restart` never recreate the rest of the environment.

### Fetch logs

```bash
curl -s "http://localhost:3000/environments/env-abc123/services/edi/logs?tail=200"
```

```json
{ "service": "edi", "logs": "2026-09-05T10:00:31Z listening on :8080\n2026-09-05T10:00:32Z GET /health 200\n" }
```

### Get/update a service's .env file

```bash
curl -s http://localhost:3000/environments/env-abc123/services/edi/env
```

```json
{ "service": "edi", "env": { "LOG_LEVEL": "debug" } }
```

```bash
curl -s -X PUT http://localhost:3000/environments/env-abc123/services/edi/env \
  -H 'Content-Type: application/json' \
  -d '{"env":{"AXIS_URL":"http://mock-server:3000"}}'
```

```json
{
  "service": "edi",
  "env": { "LOG_LEVEL": "debug", "AXIS_URL": "http://mock-server:3000" },
  "message": "please restart the service for changes to reflect"
}
```

`PUT` merges the given keys into the existing file (other keys are left untouched); it never
takes effect until the service is restarted.

### Redirect a service's traffic through the orchestrator

```bash
curl -s http://localhost:3000/environments/env-abc123/orchestrator
# => {"service":"orchestrator","internalUrl":"http://orchestrator:8000","hostUrl":"http://127.0.0.1:54321","dashboardUrl":"http://127.0.0.1:54321","healthy":true}

curl -s http://localhost:3000/environments/env-abc123/orchestrator/routes/*/edi
# => {"sourceService":"*","destinationService":"edi","pointsTo":"edi","updatedAt":"2026-09-05T10:00:31.000Z"}

# redirect ONLY mob's calls to edi, no restart needed - mock-server (or anyone else calling edi)
# keeps hitting the real edi via the untouched wildcard route
curl -s -X PUT http://localhost:3000/environments/env-abc123/orchestrator/routes/mob/edi \
  -H 'Content-Type: application/json' \
  -d '{"pointsTo":"mock-server"}'
```

### Zero-code redirect via the header injector

```bash
# edi's own .env has AXIS_URL=http://edi-qa.company.com (already flipped to http, see caveat above) -
# register that hostname against a logical route name, no changes to edi at all
curl -s -X PUT http://localhost:3000/environments/env-abc123/orchestrator/aliases \
  -H 'Content-Type: application/json' \
  -d '{"aliases":{"edi-qa.company.com":"axis-api"}}'
# => {"aliases":{"edi-qa.company.com":"axis-api"},"message":"services will resolve these hostnames ..."}

# point the logical name at the mock server - since the injector attributes the real caller by
# source IP now, this only affects edi's traffic, not any other aliased/direct caller of axis-api
curl -s -X PUT http://localhost:3000/environments/env-abc123/orchestrator/routes/edi/axis-api \
  -H 'Content-Type: application/json' \
  -d '{"pointsTo":"mock-server"}'

# stop intercepting the hostname
curl -s -X DELETE http://localhost:3000/environments/env-abc123/orchestrator/aliases/edi-qa.company.com
```

### Set per-environment config

```bash
curl -s -X POST http://localhost:3000/environments/env-abc123/services/edi/config \
  -H 'Content-Type: application/json' \
  -d '{"key":"LOG_LEVEL","value":"debug"}'
```

```json
{ "service": "edi", "config": { "LOG_LEVEL": "debug" } }
```

`config` is the full set of key/value pairs currently in that service's env file; takes effect on
the next restart of that service.

### Query a service's database

```bash
curl -s -X POST http://localhost:3000/environments/env-abc123/services/mysql-edi/query \
  -H 'Content-Type: application/json' \
  -d '{"query":"SELECT id, email FROM users LIMIT 5"}'
```

```json
{
  "service": "mysql-edi",
  "engine": "mysql",
  "columns": ["id", "email"],
  "rows": [{ "id": "1", "email": "a@b.com" }, { "id": "2", "email": "c@d.com" }]
}
```

```bash
curl -s -X POST http://localhost:3000/environments/env-abc123/services/mongodb-catalog/query \
  -H 'Content-Type: application/json' \
  -d '{"query":"db.incidents.find({}).toArray()"}'
```

```json
{ "service": "mongodb-catalog", "engine": "mongodb", "result": [{ "_id": "650f...", "title": "payment gateway timeout" }] }
```

### Execute an arbitrary command in a container

```bash
curl -s -X POST http://localhost:3000/environments/env-abc123/execute \
  -H 'Content-Type: application/json' \
  -d '{"service":"edi","command":["echo","reproduce"],"timeout":60}'
```

```json
{ "exitCode": 0, "stdout": "reproduce\n", "stderr": "" }
```

`command` must be a JSON array of argv tokens, never a single shell string — this is what
prevents shell-injection from an untrusted prompt/agent.

### Ask aider about a service's code (read-only)

```bash
curl -s -X POST http://localhost:3000/environments/env-abc123/services/edi/code/ask \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Where does this service read the Axis base URL from?"}'
```

```json
{
  "environmentId": "env-abc123",
  "service": "edi",
  "mode": "ask",
  "exitCode": 0,
  "stdout": "It reads AXIS_URL from src/config.js, which falls back to its .env file at config/edi.env.\n",
  "stderr": ""
}
```

Never modifies the repository — safe to call at any time. Requires the service to already have a
repo checked out (started via `start` with a `branch`, or via `POST /environments/:id/repository`),
otherwise returns `SERVICE_REPO_NOT_FOUND` (404).

### Let aider edit a service's code

```bash
curl -s -X POST http://localhost:3000/environments/env-abc123/services/edi/code/edit \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Add a null check before calling axisClient.fetch()"}'
```

```json
{
  "environmentId": "env-abc123",
  "service": "edi",
  "mode": "edit",
  "exitCode": 0,
  "stdout": "Applied edits to src/axisClient.js\n",
  "stderr": "",
  "diff": "diff --git a/src/axisClient.js b/src/axisClient.js\n@@ -10,6 +10,9 @@\n+  if (!config) return null;\n",
  "changedFiles": ["src/axisClient.js"]
}
```

Only touches the working tree (no commit is made) — the caller decides whether/how to rebuild and
restart the service afterward (e.g. `POST .../start` with the same branch, or `/execute` to run
tests first). `timeoutMs` (both endpoints, max 30 minutes) overrides the default 5-minute aider
timeout.

## Metrics (docker stats)

`GET /environments/:id/services/:service/metrics` and `GET /environments/:id/metrics` sample
`docker stats` for one or more containers, optionally repeated over a time window, so an agent can
see resource trends instead of a single point-in-time number:

```bash
# one shot, current CPU/memory for edi
curl -s "http://localhost:3000/environments/env-abc123/services/edi/metrics"

# a 20s profile sampled every 5s, for edi AND mysql in one response (defaults to every
# currently-running service if `services` is omitted)
curl -s "http://localhost:3000/environments/env-abc123/metrics?services=edi,mysql&duration=20&interval=5"
```

The second call returns one time-aligned series per service:

```json
{
  "services": {
    "edi":   [ { "elapsedSec": 0, "cpuPercent": 12, "memoryUsageBytes": 230686720, "memoryPercent": 2.8 }, "..." ],
    "mysql": [ { "elapsedSec": 0, "cpuPercent": 8,  "memoryUsageBytes": 410000000, "memoryPercent": 5.0 }, "..." ]
  }
}
```

which is exactly the shape needed for an agent to reason about a bottleneck in one pass, e.g.
"EDI's CPU climbed from 12% to 98% while MySQL stayed under 40% — EDI is the bottleneck, not the
database." `duration`/`interval` are capped (max 120s / min 1s) so a single request can't block or
hammer the docker daemon indefinitely; omit `duration` for an instant single-sample read.

## End-to-end curl walkthrough

```bash
# 1. create an environment
curl -s -X POST http://localhost:3000/environments \
  -H 'Content-Type: application/json' \
  -d '{"services": ["mob","edi","mock-server"]}'
# => {"environmentId":"env-abc123","jobId":"job-xyz789","status":"starting"}

# 2. poll until ready
curl -s http://localhost:3000/jobs/job-xyz789

# 3. point edi's axis-api calls at the mock server instead of the fake Axis staging URL - only
# edi is affected, any other caller of axis-api keeps hitting its current target
curl -s -X PUT http://localhost:3000/environments/env-abc123/orchestrator/routes/edi/axis-api \
  -H 'Content-Type: application/json' \
  -d '{"pointsTo":"mock-server"}'

# 4. restart edi to pick up the new secret
curl -s -X POST http://localhost:3000/environments/env-abc123/services/edi/restart

# 5. reproduce the issue inside the container
curl -s -X POST http://localhost:3000/environments/env-abc123/execute \
  -H 'Content-Type: application/json' \
  -d '{"service":"edi","command":["echo","reproduce"],"timeout":60}'

# 6. inspect logs
curl -s "http://localhost:3000/environments/env-abc123/services/edi/logs?tail=200"

# 6b. query edi's database directly instead of hand-crafting a mysql exec command
curl -s -X POST http://localhost:3000/environments/env-abc123/services/mysql-edi/query \
  -H 'Content-Type: application/json' \
  -d '{"query":"SELECT * FROM users LIMIT 5"}'

# 6c. ask aider to explain the relevant code, then let it apply a fix
curl -s -X POST http://localhost:3000/environments/env-abc123/services/edi/code/ask \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Why does calling the Axis client throw when config is missing?"}'

curl -s -X POST http://localhost:3000/environments/env-abc123/services/edi/code/edit \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Add a null check before calling axisClient.fetch()"}'
# => rebuild/restart to pick up the diff, e.g.:
curl -s -X POST http://localhost:3000/environments/env-abc123/services/edi/start \
  -H 'Content-Type: application/json' -d '{"branch":"main"}'

# 7. discover another service is needed and add it to the SAME environment (redis/mongodb/mysql
# are dependency-only and can't be started directly - start a catalogued service instead)
curl -s -X POST http://localhost:3000/environments/env-abc123/services/mock-server/start

# 8. (optional) create a second environment with its own dedicated per-service databases instead
# of the single shared mysql/mongodb, so each can be metered independently
curl -s -X POST http://localhost:3000/environments \
  -H 'Content-Type: application/json' \
  -d '{"services": ["edi"], "databases": [{"name":"orders","snapshot":"baseline"},{"name":"billing","snapshot":"baseline"}]}'

# 9. tear everything down
curl -s -X DELETE http://localhost:3000/environments/env-abc123
```

## Tests

```bash
npm test               # unit tests, no Docker required
npm run test:integration  # full lifecycle against real local Docker (slower, pulls images on first run)
```

## Troubleshooting

- **Job stuck at "workspace created" for a long time**: usually a first-time image pull
  (`mysql:8`/`mongo:8` are large) or the first-ever orchestrator image build (clones + `docker
  build`s `praxis-orchestrator:latest`, cached for every later environment). Check `docker images`
  and `docker compose -p <project> ps -a`; the job will keep polling health up to the 5-minute
  timeout.
- **`SERVICE_START_TIMEOUT` with empty-looking logs**: `docker exec <container> sh` to check the
  container manually — alpine's default busybox has no `httpd` applet and no `curl`, only `wget`
  and `nc`.
- **Overriding `MOB_IMAGE`/`EDI_IMAGE`/`MOCK_SERVER_IMAGE`**: the compose template's stand-in
  `command:` (a `busybox nc` loop) only makes sense for the alpine default — real images must
  supply their own entrypoint and expose their catalogued health check port/path.
- **Route not found for a service that should be registered**: registration only happens after
  that service reports healthy; poll `GET /jobs/:jobId` until `ready` before calling
  `GET /environments/:id/orchestrator/routes/*/:service` (auto-registration writes the wildcard
  `sourceService` route, not an exact-caller one).
