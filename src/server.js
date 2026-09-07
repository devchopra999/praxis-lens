import "dotenv/config";
import express from "express";
import pinoHttp from "pino-http";
import logger from "./utils/logger.js";
import { AppError } from "./utils/errors.js";

import environmentsRouter from "./routes/environments.js";
import servicesRouter from "./routes/services.js";
import jobsRouter from "./routes/jobs.js";
import executionRouter from "./routes/execution.js";
import logsRouter from "./routes/logs.js";
import configRouter from "./routes/config.js";
import metricsRouter from "./routes/metrics.js";
import databaseRouter from "./routes/database.js";
import codeRouter from "./routes/code.js";
import orchestratorRouter from "./routes/orchestrator.js";
import loadTestRouter from "./routes/load-test.js";
import requestRouter from "./routes/request.js";

const app = express();

app.use(express.json());

// Frontends poll job status frequently; logging every poll at the same level as real
// mutating requests drowns out everything else, so those requests are excluded here.
const POLLED_ROUTES = [{ method: "GET", pattern: /^\/jobs\/[^/]+$/ }];
const isPolledRequest = (req) =>
  POLLED_ROUTES.some(({ method, pattern }) => req.method === method && pattern.test(req.url.split("?")[0]));

// Keys never logged in plain text even though schemas accept them (e.g. secrets endpoint's raw value).
const REDACTED_BODY_KEYS = new Set(["value", "password", "token", "secret"]);
function sanitizeBody(body) {
  if (!body || typeof body !== "object") return undefined;
  const keys = Object.keys(body);
  if (keys.length === 0) return undefined;
  const sanitized = {};
  for (const key of keys) {
    sanitized[key] = REDACTED_BODY_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : body[key];
  }
  return sanitized;
}

app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: isPolledRequest },
    customProps: (req) => ({ body: sanitizeBody(req.body) }),
    customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
    customErrorMessage: (req, res, err) => `${req.method} ${req.url} -> ${res.statusCode} (${err.message})`,
    serializers: {
      req: (req) => ({ method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode })
    }
  })
);

app.use(environmentsRouter);
app.use(servicesRouter);
app.use(jobsRouter);
app.use(executionRouter);
app.use(logsRouter);
app.use(configRouter);
app.use(metricsRouter);
app.use(databaseRouter);
app.use(codeRouter);
app.use(orchestratorRouter);
app.use(loadTestRouter);
app.use(requestRouter);

app.use((req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    logger.warn({ err: { code: err.code, message: err.message }, method: req.method, url: req.url, body: sanitizeBody(req.body) }, "request failed");
    return res.status(err.statusCode).json(err.toJSON());
  }
  logger.error({ err, method: req.method, url: req.url }, "unhandled error");
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } });
});

if (process.env.NODE_ENV !== "test") {
  const port = process.env.PORT || 3000;
  app.listen(port, () => logger.info(`praxis-execution listening on ${port}`));
}

export default app;
