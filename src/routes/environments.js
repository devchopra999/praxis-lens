import { Router } from "express";
import { z } from "zod";
import { validate } from "../utils/validate.js";
import * as environmentManager from "../services/environment-manager.js";

const router = Router();

// One block per requested name, so callers can spin up as many (or as few) independent
// database instances as they have services that need one, instead of a fixed shared instance.
const databaseSpecSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/, "lowercase alphanumeric and hyphens only"),
  engine: z.enum(["mysql", "mongodb"]).default("mysql"),
  snapshot: z.string().min(1).optional()
});

const createEnvironmentSchema = z.object({
  services: z.array(z.string()).min(1),
  databases: z.array(databaseSpecSchema).min(1).optional(),
  // Optional per-service branch to build from source instead of the default image, keyed by
  // service name (e.g. { "mob": "feature/foo" }). Only services with a configured repository
  // (see config/service-catalog.js SERVICE_REPOSITORIES) can be built this way.
  branches: z.record(z.string(), z.string().min(1)).optional(),
  repository: z
    .object({
      url: z.string().url(),
      commit: z.string().min(1)
    })
    .optional()
});

router.post("/environments", validate(createEnvironmentSchema), async (req, res) => {
  const result = await environmentManager.createEnvironment(req.validated);
  res.status(202).json(result);
});

router.get("/environments/:id", (req, res) => {
  const env = environmentManager.getEnvironment(req.params.id);
  res.json({
    environmentId: env.id,
    status: env.status,
    composeProject: env.compose_project,
    workspace: env.workspace,
    services: env.services,
    createdAt: env.created_at,
    updatedAt: env.updated_at
  });
});

router.delete("/environments/:id", async (req, res) => {
  const result = await environmentManager.deleteEnvironment(req.params.id);
  res.json(result);
});

const repositorySchema = z.object({
  url: z.string().url(),
  commit: z.string().min(1)
});

router.post("/environments/:id/repository", validate(repositorySchema), async (req, res) => {
  const result = environmentManager.attachRepository(req.params.id, req.validated);
  res.status(202).json(result);
});

export default router;
