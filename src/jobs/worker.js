import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENVIRONMENT_STATUS } from "../types/constants.js";
import * as composeManager from "../services/compose-manager.js";
import * as composeOverride from "../services/compose-override.js";
import { waitForHealthy } from "../services/health-manager.js";
import * as jobManager from "../services/job-manager.js";
import * as databaseManager from "../services/database-manager.js";
import * as orchestratorManager from "../services/orchestrator-manager.js";
import { ensureToolboxImage, TOOLBOX_SERVICE_NAME, TOOLBOX_CATALOG_ENTRY } from "../services/toolbox-manager.js";
import * as headerInjectorManager from "../services/header-injector-manager.js";
import * as repositoryManager from "../services/repository-manager.js";
import { getCatalogEntry, listDependencyOnlyServiceNames } from "../config/service-catalog.js";
import { composeProjectName, workspacePath, updateEnvironmentStatus } from "../services/environment-manager.js";
import { ErrorCodes } from "../utils/errors.js";
import db from "../db/sqlite.js";
import logger from "../utils/logger.js";

const SHARED_INFRA = new Set(listDependencyOnlyServiceNames());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_ROOT = path.resolve(__dirname, "../../snapshots");

// Compose block for a per-environment database instance, reusing the same image/healthcheck/fixtures
// as the shared catalog entry so any number of independent instances can be requested per environment.
function databaseServiceDefinition(engine) {
  if (engine === "mongodb") {
    return { image: "mongo:8", volumes: [`${path.join(SNAPSHOTS_ROOT, "mongodb")}:/snapshots:ro`] };
  }
  return {
    image: "mysql:8",
    environment: { MYSQL_ROOT_PASSWORD: process.env.MYSQL_ROOT_PASSWORD || "praxis", MYSQL_DATABASE: "app" },
    healthcheck: { test: ["CMD", "mysqladmin", "ping", "-h", "localhost"], interval: "5s", timeout: "3s", retries: 30 },
    volumes: [`${path.join(SNAPSHOTS_ROOT, "mysql")}:/snapshots:ro`]
  };
}

// Provisions however many named database instances were requested (independent of the fixed
// SHARED_INFRA list), each its own container so logs/metrics/execute can target it individually.
async function provisionDatabases(jobId, project, environmentId, databases) {
  const specs = databases.map((d) => ({ ...d, engine: d.engine || "mysql", serviceName: `${d.engine || "mysql"}-${d.name}` }));

  for (const spec of specs) {
    composeOverride.addService(environmentId, spec.serviceName, databaseServiceDefinition(spec.engine));
  }

  const serviceNames = specs.map((s) => s.serviceName);
  jobManager.appendProgress(jobId, `provisioning ${serviceNames.length} database instance(s): ${serviceNames.join(", ")}`);
  await composeManager.up(project, environmentId, serviceNames);

  for (const spec of specs) {
    jobManager.appendProgress(jobId, `waiting for ${spec.serviceName}`);
    await waitForHealthy(project, spec.serviceName, { catalogEntry: getCatalogEntry(spec.engine) });
    upsertServiceRow(environmentId, spec.serviceName, "running");
    jobManager.appendProgress(jobId, `${spec.serviceName} healthy`);

    if (spec.snapshot) {
      jobManager.appendProgress(jobId, `restoring ${spec.engine} snapshot into ${spec.serviceName}`);
      await databaseManager.restore(spec.engine, spec.snapshot, project, spec.serviceName);
      jobManager.appendProgress(jobId, `${spec.serviceName} snapshot restored`);
    }
  }
}

// Every catalog service that declares a `database` engine (mob/edi) gets its own dedicated,
// service-named instance ("<engine>-<serviceName>") by default, instead of sharing the catalog's
// single "mysql"/"mongodb" container. If a snapshot exists on disk with the same name as the
// service (e.g. snapshots/mysql/mob.sql.gz), it's restored automatically; otherwise it starts empty.
// Exported so service-manager.js can apply the same default when a service is (re)started later.
export async function provisionDefaultDatabase(jobId, project, environmentId, serviceName) {
  const engine = getCatalogEntry(serviceName)?.database;
  if (!engine) return;

  const dbServiceName = `${engine}-${serviceName}`;
  composeOverride.addService(environmentId, dbServiceName, databaseServiceDefinition(engine));
  composeOverride.setEnvironmentVariable(environmentId, serviceName, "DB_HOST", dbServiceName);

  jobManager.appendProgress(jobId, `provisioning dedicated ${engine} database for ${serviceName}`);
  await composeManager.up(project, environmentId, [dbServiceName]);
  await waitForHealthy(project, dbServiceName, { catalogEntry: getCatalogEntry(engine) });
  upsertServiceRow(environmentId, dbServiceName, "running");
  jobManager.appendProgress(jobId, `${dbServiceName} healthy`);

  if (databaseManager.snapshotExists(engine, serviceName)) {
    jobManager.appendProgress(jobId, `restoring ${engine} snapshot "${serviceName}" into ${dbServiceName}`);
    await databaseManager.restore(engine, serviceName, project, dbServiceName);
    jobManager.appendProgress(jobId, `${dbServiceName} snapshot restored`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function upsertServiceRow(environmentId, serviceName, status) {
  db.prepare(
    `INSERT INTO services (environment_id, service_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(environment_id, service_name) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`
  ).run(environmentId, serviceName, status, nowIso(), nowIso());
}

async function startAndAwaitHealthy(jobId, project, environmentId, serviceNames) {
  await composeManager.up(project, environmentId, serviceNames);
  for (const name of serviceNames) {
    jobManager.appendProgress(jobId, `waiting for ${name}`);
    await waitForHealthy(project, name);
    upsertServiceRow(environmentId, name, "running");
    jobManager.appendProgress(jobId, `${name} healthy`);
  }
}

// The full create-environment pipeline from spec Section 31: workspace -> orchestrator -> repo ->
// infra -> db restore -> app services -> health checks -> route registration -> ready.
export async function runCreateEnvironmentJob({
  jobId,
  environmentId,
  requestedServices,
  databases,
  branches,
  repository
}) {
  const project = composeProjectName(environmentId);
  const workspace = workspacePath(environmentId);

  jobManager.markRunning(jobId);
  jobManager.appendProgress(jobId, "workspace created");

  try {
    await orchestratorManager.ensureOrchestratorImage();
    orchestratorManager.provisionOrchestratorWorkspace(environmentId);
    jobManager.appendProgress(jobId, "starting orchestrator");
    await composeManager.up(project, environmentId, ["orchestrator"]);
    await waitForHealthy(project, "orchestrator", { catalogEntry: orchestratorManager.ORCHESTRATOR_CATALOG_ENTRY });
    upsertServiceRow(environmentId, "orchestrator", "running");
    jobManager.appendProgress(jobId, "orchestrator healthy");

    await ensureToolboxImage();
    jobManager.appendProgress(jobId, "starting toolbox");
    await composeManager.up(project, environmentId, [TOOLBOX_SERVICE_NAME]);
    await waitForHealthy(project, TOOLBOX_SERVICE_NAME, { catalogEntry: TOOLBOX_CATALOG_ENTRY });
    upsertServiceRow(environmentId, TOOLBOX_SERVICE_NAME, "running");
    jobManager.appendProgress(jobId, "toolbox healthy");

    if (repository?.url && repository?.commit) {
      await repositoryManager.cloneAndCheckout({ environmentId, workspace, url: repository.url, commit: repository.commit });
      jobManager.appendProgress(jobId, "repository checked out");
    }

    const infraServices = requestedServices.filter((s) => SHARED_INFRA.has(s));
    const appServices = requestedServices.filter((s) => !SHARED_INFRA.has(s));
    requestedServices.forEach((s) => upsertServiceRow(environmentId, s, "pending"));

    if (infraServices.length) {
      await startAndAwaitHealthy(jobId, project, environmentId, infraServices);
    }

    if (databases?.length) {
      await provisionDatabases(jobId, project, environmentId, databases);
    }

    if (appServices.length) {
      for (const name of appServices) {
        const branch = branches?.[name];
        // Repo is always cloned (or reused if already checked out) so code/ask and other
        // repo-dependent features work even when no branch was requested.
        const { dest } = await repositoryManager.syncServiceRepository({
          environmentId,
          workspace,
          serviceName: name,
          branch
        });
        jobManager.appendProgress(jobId, `repository checked out for ${name}${branch ? ` on branch ${branch}` : ""}`);

        if (branch) {
          jobManager.appendProgress(jobId, `building ${name} from branch ${branch}`);
          const tag = await repositoryManager.buildServiceImage({ environmentId, serviceName: name, repoDir: dest });
          composeOverride.setImage(environmentId, name, tag);
          composeOverride.addVolumeMount(environmentId, name, dest, "/app");
          jobManager.appendProgress(jobId, `built image ${tag} for ${name}`);
        }
        await provisionDefaultDatabase(jobId, project, environmentId, name);
      }
      await startAndAwaitHealthy(jobId, project, environmentId, appServices);
      await orchestratorManager.registerCatalogRoutes(project, appServices);
      await headerInjectorManager.refreshCallerMap(environmentId, project);
      await headerInjectorManager.registerFintechGatewayRouting(environmentId, project, appServices);
      jobManager.appendProgress(jobId, `registered ${appServices.join(", ")} with orchestrator`);
    }

    updateEnvironmentStatus(environmentId, ENVIRONMENT_STATUS.READY);
    jobManager.markReady(jobId);
  } catch (err) {
    updateEnvironmentStatus(environmentId, ENVIRONMENT_STATUS.FAILED);
    if (err.code === ErrorCodes.SERVICE_START_TIMEOUT) {
      jobManager.markTimeout(jobId, err);
    } else {
      jobManager.markFailed(jobId, err);
    }
    logger.error({ err, jobId, environmentId }, "create environment job failed");
  }
}
