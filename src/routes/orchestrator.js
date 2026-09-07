import { Router } from "express";
import { z } from "zod";
import { validate } from "../utils/validate.js";
import { requireEnvironment } from "../services/environment-manager.js";
import * as orchestratorManager from "../services/orchestrator-manager.js";
import * as headerInjectorManager from "../services/header-injector-manager.js";
import { appError, ErrorCodes } from "../utils/errors.js";

const router = Router();

// RFC 1123 hostname; DNS labels 1-63 chars, alphanumeric + hyphen, no leading/trailing hyphen.
const HOSTNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
// Kept strict (no quotes/semicolons/newlines) since this value is written straight into the
// generated nginx config as a proxy header.
const LOGICAL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

// Routes are keyed by (sourceService, destinationService): `sourceService` may also be the literal
// wildcard "*" (any caller), `destinationService` never is - reject anything else before it
// reaches the orchestrator/nginx config.
router.param("sourceService", (req, res, next, value) => {
  if (value === "*" || LOGICAL_NAME_RE.test(value)) return next();
  next(appError(ErrorCodes.VALIDATION_ERROR, `"${value}" is not a valid "sourceService" - must be "*" or alphanumeric/underscore/hyphen`));
});

router.param("destinationService", (req, res, next, value) => {
  if (LOGICAL_NAME_RE.test(value)) return next();
  next(appError(ErrorCodes.VALIDATION_ERROR, `"${value}" is not a valid "destinationService" - must be alphanumeric/underscore/hyphen`));
});

router.get("/environments/:id/orchestrator", async (req, res) => {
  const env = requireEnvironment(req.params.id);
  const info = await orchestratorManager.getOrchestratorInfo(env.compose_project);
  res.json({ service: "orchestrator", ...info });
});

router.get("/environments/:id/orchestrator/routes", async (req, res) => {
  const env = requireEnvironment(req.params.id);
  const routes = await orchestratorManager.listRoutes(env.compose_project);
  res.json(routes);
});

router.get("/environments/:id/orchestrator/routes/:sourceService/:destinationService", async (req, res) => {
  const env = requireEnvironment(req.params.id);
  const route = await orchestratorManager.getRoute(env.compose_project, req.params.sourceService, req.params.destinationService);
  res.json(route);
});

// `pointsTo` is a catalog service name (e.g. "mock-server"), never a raw URL - orchestrator-manager
// resolves it, so callers only ever need to know the logical service name they want to redirect to.
const putRouteSchema = z.object({ pointsTo: z.string().min(1) });

router.put("/environments/:id/orchestrator/routes/:sourceService/:destinationService", validate(putRouteSchema), async (req, res) => {
  const env = requireEnvironment(req.params.id);
  const route = await orchestratorManager.putRoute(env.compose_project, req.params.sourceService, req.params.destinationService, req.validated.pointsTo);
  res.json(route);
});

const bulkRoutesSchema = z.object({
  routes: z
    .array(z.object({ sourceService: z.string().min(1), destinationService: z.string().min(1), pointsTo: z.string().min(1) }))
    .min(1, "routes must have at least one entry")
});

router.post("/environments/:id/orchestrator/routes/bulk", validate(bulkRoutesSchema), async (req, res) => {
  const env = requireEnvironment(req.params.id);
  const result = await orchestratorManager.bulkRegisterRoutes(env.compose_project, req.validated.routes);
  res.json(result);
});

router.delete("/environments/:id/orchestrator/routes/:sourceService/:destinationService", async (req, res) => {
  const env = requireEnvironment(req.params.id);
  await orchestratorManager.deleteRoute(env.compose_project, req.params.sourceService, req.params.destinationService);
  res.status(204).end();
});

router.get("/environments/:id/orchestrator/aliases", (req, res) => {
  requireEnvironment(req.params.id);
  res.json({ aliases: headerInjectorManager.getAliases(req.params.id) });
});

const updateAliasesSchema = z.object({
  aliases: z
    .record(z.string().regex(HOSTNAME_RE, "must be a valid hostname"), z.string().regex(LOGICAL_NAME_RE, "must be alphanumeric/underscore/hyphen"))
    .refine((a) => Object.keys(a).length > 0, "aliases must have at least one entry")
});

router.put("/environments/:id/orchestrator/aliases", validate(updateAliasesSchema), async (req, res) => {
  const env = requireEnvironment(req.params.id);
  const aliases = await headerInjectorManager.updateAliases(req.params.id, env.compose_project, req.validated.aliases);
  res.json({
    aliases,
    message:
      "services will resolve these hostnames to the header injector on their next new connection; already-open connections are unaffected"
  });
});

router.delete("/environments/:id/orchestrator/aliases/:host", async (req, res) => {
  const env = requireEnvironment(req.params.id);
  const aliases = await headerInjectorManager.removeAlias(req.params.id, env.compose_project, req.params.host);
  res.json({ aliases });
});

export default router;
