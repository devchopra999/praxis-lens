import { Router } from "express";
import { z } from "zod";
import * as serviceManager from "../services/service-manager.js";
import { validate } from "../utils/validate.js";

const router = Router();

const startServiceSchema = z.object({
  branch: z.string().min(1).optional()
});

router.post("/environments/:id/services/:service/start", validate(startServiceSchema), (req, res) => {
  const { branch } = req.validated;
  const result = branch
    ? serviceManager.startServiceFromBranch(req.params.id, req.params.service, branch)
    : serviceManager.startService(req.params.id, req.params.service);
  res.status(202).json(result);
});

router.post("/environments/:id/services/:service/stop", (req, res) => {
  const result = serviceManager.stopService(req.params.id, req.params.service);
  res.status(202).json(result);
});

router.post("/environments/:id/services/:service/restart", (req, res) => {
  const result = serviceManager.restartService(req.params.id, req.params.service);
  res.status(202).json(result);
});

// Rebuilds the image from the current checkout and recreates the container - unlike restart,
// this picks up in-place source edits (e.g. from aider) for compiled-language services.
router.post("/environments/:id/services/:service/rebuild", (req, res) => {
  const result = serviceManager.rebuildService(req.params.id, req.params.service);
  res.status(202).json(result);
});

export default router;
