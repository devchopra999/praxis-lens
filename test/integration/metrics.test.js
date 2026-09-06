// Integration test for the docker-stats-backed metrics endpoints; requires real Docker.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "praxis-it-metrics-"));
process.env.NODE_ENV = "test";
process.env.PRAXIS_DATA_DIR = path.join(tmpRoot, "data");
process.env.PRAXIS_WORKSPACES_DIR = path.join(tmpRoot, "workspaces");

const { default: app } = await import("../../src/server.js");
const request = (await import("supertest")).default;
const { waitForJob } = await import("./helpers.js");

let environmentId;

after(async () => {
  if (environmentId) await request(app).delete(`/environments/${environmentId}`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("setup: create an environment with edi (mysql-edi is auto-provisioned)", async () => {
  const res = await request(app).post("/environments").send({ services: ["edi"] });
  assert.equal(res.status, 202);
  environmentId = res.body.environmentId;
  const job = await waitForJob(request, app, res.body.jobId, { timeoutMs: 180000 });
  assert.equal(job.status, "ready");
});

test("single-service metrics returns one CPU/memory sample by default", async () => {
  const res = await request(app).get(`/environments/${environmentId}/services/mysql-edi/metrics`);
  assert.equal(res.status, 200);
  assert.equal(res.body.samples.length, 1);
  const sample = res.body.samples[0];
  assert.equal(typeof sample.cpuPercent, "number");
  assert.ok(sample.memoryUsageBytes > 0);
});

test("multi-service metrics samples a time series for every requested service", async () => {
  const res = await request(app).get(
    `/environments/${environmentId}/metrics?services=edi,mysql-edi&duration=4&interval=2`
  );
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.services).sort(), ["edi", "mysql-edi"]);
  assert.equal(res.body.services.edi.length, 3); // elapsed 0, 2, 4
  assert.equal(res.body.services["mysql-edi"].length, 3);
});

test("metrics with no ?services= defaults to every running service", async () => {
  const res = await request(app).get(`/environments/${environmentId}/metrics`);
  assert.equal(res.status, 200);
  const names = Object.keys(res.body.services).sort();
  assert.deepEqual(names, ["edi", "mysql-edi", "orchestrator"].sort());
});

test("an unknown service name is rejected", async () => {
  const res = await request(app).get(`/environments/${environmentId}/services/not-a-real-service/metrics`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, "INVALID_SERVICE");
});

test("duration is capped to prevent unbounded blocking requests", async () => {
  const res = await request(app).get(`/environments/${environmentId}/services/edi/metrics?duration=9999`);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, "VALIDATION_ERROR");
});
