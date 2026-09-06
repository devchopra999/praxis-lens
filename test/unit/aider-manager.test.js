import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "praxis-aider-data-"));
const workspacesDir = fs.mkdtempSync(path.join(os.tmpdir(), "praxis-aider-workspaces-"));
process.env.PRAXIS_DATA_DIR = dataDir;
process.env.PRAXIS_WORKSPACES_DIR = workspacesDir;

// Fake aider binary: "edits" the repo (writes a new file) in "code" mode, does nothing in "ask" mode.
const fakeAiderPath = path.join(dataDir, "fake-aider.js");
fs.writeFileSync(
  fakeAiderPath,
  `#!/usr/bin/env node
const fs = require("fs");
const mode = process.argv.includes("code") ? "code" : "ask";
if (mode === "code") fs.writeFileSync("NEW_FILE.txt", "hello from aider\\n");
console.log("did the " + mode + " thing");
process.exit(0);
`
);
fs.chmodSync(fakeAiderPath, 0o755);
process.env.AIDER_BIN = fakeAiderPath;

const aiderManager = await import("../../src/services/aider-manager.js");
const { default: db } = await import("../../src/db/sqlite.js");

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspacesDir, { recursive: true, force: true });
});

function stubEnvironment(id) {
  db.prepare(
    `INSERT INTO environments (id, status, compose_project, workspace, created_at, updated_at)
     VALUES (?, 'ready', ?, ?, datetime('now'), datetime('now'))`
  ).run(id, `praxis-${id}`, path.join(workspacesDir, id));
}

function initServiceRepo(environmentId, service) {
  const repoDir = path.join(workspacesDir, environmentId, "services", service, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repoDir });
  return repoDir;
}

test("ask throws ENVIRONMENT_NOT_FOUND for an unknown environment", async () => {
  await assert.rejects(
    () => aiderManager.ask({ environmentId: "env-does-not-exist", service: "edi", prompt: "explain this" }),
    (err) => err.code === "ENVIRONMENT_NOT_FOUND"
  );
});

test("ask throws INVALID_SERVICE for a non-catalogued service", async () => {
  stubEnvironment("env-aider1");
  await assert.rejects(
    () => aiderManager.ask({ environmentId: "env-aider1", service: "not-a-service", prompt: "explain this" }),
    (err) => err.code === "INVALID_SERVICE"
  );
});

test("ask throws SERVICE_REPO_NOT_FOUND when the service has no repo checked out", async () => {
  stubEnvironment("env-aider2");
  await assert.rejects(
    () => aiderManager.ask({ environmentId: "env-aider2", service: "edi", prompt: "explain this" }),
    (err) => err.code === "SERVICE_REPO_NOT_FOUND"
  );
});

test("ask runs aider in read-only mode and never reports changed files", async () => {
  stubEnvironment("env-aider3");
  initServiceRepo("env-aider3", "edi");
  const result = await aiderManager.ask({ environmentId: "env-aider3", service: "edi", prompt: "explain this repo" });
  assert.equal(result.mode, "ask");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /did the ask thing/);
  assert.equal(result.diff, undefined);
});

test("edit runs aider in code mode and returns a diff of what changed", async () => {
  stubEnvironment("env-aider4");
  initServiceRepo("env-aider4", "edi");
  const result = await aiderManager.edit({ environmentId: "env-aider4", service: "edi", prompt: "add a file" });
  assert.equal(result.mode, "edit");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.changedFiles, ["NEW_FILE.txt"]);
  assert.match(result.diff, /NEW_FILE\.txt/);
  assert.match(result.diff, /hello from aider/);
});
