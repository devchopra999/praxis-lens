import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import db from "../db/sqlite.js";
import { appError, ErrorCodes } from "../utils/errors.js";
import { ENVIRONMENT_STATUS, JOB_TYPES, JOB_STATUS } from "../types/constants.js";
import {
  isCataloguedService,
  resolveDependencies,
  getRepositoryUrl,
  listServiceNames,
  getInternalUrl,
  SERVICE_REPOSITORIES
} from "../config/service-catalog.js";
import { generateEnvironmentId } from "../utils/ids.js";
import { TOOLBOX_SERVICE_NAME, TOOLBOX_DESCRIPTION } from "./toolbox-manager.js";
import * as composeManager from "./compose-manager.js";
import * as headerInjectorManager from "./header-injector-manager.js";
import * as jobManager from "./job-manager.js";
import * as repositoryManager from "./repository-manager.js";
import { waitForHealthy } from "./health-manager.js";
import { runCreateEnvironmentJob } from "../jobs/worker.js";
import logger from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function nowIso() {
  return new Date().toISOString();
}

// http://<name>:<port> for every name with a catalogued port - lets a caller (or the toolbox
// container) reach other services by their real docker-network address instead of guessing
// "localhost", which inside a container only ever resolves back to itself.
function buildServiceEndpoints(serviceNames) {
  const endpoints = {};
  for (const name of serviceNames) {
    const url = getInternalUrl(name);
    if (url) endpoints[name] = url;
  }
  return endpoints;
}

export function composeProjectName(environmentId) {
  return `praxis-env-${environmentId.replace(/^env-/, "")}`;
}

export function workspacePath(environmentId) {
  const root = process.env.PRAXIS_WORKSPACES_DIR || path.resolve(__dirname, "../../workspaces");
  return path.join(root, environmentId);
}

export function getEnvironmentRow(environmentId) {
  return db.prepare("SELECT * FROM environments WHERE id = ?").get(environmentId);
}

export function requireEnvironment(environmentId) {
  const env = getEnvironmentRow(environmentId);
  if (!env || env.status === ENVIRONMENT_STATUS.DESTROYED) {
    throw appError(ErrorCodes.ENVIRONMENT_NOT_FOUND, `Environment ${environmentId} not found`, {
      environmentId,
      activeEnvironments: listActiveEnvironments(),
      hint: "Use an id from a previous POST /environments response, or one of activeEnvironments below."
    });
  }
  return env;
}

export function getEnvironment(environmentId) {
  const env = requireEnvironment(environmentId);
  const services = db
    .prepare("SELECT service_name, status, container_id, updated_at FROM services WHERE environment_id = ?")
    .all(environmentId);
  return { ...env, services, service_endpoints: buildServiceEndpoints(services.map((s) => s.service_name)) };
}

// True for any service actually brought up in this environment, catalogued or dynamically
// provisioned (e.g. per-environment database instances), so routes can validate against reality
// instead of the static catalog alone.
export function isProvisionedService(environmentId, serviceName) {
  const row = db
    .prepare("SELECT 1 FROM services WHERE environment_id = ? AND service_name = ?")
    .get(environmentId, serviceName);
  return Boolean(row);
}

// Services actually brought up in this environment (name + status), surfaced in "not found"
// error responses so a caller knows what it can target instead of guessing again.
export function listProvisionedServices(environmentId) {
  return db
    .prepare("SELECT service_name AS name, status FROM services WHERE environment_id = ?")
    .all(environmentId);
}

// Recent non-destroyed environment ids, surfaced on ENVIRONMENT_NOT_FOUND so a caller with a
// stale/typo'd id can pick a real one instead of guessing again.
export function listActiveEnvironments(limit = 20) {
  return db
    .prepare("SELECT id, status FROM environments WHERE status != ? ORDER BY created_at DESC LIMIT ?")
    .all(ENVIRONMENT_STATUS.DESTROYED, limit);
}

export function updateEnvironmentStatus(environmentId, status) {
  db.prepare("UPDATE environments SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), environmentId);
}

export async function createEnvironment({ services, databases, branches, repository }) {
  for (const name of services) {
    if (!isCataloguedService(name)) {
      throw appError(ErrorCodes.INVALID_SERVICE, `Unknown service "${name}"`, {
        service: name,
        validServices: listServiceNames(),
        hint: "Choose one of validServices and retry."
      });
    }
  }
  if (databases) {
    const seen = new Set();
    for (const { name } of databases) {
      if (seen.has(name)) {
        throw appError(ErrorCodes.INVALID_SERVICE, `Duplicate database name "${name}"`, {
          name,
          hint: 'Use a unique "name" for each entry in "databases".'
        });
      }
      seen.add(name);
    }
  }
  if (branches) {
    for (const name of Object.keys(branches)) {
      if (!services.includes(name)) {
        throw appError(ErrorCodes.INVALID_SERVICE, `Branch requested for service "${name}" not in services list`, {
          service: name,
          hint: `Add "${name}" to the "services" array in this request, or remove it from "branches".`
        });
      }
      if (!getRepositoryUrl(name)) {
        throw appError(ErrorCodes.REPOSITORY_NOT_CONFIGURED, `No repository is configured for service "${name}"`, {
          service: name,
          validServices: Object.keys(SERVICE_REPOSITORIES),
          hint: "Only services in validServices can be built from a branch; pick one of those or omit branches."
        });
      }
    }
  }

  const environmentId = generateEnvironmentId();
  const project = composeProjectName(environmentId);
  const workspace = workspacePath(environmentId);
  fs.mkdirSync(workspace, { recursive: true });

  db.prepare(
    `INSERT INTO environments (id, status, compose_project, workspace, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(environmentId, ENVIRONMENT_STATUS.STARTING, project, workspace, nowIso(), nowIso());

  const requestedServices = resolveDependencies(services);
  const jobId = jobManager.createJob({ environmentId, type: JOB_TYPES.CREATE_ENVIRONMENT });

  // Fire-and-forget: the worker owns all progress/status updates for this job from here on.
  runCreateEnvironmentJob({ jobId, environmentId, requestedServices, databases, branches, repository }).catch(
    (err) => {
      logger.error({ err, jobId, environmentId }, "create environment job crashed");
    }
  );

  return {
    environmentId,
    jobId,
    status: ENVIRONMENT_STATUS.STARTING,
    // Utility infra the caller didn't ask for but gets anyway - known immediately, unlike the
    // rest of environment startup which only finishes once the async job above completes.
    service_descriptions: { [TOOLBOX_SERVICE_NAME]: TOOLBOX_DESCRIPTION },
    service_endpoints: buildServiceEndpoints(requestedServices)
  };
}

function upsertServiceRow(environmentId, serviceName, status) {
  db.prepare(
    `INSERT INTO services (environment_id, service_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(environment_id, service_name) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`
  ).run(environmentId, serviceName, status, nowIso(), nowIso());
}

async function runAttachRepositoryJob({ jobId, environmentId, project, url, commit }) {
  jobManager.markRunning(jobId);
  jobManager.appendProgress(jobId, "cloning repository");
  try {
    const workspace = workspacePath(environmentId);
    const { dest, mountedServices } = await repositoryManager.cloneAndCheckout({ environmentId, workspace, url, commit });
    jobManager.appendProgress(jobId, `repository checked out at ${dest}`);

    // Containers created before the bind mount existed won't see it until recreated; services
    // that haven't started yet will already pick it up on their first `compose up`.
    const runningServices = db
      .prepare("SELECT service_name FROM services WHERE environment_id = ? AND status = 'running'")
      .all(environmentId)
      .map((row) => row.service_name);
    const servicesToRecreate = mountedServices.filter((name) => runningServices.includes(name));

    for (const name of servicesToRecreate) {
      jobManager.appendProgress(jobId, `recreating ${name} to apply repository mount`);
      await composeManager.up(project, environmentId, [name]);
      await waitForHealthy(project, name);
      upsertServiceRow(environmentId, name, "running");
      jobManager.appendProgress(jobId, `${name} healthy`);
    }
    if (servicesToRecreate.length) {
      await headerInjectorManager.refreshCallerMap(environmentId, project);
    }

    jobManager.markReady(jobId);
  } catch (err) {
    if (err.code === ErrorCodes.SERVICE_START_TIMEOUT) jobManager.markTimeout(jobId, err);
    else jobManager.markFailed(jobId, err);
    logger.error({ err, jobId, environmentId }, "attach repository job failed");
  }
}

export function attachRepository(environmentId, { url, commit }) {
  const env = requireEnvironment(environmentId);
  const jobId = jobManager.createJob({ environmentId, type: JOB_TYPES.CLONE_REPOSITORY });

  runAttachRepositoryJob({ jobId, environmentId, project: env.compose_project, url, commit }).catch((err) => {
    logger.error({ err, jobId, environmentId }, "attach repository job crashed");
  });

  return { jobId, status: JOB_STATUS.QUEUED };
}

export async function deleteEnvironment(environmentId) {
  const project = composeProjectName(environmentId);
  const workspace = workspacePath(environmentId);

  await composeManager.down(project, environmentId);
  await fs.promises.rm(workspace, { recursive: true, force: true });

  const row = getEnvironmentRow(environmentId);
  if (row) {
    db.prepare("UPDATE environments SET status = ?, updated_at = ? WHERE id = ?").run(
      ENVIRONMENT_STATUS.DESTROYED,
      nowIso(),
      environmentId
    );
  }

  return { environmentId, status: ENVIRONMENT_STATUS.DESTROYED };
}
