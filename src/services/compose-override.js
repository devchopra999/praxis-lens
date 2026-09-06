import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { workspacePath } from "./environment-manager.js";

function overrideFilePath(environmentId) {
  return path.join(workspacePath(environmentId), "docker-compose.override.yml");
}

function load(environmentId) {
  const file = overrideFilePath(environmentId);
  if (!fs.existsSync(file)) return { services: {} };
  return yaml.load(fs.readFileSync(file, "utf8")) || { services: {} };
}

function save(environmentId, doc) {
  fs.mkdirSync(workspacePath(environmentId), { recursive: true });
  fs.writeFileSync(overrideFilePath(environmentId), yaml.dump(doc));
}

// Adds a bind mount for dev-mode source editing (Section 25); safe to call repeatedly.
export function addVolumeMount(environmentId, serviceName, hostPath, containerPath) {
  const doc = load(environmentId);
  doc.services ||= {};
  doc.services[serviceName] ||= {};
  doc.services[serviceName].volumes ||= [];
  const mount = `${hostPath}:${containerPath}`;
  if (!doc.services[serviceName].volumes.includes(mount)) {
    doc.services[serviceName].volumes.push(mount);
  }
  save(environmentId, doc);
}

// Pins a service to a locally-built image (e.g. the result of building a checked-out branch)
// so the next `compose up` uses it instead of the catalog's default image.
export function setImage(environmentId, serviceName, image) {
  const doc = load(environmentId);
  doc.services ||= {};
  doc.services[serviceName] ||= {};
  doc.services[serviceName].image = image;
  save(environmentId, doc);
}

// Points a service at a per-environment env file so config mutations survive the next restart.
export function addEnvFile(environmentId, serviceName, envFilePath) {
  const doc = load(environmentId);
  doc.services ||= {};
  doc.services[serviceName] ||= {};
  doc.services[serviceName].env_file ||= [];
  if (!doc.services[serviceName].env_file.includes(envFilePath)) {
    doc.services[serviceName].env_file.push(envFilePath);
  }
  save(environmentId, doc);
}

// Declares a whole compose service block that only exists in this environment (e.g. a per-environment database instance).
export function addService(environmentId, serviceName, definition) {
  const doc = load(environmentId);
  doc.services ||= {};
  doc.services[serviceName] = { ...doc.services[serviceName], ...definition };
  save(environmentId, doc);
}

// Sets one environment variable for a service (e.g. wiring DB_HOST to a per-service database
// instance) without clobbering other variables already merged in from the base compose template.
export function setEnvironmentVariable(environmentId, serviceName, key, value) {
  const doc = load(environmentId);
  doc.services ||= {};
  doc.services[serviceName] ||= {};
  doc.services[serviceName].environment ||= {};
  doc.services[serviceName].environment[key] = value;
  save(environmentId, doc);
}
