import { Router } from "express";
import { z } from "zod";
import { validate } from "../utils/validate.js";
import { requireEnvironment, listProvisionedServices } from "../services/environment-manager.js";
import { findContainer, getLogs } from "../docker/docker-client.js";
import { appError, ErrorCodes } from "../utils/errors.js";

const router = Router();

const logsQuerySchema = z.object({
  tail: z.coerce.number().int().positive().max(5000).optional(),
  since: z.string().optional()
});

router.get("/environments/:id/services/:service/logs", validate(logsQuerySchema, "query"), async (req, res) => {
  const env = requireEnvironment(req.params.id);
  const container = await findContainer(env.compose_project, req.params.service);
  if (!container) {
    throw appError(ErrorCodes.SERVICE_NOT_FOUND, `Service "${req.params.service}" not found in environment`, {
      service: req.params.service,
      provisionedServices: listProvisionedServices(req.params.id),
      hint: "Check provisionedServices for the correct name, or start it first via POST .../services/:service/start."
    });
  }
  const { tail, since } = req.validatedQuery;
  const logs = await getLogs(container.Id, { tail: tail || 200, since });
  res.json({ service: req.params.service, logs });
});

export default router;
