import { Router } from "express";
import { z } from "zod";
import { validate } from "../utils/validate.js";
import * as loadTestManager from "../services/load-test-manager.js";

const router = Router();

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const loadTestSchema = z.object({
  // path only (never a full URL) - the real target is always this environment's own
  // service_endpoints[service], so a caller can't redirect the request at an arbitrary host.
  endpoint: z.string().min(1).refine((v) => v.startsWith("/"), 'endpoint must start with "/"'),
  method: z.enum(HTTP_METHODS).default("GET"),
  headers: z.record(z.string()).optional(),
  body: z.any().optional(),
  hitCount: z.number().int().positive().max(5000),
  timeout: z.number().int().positive().max(60).optional()
});

router.post("/environments/:id/services/:service/load-test", validate(loadTestSchema), (req, res) => {
  const result = loadTestManager.runLoadTest(req.params.id, req.params.service, req.validated);
  res.status(202).json(result);
});

export default router;
