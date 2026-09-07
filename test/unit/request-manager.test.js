import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "praxis-request-"));
process.env.PRAXIS_DATA_DIR = tmpDir;

const { parseHeaderBlock, parseRequestOutput } = await import("../../src/services/request-manager.js");

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("parseHeaderBlock skips the status line and lower-cases keys", () => {
  const raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Trace: abc\r\n";
  assert.deepEqual(parseHeaderBlock(raw), { "content-type": "application/json", "x-trace": "abc" });
});

test("parseHeaderBlock joins repeated headers with a comma", () => {
  const raw = "HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n";
  assert.deepEqual(parseHeaderBlock(raw), { "set-cookie": "a=1, b=2" });
});

function buildScriptStdout({ curlExit = 0, statusCode = 200, rawHeaders = "HTTP/1.1 200 OK\r\n", body = "" }) {
  const bodyB64 = Buffer.from(body, "utf8").toString("base64");
  return `${curlExit}\n${statusCode}\n---PRAXIS-HEADERS---\n${rawHeaders}---PRAXIS-BODY-B64---\n${bodyB64}`;
}

test("parseRequestOutput JSON-decodes the body when content-type is json", () => {
  const stdout = buildScriptStdout({
    rawHeaders: "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n",
    body: JSON.stringify({ ok: true })
  });
  const result = parseRequestOutput(stdout);
  assert.equal(result.curlExit, 0);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ok: true });
});

test("parseRequestOutput returns text body as-is for non-json content-type", () => {
  const stdout = buildScriptStdout({
    rawHeaders: "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n",
    body: "hello"
  });
  const result = parseRequestOutput(stdout);
  assert.equal(result.body, "hello");
});

test("parseRequestOutput returns null body when response has no body", () => {
  const stdout = buildScriptStdout({ body: "" });
  const result = parseRequestOutput(stdout);
  assert.equal(result.body, null);
});

test("parseRequestOutput surfaces a non-zero curl exit code", () => {
  const stdout = buildScriptStdout({ curlExit: 7, statusCode: 0 });
  const result = parseRequestOutput(stdout);
  assert.equal(result.curlExit, 7);
});
