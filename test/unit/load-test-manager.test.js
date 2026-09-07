import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "praxis-load-test-"));
process.env.PRAXIS_DATA_DIR = tmpDir;

const { buildCurlArgs, parseCurlOutput } = await import("../../src/services/load-test-manager.js");

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("buildCurlArgs sets -X and skips body/content-type when no body given", () => {
  const args = buildCurlArgs({ method: "GET", headers: {} });
  assert.deepEqual(args, ["-X", "GET"]);
});

test("buildCurlArgs adds one -H per header, in order", () => {
  const args = buildCurlArgs({ method: "GET", headers: { Authorization: "Bearer x", "X-Trace": "1" } });
  assert.deepEqual(args, ["-X", "GET", "-H", "Authorization: Bearer x", "-H", "X-Trace: 1"]);
});

test("buildCurlArgs JSON-encodes body and defaults Content-Type when caller didn't set one", () => {
  const args = buildCurlArgs({ method: "POST", headers: {}, body: { amount: 5 } });
  assert.deepEqual(args, ["-X", "POST", "-H", "Content-Type: application/json", "--data-raw", '{"amount":5}']);
});

test("buildCurlArgs respects a caller-supplied content-type instead of defaulting", () => {
  const args = buildCurlArgs({ method: "POST", headers: { "Content-Type": "text/plain" }, body: "hi" });
  assert.deepEqual(args, ["-X", "POST", "-H", "Content-Type: text/plain", "--data-raw", '"hi"']);
});

test("parseCurlOutput buckets status codes, counts success/failure, and computes latency stats", () => {
  const stdout = "200 0.050\n200 0.100\n500 0.025\n000 0.010\n";
  const summary = parseCurlOutput(stdout, 4);
  assert.equal(summary.completed, 4);
  assert.equal(summary.missing, 0);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 2);
  assert.deepEqual(summary.statusCodes, { "200": 2, "500": 1, "000": 1 });
  assert.deepEqual(summary.latencyMs, { min: 10, max: 100, avg: 46 });
});

test("parseCurlOutput reports missing lines when fewer results than hitCount arrive", () => {
  const summary = parseCurlOutput("200 0.010\n", 5);
  assert.equal(summary.completed, 1);
  assert.equal(summary.missing, 4);
});

test("parseCurlOutput handles zero completed results without dividing by zero", () => {
  const summary = parseCurlOutput("", 3);
  assert.equal(summary.completed, 0);
  assert.equal(summary.missing, 3);
  assert.deepEqual(summary.latencyMs, { min: null, max: null, avg: null });
});
