export const JOB_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  READY: "ready",
  FAILED: "failed",
  TIMEOUT: "timeout"
};

export const ENVIRONMENT_STATUS = {
  STARTING: "starting",
  READY: "ready",
  FAILED: "failed",
  DESTROYING: "destroying",
  DESTROYED: "destroyed"
};

export const SERVICE_STATUS = {
  PENDING: "pending",
  STARTING: "starting",
  RUNNING: "running",
  STOPPED: "stopped",
  FAILED: "failed"
};

export const JOB_TYPES = {
  CREATE_ENVIRONMENT: "create_environment",
  START_SERVICE: "start_service",
  STOP_SERVICE: "stop_service",
  RESTART_SERVICE: "restart_service",
  DESTROY_ENVIRONMENT: "destroy_environment",
  CLONE_REPOSITORY: "clone_repository",
  BUILD_AND_START_SERVICE: "build_and_start_service",
  REBUILD_SERVICE: "rebuild_service",
  LOAD_TEST: "load_test"
};

export const HEALTHCHECK_TYPES = {
  HTTP: "http",
  TCP: "tcp",
  MYSQL: "mysql",
  MONGODB: "mongodb",
  DOCKER: "docker"
};

export const STARTUP_TIMEOUT_MS = Number(process.env.PRAXIS_STARTUP_TIMEOUT_MS) || 5 * 60 * 1000;
export const HEALTH_POLL_INTERVAL_MS = Number(process.env.PRAXIS_HEALTH_POLL_INTERVAL_MS) || 2000;
