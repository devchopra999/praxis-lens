import { test } from "node:test";
import assert from "node:assert/strict";
import { isCataloguedService, resolveDependencies, listServiceNames, SERVICE_CATALOG } from "../../src/config/service-catalog.js";

test("isCataloguedService rejects unknown and dependency-only services", () => {
  assert.equal(isCataloguedService("mob"), true);
  assert.equal(isCataloguedService("mysql"), false);
  assert.equal(isCataloguedService("some-random-image"), false);
});

test("listServiceNames excludes dependency-only services (mysql/mongodb/redis)", () => {
  const names = listServiceNames();
  assert.ok(names.includes("mob"));
  assert.ok(!names.includes("mysql"));
  assert.ok(!names.includes("mongodb"));
  assert.ok(!names.includes("redis"));
});

test("resolveDependencies adds transitive dependencies dependency-first, deduped", () => {
  const resolved = resolveDependencies(["mob", "edi"]);
  assert.deepEqual(resolved, ["mob", "edi"]);
});

test("mob and edi each get their own default database engine instead of a shared dependency", () => {
  assert.equal(SERVICE_CATALOG.mob.database, "mysql");
  assert.equal(SERVICE_CATALOG.edi.database, "mysql");
  assert.deepEqual(SERVICE_CATALOG.edi.dependencies, []);
});

test("resolveDependencies is a no-op for services with no dependencies", () => {
  assert.deepEqual(resolveDependencies(["redis"]), ["redis"]);
});

test("every catalog entry only allows a fixed image (no arbitrary override for infra services)", () => {
  assert.equal(SERVICE_CATALOG.mysql.image, "mysql:8");
});
