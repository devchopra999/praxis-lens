import { Router } from "express";
import { z } from "zod";
import * as serviceManager from "../services/service-manager.js";
import { getRepositoryUrl } from "../config/service-catalog.js";
import { validate } from "../utils/validate.js";

const router = Router();

const startServiceSchema = z.object({
  branch: z.string().min(1).optional()
});

const DEFAULT_BRANCH = "main";

router.post("/environments/:id/services/:service/start", validate(startServiceSchema), (req, res) => {
  const { branch } = req.validated;
  // Only default to main when the service has a repo to check out; repo-less (e.g. dependency-only) services always use the plain start path.
  const effectiveBranch = branch || (getRepositoryUrl(req.params.service) ? DEFAULT_BRANCH : undefined);
  const result = effectiveBranch
    ? serviceManager.startServiceFromBranch(req.params.id, req.params.service, effectiveBranch)
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
