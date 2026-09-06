import { test } from "node:test";
import assert from "node:assert/strict";
import { AppError, appError, ErrorCodes } from "../../src/utils/errors.js";

test("appError maps known codes to the right HTTP status", () => {
  assert.equal(appError(ErrorCodes.ENVIRONMENT_NOT_FOUND, "nope").statusCode, 404);
  assert.equal(appError(ErrorCodes.SERVICE_START_TIMEOUT, "nope").statusCode, 504);
  assert.equal(appError(ErrorCodes.INVALID_SERVICE, "nope").statusCode, 400);
});

test("AppError.toJSON matches the spec's error response shape", () => {
  const err = appError(ErrorCodes.HEALTH_CHECK_FAILED, "edi unhealthy", { service: "edi", logs: "boom" });
  assert.deepEqual(err.toJSON(), {
    error: { code: "HEALTH_CHECK_FAILED", message: "edi unhealthy", service: "edi", logs: "boom" }
  });
});

test("unknown codes fall back to a 500", () => {
  const err = new AppError("SOMETHING_ELSE", "oops");
  assert.equal(err.statusCode, 500);
});
