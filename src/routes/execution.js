import { Router } from "express";
import { z } from "zod";
import { validate } from "../utils/validate.js";
import { requireEnvironment, listProvisionedServices } from "../services/environment-manager.js";
import { findContainer, execInContainer } from "../docker/docker-client.js";
import { appError, AppError, ErrorCodes } from "../utils/errors.js";

const router = Router();

// command must be an argv array (never a shell string) so the AI agent can't smuggle in shell syntax.
const executeSchema = z.object({
  service: z.string().min(1),
  command: z.array(z.string().min(1)).min(1),
  timeout: z.number().int().positive().max(3600).optional()
});

router.post("/environments/:id/execute", validate(executeSchema), async (req, res) => {
  const env = requireEnvironment(req.params.id);
  const { service, command, timeout } = req.validated;
  const timeoutSec = timeout || 300;

  const container = await findContainer(env.compose_project, service);
  if (!container) {
    throw appError(ErrorCodes.SERVICE_NOT_FOUND, `Service "${service}" not found in environment`, {
      service,
      provisionedServices: listProvisionedServices(req.params.id),
      hint: "Check provisionedServices for the correct name, or start it first via POST .../services/:service/start."
    });
  }

  try {
    const result = await execInContainer(container.Id, command, { timeoutSec });
    // GNU coreutils' `timeout` exits 124 on kill; busybox's `timeout` (alpine images) exits 143
    // (128+SIGTERM) instead, so both are treated as a timeout here.
    if (result.exitCode === 124 || result.exitCode === 143) {
      throw appError(ErrorCodes.COMMAND_TIMEOUT, `Command timed out after ${timeoutSec}s`, {
        service,
        command,
        hint: 'Increase the request\'s "timeout" (seconds, max 3600) or run a faster/narrower command.'
      });
    }
    res.json(result);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw appError(ErrorCodes.COMMAND_FAILED, `Failed to execute command in ${service}`, {
      service,
      command,
      cause: String(err.message || err),
      hint: "See cause for the underlying failure; verify the service is running and the command/binary exists in its image."
    });
  }
});

export default router;
