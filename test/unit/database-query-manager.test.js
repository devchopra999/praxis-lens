import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEngine } from "../../src/services/database-query-manager.js";

test("resolveEngine recognizes catalogued shared-infra databases", () => {
  assert.equal(resolveEngine("mysql"), "mysql");
  assert.equal(resolveEngine("mongodb"), "mongodb");
});

test("resolveEngine recognizes per-environment provisioned databases by prefix", () => {
  assert.equal(resolveEngine("mysql-orders"), "mysql");
  assert.equal(resolveEngine("mongodb-orders"), "mongodb");
});

test("resolveEngine returns null for non-database services", () => {
  assert.equal(resolveEngine("redis"), null);
  assert.equal(resolveEngine("edi"), null);
  assert.equal(resolveEngine("mob"), null);
});
