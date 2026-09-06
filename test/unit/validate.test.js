import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../../src/utils/validate.js";
import { z } from "zod";

function mockReqRes(body) {
  const req = { body };
  const res = {};
  let nextErr;
  const next = (err) => {
    nextErr = err;
  };
  return { req, res, next, getError: () => nextErr };
}

test("validate calls next() with no error when the body is valid", () => {
  const schema = z.object({ services: z.array(z.string()).min(1) });
  const { req, res, next, getError } = mockReqRes({ services: ["mysql"] });
  validate(schema)(req, res, next);
  assert.equal(getError(), undefined);
  assert.deepEqual(req.validated, { services: ["mysql"] });
});

test("validate forwards a VALIDATION_ERROR AppError on invalid input", () => {
  const schema = z.object({ services: z.array(z.string()).min(1) });
  const { req, res, next, getError } = mockReqRes({ services: [] });
  validate(schema)(req, res, next);
  const err = getError();
  assert.ok(err);
  assert.equal(err.code, "VALIDATION_ERROR");
  assert.equal(err.statusCode, 400);
});

test("VALIDATION_ERROR issues are structured path/message pairs with a hint", () => {
  const schema = z.object({ name: z.string().min(1), count: z.number() });
  const { req, res, next, getError } = mockReqRes({ name: "", count: "not-a-number" });
  validate(schema)(req, res, next);
  const err = getError();
  assert.ok(Array.isArray(err.details.issues));
  assert.ok(err.details.issues.some((issue) => issue.path === "name"));
  assert.ok(err.details.issues.some((issue) => issue.path === "count"));
  assert.ok(err.details.issues.every((issue) => typeof issue.message === "string"));
  assert.equal(typeof err.details.hint, "string");
});
