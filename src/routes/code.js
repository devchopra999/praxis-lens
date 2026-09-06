import { Router } from "express";
import { z } from "zod";
import { validate } from "../utils/validate.js";
import * as aiderManager from "../services/aider-manager.js";

const router = Router();

const promptSchema = z.object({
  prompt: z.string().min(1),
  timeoutMs: z.number().int().positive().max(30 * 60 * 1000).optional()
});

// Read-only: ask aider to inspect/explain the service's repository, no files are changed.
router.post("/environments/:id/services/:service/code/ask", validate(promptSchema), async (req, res) => {
  const { prompt, timeoutMs } = req.validated;
  const result = await aiderManager.ask({ environmentId: req.params.id, service: req.params.service, prompt, timeoutMs });
  res.json(result);
});

// Lets aider modify the repository and returns a diff; caller is responsible for triggering a rebuild/restart.
router.post("/environments/:id/services/:service/code/edit", validate(promptSchema), async (req, res) => {
  const { prompt, timeoutMs } = req.validated;
  const result = await aiderManager.edit({ environmentId: req.params.id, service: req.params.service, prompt, timeoutMs });
  res.json(result);
});

export default router;
