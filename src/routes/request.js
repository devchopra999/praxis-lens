import { Router } from "express";
import { z } from "zod";
import { validate } from "../utils/validate.js";
import * as requestManager from "../services/request-manager.js";

const router = Router();

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const requestSchema = z.object({
  // path only (never a full URL) - the real target is always this environment's own
  // service_endpoints[service], so a caller can't redirect the request at an arbitrary host.
  endpoint: z.string().min(1).refine((v) => v.startsWith("/"), 'endpoint must start with "/"'),
  method: z.enum(HTTP_METHODS).default("GET"),
  headers: z.record(z.string()).optional(),
  body: z.any().optional(),
  timeout: z.number().int().positive().max(60).optional()
});

// Single synchronous request to any service in the environment (unlike load-test's async job
// firing many concurrent requests) - returns the real status/headers/body for one call.
router.post("/environments/:id/services/:service/request", validate(requestSchema), async (req, res) => {
  const result = await requestManager.requestService(req.params.id, req.params.service, req.validated);
  res.json(result);
});

export default router;
