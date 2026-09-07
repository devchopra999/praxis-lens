import { requireEnvironment, workspacePath } from "./environment-manager.js";
import * as composeManager from "./compose-manager.js";
import * as jobManager from "./job-manager.js";
import { waitForHealthy } from "./health-manager.js";
import { isCataloguedService, resolveDependencies, listServiceNames } from "../config/service-catalog.js";
import * as repositoryManager from "./repository-manager.js";
import * as composeOverride from "./compose-override.js";
import { provisionDefaultDatabase } from "../jobs/worker.js";
import * as orchestratorManager from "./orchestrator-manager.js";
import * as headerInjectorManager from "./header-injector-manager.js";
import { appError, ErrorCodes } from "../utils/errors.js";
import { JOB_TYPES, JOB_STATUS } from "../types/constants.js";
import db from "../db/sqlite.js";
import logger from "../utils/logger.js";

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

export function assertCatalogued(serviceName) {
  if (!isCataloguedService(serviceName)) {
    throw appError(ErrorCodes.INVALID_SERVICE, `Unknown service "${serviceName}"`, {
      service: serviceName,
      validServices: listServiceNames(),
      hint: "Choose one of validServices and retry."
    });
  }
}

async function runStartJob(jobId, project, environmentId, serviceName) {
  jobManager.markRunning(jobId);
  try {
    // Resolves and (re)starts any missing dependencies too, joining the existing compose project/network.
    const services = resolveDependencies([serviceName]);
    for (const name of services) {
      await provisionDefaultDatabase(jobId, project, environmentId, name);
    }
    jobManager.appendProgress(jobId, `starting ${services.join(", ")}`);
    await composeManager.up(project, environmentId, services);
    for (const name of services) {
      await waitForHealthy(project, name);
      upsertServiceRow(environmentId, name, "running");
      jobManager.appendProgress(jobId, `${name} healthy`);
    }
    await orchestratorManager.registerCatalogRoutes(project, services);
    await headerInjectorManager.refreshCallerMap(environmentId, project);
    await headerInjectorManager.registerFintechGatewayRouting(environmentId, project, services);
    jobManager.markReady(jobId);
  } catch (err) {
    upsertServiceRow(environmentId, serviceName, "failed");
    if (err.code === ErrorCodes.SERVICE_START_TIMEOUT) jobManager.markTimeout(jobId, err);
    else jobManager.markFailed(jobId, err);
    logger.error({ err, jobId, environmentId, serviceName }, "start service job failed");
  }
}

export function startService(environmentId, serviceName) {
  const env = requireEnvironment(environmentId);
  assertCatalogued(serviceName);
  upsertServiceRow(environmentId, serviceName, "starting");
  const jobId = jobManager.createJob({ environmentId, type: JOB_TYPES.START_SERVICE });
  runStartJob(jobId, env.compose_project, environmentId, serviceName).catch((err) =>
    logger.error({ err, jobId }, "start service job crashed")
  );
  return { jobId, status: JOB_STATUS.QUEUED };
}

// Implements the "Start <service> on branch <branch>" flow: lookup the service's repo mapping,
// clone it (or reuse/checkout+pull an existing checkout), docker build it into an
// environment+service scoped image, then bring the service up from that image with the checked
// out source bind-mounted in (dev-mode), joining the existing compose project/network.
async function runBuildAndStartJob(jobId, project, environmentId, serviceName, branch) {
  jobManager.markRunning(jobId);
  try {
    const workspace = workspacePath(environmentId);
    jobManager.appendProgress(jobId, `syncing repository for ${serviceName}${branch ? ` (branch ${branch})` : ""}`);
    const { dest, branch: resolvedBranch } = await repositoryManager.syncServiceRepository({
      environmentId,
      workspace,
      serviceName,
      branch
    });
    jobManager.appendProgress(jobId, `repository ready at ${dest} (branch ${resolvedBranch})`);

    jobManager.appendProgress(jobId, `building image for ${serviceName}`);
    const tag = await repositoryManager.buildServiceImage({ environmentId, serviceName, repoDir: dest });
    jobManager.appendProgress(jobId, `built image ${tag}`);

    composeOverride.setImage(environmentId, serviceName, tag);
    composeOverride.addVolumeMount(environmentId, serviceName, dest, "/app");

    const services = resolveDependencies([serviceName]);
    for (const name of services) {
      await provisionDefaultDatabase(jobId, project, environmentId, name);
    }
    jobManager.appendProgress(jobId, `starting ${services.join(", ")}`);
    await composeManager.up(project, environmentId, services);
    for (const name of services) {
      await waitForHealthy(project, name);
      upsertServiceRow(environmentId, name, "running");
      jobManager.appendProgress(jobId, `${name} healthy`);
    }
    await orchestratorManager.registerCatalogRoutes(project, services);
    await headerInjectorManager.refreshCallerMap(environmentId, project);
    await headerInjectorManager.registerFintechGatewayRouting(environmentId, project, services);
    jobManager.markReady(jobId);
  } catch (err) {
    upsertServiceRow(environmentId, serviceName, "failed");
    if (err.code === ErrorCodes.SERVICE_START_TIMEOUT) jobManager.markTimeout(jobId, err);
    else jobManager.markFailed(jobId, err);
    logger.error({ err, jobId, environmentId, serviceName, branch }, "build and start service job failed");
  }
}

export function startServiceFromBranch(environmentId, serviceName, branch) {
  const env = requireEnvironment(environmentId);
  assertCatalogued(serviceName);
  upsertServiceRow(environmentId, serviceName, "starting");
  const jobId = jobManager.createJob({ environmentId, type: JOB_TYPES.BUILD_AND_START_SERVICE });
  runBuildAndStartJob(jobId, env.compose_project, environmentId, serviceName, branch).catch((err) =>
    logger.error({ err, jobId }, "build and start service job crashed")
  );
  return { jobId, status: JOB_STATUS.QUEUED };
}

// Rebuilds the service's image from its current checkout (no branch switch - picks up in-place
// edits, e.g. from aider) and recreates the container from that image, so compiled-language
// services (whose bind mount can't reach the running artifact - see repository-manager.js) get
// source changes applied.
export function rebuildService(environmentId, serviceName) {
  const env = requireEnvironment(environmentId);
  assertCatalogued(serviceName);
  upsertServiceRow(environmentId, serviceName, "starting");
  const jobId = jobManager.createJob({ environmentId, type: JOB_TYPES.REBUILD_SERVICE });
  runBuildAndStartJob(jobId, env.compose_project, environmentId, serviceName, undefined).catch((err) =>
    logger.error({ err, jobId }, "rebuild service job crashed")
  );
  return { jobId, status: JOB_STATUS.QUEUED };
}

export function stopService(environmentId, serviceName) {
  const env = requireEnvironment(environmentId);
  assertCatalogued(serviceName);
  const jobId = jobManager.createJob({ environmentId, type: JOB_TYPES.STOP_SERVICE });

  (async () => {
    jobManager.markRunning(jobId);
    try {
      await composeManager.stopService(env.compose_project, environmentId, serviceName);
      upsertServiceRow(environmentId, serviceName, "stopped");
      jobManager.markReady(jobId);
    } catch (err) {
      jobManager.markFailed(jobId, err);
      logger.error({ err, jobId }, "stop service job failed");
    }
  })();

  return { jobId, status: JOB_STATUS.QUEUED };
}

export function restartService(environmentId, serviceName) {
  const env = requireEnvironment(environmentId);
  assertCatalogued(serviceName);
  const jobId = jobManager.createJob({ environmentId, type: JOB_TYPES.RESTART_SERVICE });

  (async () => {
    jobManager.markRunning(jobId);
    try {
      // Restarting never recreates the environment/network, only the target container.
      await composeManager.restartService(env.compose_project, environmentId, serviceName);
      await waitForHealthy(env.compose_project, serviceName);
      upsertServiceRow(environmentId, serviceName, "running");
      jobManager.markReady(jobId);
    } catch (err) {
      if (err.code === ErrorCodes.SERVICE_START_TIMEOUT) jobManager.markTimeout(jobId, err);
      else jobManager.markFailed(jobId, err);
      logger.error({ err, jobId }, "restart service job failed");
    }
  })();

  return { jobId, status: JOB_STATUS.QUEUED };
}
