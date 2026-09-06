import db from "../db/sqlite.js";
import { generateJobId } from "../utils/ids.js";
import { JOB_STATUS } from "../types/constants.js";
import { appError, AppError, ErrorCodes } from "../utils/errors.js";

function nowIso() {
  return new Date().toISOString();
}

// error can be a plain string (back-compat) or an Error/AppError; AppErrors get their
// code/details preserved in error_details so callers polling GET /jobs/:id see the same
// structured hint/valid-values info a synchronous route error would return.
function splitError(error) {
  if (typeof error === "string") return { message: error, details: null };
  if (error instanceof AppError) {
    return { message: error.message, details: JSON.stringify({ code: error.code, ...error.details }) };
  }
  return { message: error?.message || String(error), details: null };
}

export function createJob({ environmentId, type }) {
  const jobId = generateJobId();
  db.prepare(
    `INSERT INTO jobs (id, environment_id, type, status, progress, created_at)
     VALUES (?, ?, ?, ?, '[]', ?)`
  ).run(jobId, environmentId, type, JOB_STATUS.QUEUED, nowIso());
  return jobId;
}

export function getJob(jobId) {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  if (!row) {
    throw appError(ErrorCodes.JOB_NOT_FOUND, `Job ${jobId} not found`, {
      jobId,
      hint: "Use the jobId returned by the action that triggered this job (e.g. POST /environments or a service start/stop/restart call)."
    });
  }
  return {
    ...row,
    progress: JSON.parse(row.progress || "[]"),
    errorDetails: row.error_details ? JSON.parse(row.error_details) : undefined
  };
}

export function markRunning(jobId) {
  db.prepare("UPDATE jobs SET status = ?, started_at = ? WHERE id = ?").run(JOB_STATUS.RUNNING, nowIso(), jobId);
}

export function appendProgress(jobId, note) {
  const row = db.prepare("SELECT progress FROM jobs WHERE id = ?").get(jobId);
  const progress = JSON.parse(row?.progress || "[]");
  progress.push(note);
  db.prepare("UPDATE jobs SET progress = ? WHERE id = ?").run(JSON.stringify(progress), jobId);
}

export function markReady(jobId) {
  db.prepare("UPDATE jobs SET status = ?, completed_at = ? WHERE id = ?").run(JOB_STATUS.READY, nowIso(), jobId);
}

export function markFailed(jobId, error) {
  const { message, details } = splitError(error);
  db.prepare("UPDATE jobs SET status = ?, error = ?, error_details = ?, completed_at = ? WHERE id = ?").run(
    JOB_STATUS.FAILED,
    message,
    details,
    nowIso(),
    jobId
  );
}

export function markTimeout(jobId, error) {
  const { message, details } = splitError(error);
  db.prepare("UPDATE jobs SET status = ?, error = ?, error_details = ?, completed_at = ? WHERE id = ?").run(
    JOB_STATUS.TIMEOUT,
    message,
    details,
    nowIso(),
    jobId
  );
}
