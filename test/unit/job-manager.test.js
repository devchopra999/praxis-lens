import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "praxis-jobs-"));
process.env.PRAXIS_DATA_DIR = tmpDir;

const jobManager = await import("../../src/services/job-manager.js");
const { JOB_STATUS } = await import("../../src/types/constants.js");
const { default: db } = await import("../../src/db/sqlite.js");

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// jobs.environment_id has a foreign key to environments.id; jobManager is tested in isolation
// here, so stub a minimal environment row for each fake id used below.
function stubEnvironment(id) {
  db.prepare(
    `INSERT INTO environments (id, status, compose_project, workspace, created_at, updated_at)
     VALUES (?, 'starting', ?, ?, datetime('now'), datetime('now'))`
  ).run(id, `praxis-${id}`, `/tmp/${id}`);
}

test("createJob starts a job in the queued state with empty progress", () => {
  stubEnvironment("env-test1");
  const jobId = jobManager.createJob({ environmentId: "env-test1", type: "create_environment" });
  const job = jobManager.getJob(jobId);
  assert.equal(job.status, JOB_STATUS.QUEUED);
  assert.deepEqual(job.progress, []);
});

test("appendProgress accumulates notes in order", () => {
  stubEnvironment("env-test2");
  const jobId = jobManager.createJob({ environmentId: "env-test2", type: "create_environment" });
  jobManager.markRunning(jobId);
  jobManager.appendProgress(jobId, "step 1");
  jobManager.appendProgress(jobId, "step 2");
  const job = jobManager.getJob(jobId);
  assert.equal(job.status, JOB_STATUS.RUNNING);
  assert.deepEqual(job.progress, ["step 1", "step 2"]);
});

test("markReady/markFailed/markTimeout set terminal status", () => {
  stubEnvironment("env-test3");
  stubEnvironment("env-test4");
  stubEnvironment("env-test5");
  const readyId = jobManager.createJob({ environmentId: "env-test3", type: "create_environment" });
  jobManager.markReady(readyId);
  assert.equal(jobManager.getJob(readyId).status, JOB_STATUS.READY);

  const failedId = jobManager.createJob({ environmentId: "env-test4", type: "create_environment" });
  jobManager.markFailed(failedId, "boom");
  const failedJob = jobManager.getJob(failedId);
  assert.equal(failedJob.status, JOB_STATUS.FAILED);
  assert.equal(failedJob.error, "boom");

  const timeoutId = jobManager.createJob({ environmentId: "env-test5", type: "create_environment" });
  jobManager.markTimeout(timeoutId, "too slow");
  assert.equal(jobManager.getJob(timeoutId).status, JOB_STATUS.TIMEOUT);
});

test("getJob throws JOB_NOT_FOUND for an unknown id", () => {
  assert.throws(() => jobManager.getJob("job-does-not-exist"), (err) => err.code === "JOB_NOT_FOUND");
});

test("markFailed/markTimeout preserve an AppError's code/details as errorDetails", async () => {
  stubEnvironment("env-test6");
  stubEnvironment("env-test7");
  const { appError, ErrorCodes } = await import("../../src/utils/errors.js");

  const failedId = jobManager.createJob({ environmentId: "env-test6", type: "create_environment" });
  jobManager.markFailed(failedId, appError(ErrorCodes.INVALID_SERVICE, "Unknown service \"bogus\"", {
    service: "bogus",
    validServices: ["mysql"],
    hint: "Choose one of validServices and retry."
  }));
  const failedJob = jobManager.getJob(failedId);
  assert.equal(failedJob.error, 'Unknown service "bogus"');
  assert.deepEqual(failedJob.errorDetails, {
    code: "INVALID_SERVICE",
    service: "bogus",
    validServices: ["mysql"],
    hint: "Choose one of validServices and retry."
  });

  const timeoutId = jobManager.createJob({ environmentId: "env-test7", type: "create_environment" });
  jobManager.markTimeout(timeoutId, appError(ErrorCodes.SERVICE_START_TIMEOUT, "edi timed out", { service: "edi" }));
  const timeoutJob = jobManager.getJob(timeoutId);
  assert.equal(timeoutJob.errorDetails.code, "SERVICE_START_TIMEOUT");
});
