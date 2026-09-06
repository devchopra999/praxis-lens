import fs from "node:fs";
import path from "node:path";
import { workspacePath, requireEnvironment } from "./environment-manager.js";
import { addEnvFile } from "./compose-override.js";

function envFilePath(environmentId, serviceName) {
  const dir = path.join(workspacePath(environmentId), "config");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${serviceName}.env`);
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function writeEnvFile(file, values) {
  const body = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(file, `${body}\n`);
}

// Writes to a per-environment/per-service env file wired in via docker-compose.override.yml;
// takes effect on the next restart of that service and never touches shared configuration.
export function setConfig(environmentId, serviceName, key, value) {
  requireEnvironment(environmentId);
  const file = envFilePath(environmentId, serviceName);
  const current = readEnvFile(file);
  current[key] = value;
  writeEnvFile(file, current);
  addEnvFile(environmentId, serviceName, file);
  return current;
}

// Returns the full parsed contents of a service's .env file (empty object if none set yet).
export function getEnv(environmentId, serviceName) {
  requireEnvironment(environmentId);
  return readEnvFile(envFilePath(environmentId, serviceName));
}

// Merges the given keys into the existing .env file (patch, not replace); takes effect on the
// next restart of that service.
export function updateEnv(environmentId, serviceName, patch) {
  requireEnvironment(environmentId);
  const file = envFilePath(environmentId, serviceName);
  const current = readEnvFile(file);
  for (const [key, value] of Object.entries(patch)) {
    current[key] = value;
  }
  writeEnvFile(file, current);
  addEnvFile(environmentId, serviceName, file);
  return current;
}
