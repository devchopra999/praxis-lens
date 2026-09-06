import { Router } from "express";
import { z } from "zod";
import { validate } from "../utils/validate.js";
import { requireEnvironment, isProvisionedService, listProvisionedServices } from "../services/environment-manager.js";
import { captureMetrics, listRunningServices } from "../services/metrics-manager.js";
import { appError, ErrorCodes } from "../utils/errors.js";

const router = Router();

// Bounded so one request can't block indefinitely or hammer the docker daemon.
const metricsQuerySchema = z.object({
  duration: z.coerce.number().int().min(0).max(120).optional().default(0),
  interval: z.coerce.number().int().min(1).max(30).optional().default(2),
  services: z.string().optional()
});

// Single service: GET .../services/edi/metrics?duration=20&interval=5
router.get("/environments/:id/services/:service/metrics", validate(metricsQuerySchema, "query"), async (req, res) => {
  const env = requireEnvironment(req.params.id);
  const { service } = req.params;
  if (!isProvisionedService(req.params.id, service)) {
    throw appError(ErrorCodes.INVALID_SERVICE, `Unknown service "${service}"`, {
      service,
      provisionedServices: listProvisionedServices(req.params.id),
      hint: "Check provisionedServices for the correct name, or start it first via POST .../services/:service/start."
    });
  }

  const { duration, interval } = req.validatedQuery;
  const series = await captureMetrics(env.compose_project, [service], { durationSec: duration, intervalSec: interval });
  res.json({ service, durationSec: duration, intervalSec: interval, samples: series[service] });
});

// Whole environment in one call, so the agent can directly compare services (e.g. EDI vs its DB)
// over the same time window instead of stitching together separate per-service polls itself.
// GET .../metrics?services=edi,mysql-edi&duration=20&interval=5 (services defaults to everything running)
router.get("/environments/:id/metrics", validate(metricsQuerySchema, "query"), async (req, res) => {
  const env = requireEnvironment(req.params.id);
  const { duration, interval, services } = req.validatedQuery;

  let serviceNames;
  if (services) {
    serviceNames = services
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const name of serviceNames) {
      if (!isProvisionedService(req.params.id, name)) {
        throw appError(ErrorCodes.INVALID_SERVICE, `Unknown service "${name}"`, {
          service: name,
          provisionedServices: listProvisionedServices(req.params.id),
          hint: "Check provisionedServices for the correct name, or start it first via POST .../services/:service/start."
        });
      }
    }
  } else {
    serviceNames = await listRunningServices(env.compose_project);
  }

  if (!serviceNames.length) {
    throw appError(ErrorCodes.SERVICE_NOT_FOUND, "No running services found in this environment", {
      provisionedServices: listProvisionedServices(req.params.id),
      hint: "Start at least one service first via POST /environments/:id/services/:service/start."
    });
  }

  const series = await captureMetrics(env.compose_project, serviceNames, { durationSec: duration, intervalSec: interval });
  res.json({ environmentId: req.params.id, durationSec: duration, intervalSec: interval, services: series });
});

export default router;
