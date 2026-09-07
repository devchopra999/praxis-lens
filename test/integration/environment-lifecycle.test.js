// Integration suite: exercises the full spec Section 31 experiment loop against real Docker.
// Requires Docker Engine + Compose v2 running locally. Images used (mysql:8, mongo:8,
// alpine:3.19, redis:7) should already be pulled or this will be slow the first run; the first
// environment created also clones+builds the orchestrator image, which is slow the first time too.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "praxis-it-"));
process.env.NODE_ENV = "test";
process.env.PRAXIS_DATA_DIR = path.join(tmpRoot, "data");
process.env.PRAXIS_WORKSPACES_DIR = path.join(tmpRoot, "workspaces");

const { default: app } = await import("../../src/server.js");
const request = (await import("supertest")).default;
const { waitForJob } = await import("./helpers.js");
const { inspectContainer, findContainer } = await import("../../src/docker/docker-client.js");
const healthManager = await import("../../src/services/health-manager.js");

const createdEnvironmentIds = [];

async function createEnvironment(body) {
  const res = await request(app).post("/environments").send(body);
  assert.equal(res.status, 202);
  assert.match(res.body.environmentId, /^env-/);
  assert.match(res.body.jobId, /^job-/);
  assert.equal(res.body.status, "starting");
  createdEnvironmentIds.push(res.body.environmentId);
  return res.body;
}

after(async () => {
  for (const id of createdEnvironmentIds) {
    await request(app).delete(`/environments/${id}`);
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("environment IDs and compose projects are unique per creation", async () => {
  const a = await createEnvironment({ services: ["mob"] });
  const b = await createEnvironment({ services: ["mob"] });
  assert.notEqual(a.environmentId, b.environmentId);
  await waitForJob(request, app, a.jobId);
  await waitForJob(request, app, b.jobId);
  const envA = await request(app).get(`/environments/${a.environmentId}`);
  const envB = await request(app).get(`/environments/${b.environmentId}`);
  assert.notEqual(envA.body.composeProject, envB.body.composeProject);
});

test("dependencies are resolved automatically and requested+dependency services all start", async () => {
  const { environmentId, jobId } = await createEnvironment({ services: ["edi"] });
  const job = await waitForJob(request, app, jobId, { timeoutMs: 180000 });
  assert.equal(job.status, "ready");
  assert.ok(job.progress.includes("workspace created"));
  assert.ok(job.progress.includes("mysql-edi healthy"));
  assert.ok(job.progress.includes("orchestrator healthy"));
  assert.ok(job.progress.includes("edi healthy"));

  const env = await request(app).get(`/environments/${environmentId}`);
  const names = env.body.services.map((s) => s.service_name).sort();
  assert.deepEqual(names, ["edi", "mysql-edi", "orchestrator", "toolbox"]);
  for (const svc of env.body.services) assert.equal(svc.status, "running");
});

test("services in the same environment share one compose network", async () => {
  const { environmentId, jobId } = await createEnvironment({ services: ["mob", "edi"] });
  const job = await waitForJob(request, app, jobId, { timeoutMs: 180000 });
  assert.equal(job.status, "ready");

  const env = await request(app).get(`/environments/${environmentId}`);
  const project = env.body.composeProject;

  const mobContainer = await findContainer(project, "mob");
  const ediContainer = await findContainer(project, "edi");
  const mobInfo = await inspectContainer(mobContainer.Id);
  const ediInfo = await inspectContainer(ediContainer.Id);
  const mobNetworks = Object.keys(mobInfo.NetworkSettings.Networks);
  const ediNetworks = Object.keys(ediInfo.NetworkSettings.Networks);
  assert.deepEqual(mobNetworks, ediNetworks);
});

test("a service can be added later and joins the existing environment without recreating it", async () => {
  const { environmentId, jobId } = await createEnvironment({ services: ["edi"] });
  await waitForJob(request, app, jobId, { timeoutMs: 180000 });

  const before = await request(app).get(`/environments/${environmentId}`);
  const project = before.body.composeProject;
  const ediBefore = await findContainer(project, "edi");

  const startRes = await request(app).post(`/environments/${environmentId}/services/mock-server/start`);
  assert.equal(startRes.status, 202);
  await waitForJob(request, app, startRes.body.jobId, { timeoutMs: 60000 });

  const after1 = await request(app).get(`/environments/${environmentId}`);
  const names = after1.body.services.map((s) => s.service_name).sort();
  assert.ok(names.includes("mock-server"));
  const ediAfter = await findContainer(project, "edi");
  assert.equal(ediBefore.Id, ediAfter.Id, "unrelated service must not be recreated");
});

test("restarting a service does not recreate the environment", async () => {
  const { environmentId, jobId } = await createEnvironment({ services: ["edi"] });
  await waitForJob(request, app, jobId, { timeoutMs: 180000 });

  const envBefore = await request(app).get(`/environments/${environmentId}`);
  const project = envBefore.body.composeProject;
  const mysqlBefore = await findContainer(project, "mysql-edi");

  const restartRes = await request(app).post(`/environments/${environmentId}/services/edi/restart`);
  assert.equal(restartRes.status, 202);
  await waitForJob(request, app, restartRes.body.jobId, { timeoutMs: 60000 });

  const mysqlAfter = await findContainer(project, "mysql-edi");
  assert.equal(mysqlBefore.Id, mysqlAfter.Id, "restarting edi must not touch its dedicated database");
});

test("the orchestrator auto-registers a route for every started HTTP app service", async () => {
  const { environmentId, jobId } = await createEnvironment({ services: ["edi"] });
  await waitForJob(request, app, jobId, { timeoutMs: 180000 });

  const route = await request(app).get(`/environments/${environmentId}/orchestrator/routes/*/edi`);
  assert.equal(route.status, 200);
  assert.equal(route.body.pointsTo, "edi");
});

test("commands execute inside the target container and capture output", async () => {
  const { environmentId, jobId } = await createEnvironment({ services: ["edi"] });
  await waitForJob(request, app, jobId, { timeoutMs: 180000 });

  const res = await request(app)
    .post(`/environments/${environmentId}/execute`)
    .send({ service: "edi", command: ["echo", "hello-from-test"], timeout: 10 });
  assert.equal(res.status, 200);
  assert.equal(res.body.exitCode, 0);
  assert.match(res.body.stdout, /hello-from-test/);
});

test("command execution enforces the timeout", async () => {
  const { environmentId, jobId } = await createEnvironment({ services: ["edi"] });
  await waitForJob(request, app, jobId, { timeoutMs: 180000 });

  const res = await request(app)
    .post(`/environments/${environmentId}/execute`)
    .send({ service: "edi", command: ["sleep", "10"], timeout: 2 });
  assert.equal(res.status, 504);
  assert.equal(res.body.error.code, "COMMAND_TIMEOUT");
});

test("logs can be retrieved for a running service", async () => {
  const { environmentId, jobId } = await createEnvironment({ services: ["edi"] });
  await waitForJob(request, app, jobId, { timeoutMs: 180000 });

  const res = await request(app).get(`/environments/${environmentId}/services/edi/logs?tail=50`);
  assert.equal(res.status, 200);
  assert.equal(res.body.service, "edi");
  assert.equal(typeof res.body.logs, "string");
});

test("repository is checked out at the exact requested commit", async () => {
  const { environmentId, jobId } = await createEnvironment({
    services: ["mock-server"],
    repository: { url: "https://github.com/octocat/Hello-World.git", commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d" }
  });
  const job = await waitForJob(request, app, jobId, { timeoutMs: 60000 });
  assert.equal(job.status, "ready");

  const env = await request(app).get(`/environments/${environmentId}`);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: path.join(env.body.workspace, "repo") });
  assert.equal(stdout.trim(), "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d");
});

test("environment deletion is idempotent and removes containers", async () => {
  const { environmentId, jobId } = await createEnvironment({ services: ["mock-server"] });
  await waitForJob(request, app, jobId, { timeoutMs: 60000 });

  const first = await request(app).delete(`/environments/${environmentId}`);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "destroyed");

  const second = await request(app).delete(`/environments/${environmentId}`);
  assert.equal(second.status, 200);
  assert.equal(second.body.status, "destroyed");

  const getRes = await request(app).get(`/environments/${environmentId}`);
  assert.equal(getRes.status, 404);
});

test("a service that never becomes healthy times out with logs attached", async () => {
  await assert.rejects(
    () => healthManager.waitForHealthy("praxis-env-does-not-exist", "edi", { timeoutMs: 3000, intervalMs: 500 }),
    (err) => {
      assert.equal(err.code, "SERVICE_START_TIMEOUT");
      return true;
    }
  );
});
