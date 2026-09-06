import { Router } from "express";
import { z } from "zod";
import { validate } from "../utils/validate.js";
import { requireEnvironment } from "../services/environment-manager.js";
import * as configManager from "../services/config-manager.js";

const router = Router();

const configSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()])
});

router.post("/environments/:id/services/:service/config", validate(configSchema), (req, res) => {
  requireEnvironment(req.params.id);
  const updated = configManager.setConfig(req.params.id, req.params.service, req.validated.key, String(req.validated.value));
  res.json({ service: req.params.service, config: updated });
});

router.get("/environments/:id/services/:service/env", (req, res) => {
  requireEnvironment(req.params.id);
  const env = configManager.getEnv(req.params.id, req.params.service);
  res.json({ service: req.params.service, env });
});

const updateEnvSchema = z.object({
  env: z.record(z.union([z.string(), z.number(), z.boolean()])).refine((e) => Object.keys(e).length > 0, "env must have at least one key")
});

router.put("/environments/:id/services/:service/env", validate(updateEnvSchema), (req, res) => {
  requireEnvironment(req.params.id);
  const patch = Object.fromEntries(Object.entries(req.validated.env).map(([k, v]) => [k, String(v)]));
  const env = configManager.updateEnv(req.params.id, req.params.service, patch);
  res.json({ service: req.params.service, env, message: "please restart the service for changes to reflect" });
});

export default router;
