import { findContainer, execInContainer } from "../docker/docker-client.js";
import { getCatalogEntry } from "../config/service-catalog.js";
import { requireEnvironment, isProvisionedService, listProvisionedServices } from "./environment-manager.js";
import { appError, ErrorCodes } from "../utils/errors.js";

// A service is queryable if it's a per-service dedicated "<engine>-<serviceName>" instance or a
// per-environment database provisioned as "<engine>-<name>" (see worker.js provisionDatabases/provisionDefaultDatabase).
export function resolveEngine(serviceName) {
  const catalogType = getCatalogEntry(serviceName)?.healthcheck?.type;
  if (catalogType === "mysql" || catalogType === "mongodb") return catalogType;
  if (serviceName.startsWith("mysql-")) return "mysql";
  if (serviceName.startsWith("mongodb-")) return "mongodb";
  return null;
}

// mysql's tab-separated `--batch` output: first line is column names, one row per line after.
function parseTabular(stdout) {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) return { columns: [], rows: [] };

  const columns = lines[0].split("\t");
  const rows = lines.slice(1).map((line) => {
    const values = line.split("\t");
    return Object.fromEntries(columns.map((col, i) => [col, values[i] === "NULL" ? null : values[i]]));
  });
  return { columns, rows };
}

async function queryMysql(containerId, query) {
  const password = process.env.MYSQL_ROOT_PASSWORD || "praxis";
  const result = await execInContainer(containerId, ["mysql", "-uroot", `-p${password}`, "app", "--batch", "--raw", "-e", query]);
  if (result.exitCode !== 0) {
    throw appError(ErrorCodes.DATABASE_QUERY_FAILED, "MySQL query failed", {
      stderr: result.stderr.trim(),
      hint: "See stderr for the SQL error (e.g. syntax error, unknown table/column) and resubmit a corrected query."
    });
  }
  return parseTabular(result.stdout);
}

async function queryMongo(containerId, query) {
  // print() (not bare eval) so the container's stdout deterministically contains the JSON payload
  // and nothing else, regardless of what the query expression itself returns/logs.
  const script = `print(JSON.stringify(${query}))`;
  const result = await execInContainer(containerId, ["mongosh", "mongodb://127.0.0.1:27017/app", "--quiet", "--eval", script]);
  if (result.exitCode !== 0) {
    throw appError(ErrorCodes.DATABASE_QUERY_FAILED, "MongoDB query failed", {
      stderr: result.stderr.trim(),
      hint: "See stderr for the error and resubmit a corrected query (a JS expression evaluated against `db`, e.g. db.collection.find({}).toArray())."
    });
  }
  try {
    return { result: JSON.parse(result.stdout.trim()) };
  } catch (err) {
    throw appError(ErrorCodes.DATABASE_QUERY_FAILED, "MongoDB query did not return JSON-serializable output", {
      stdout: result.stdout.trim(),
      cause: String(err.message || err),
      hint: "Make sure the query expression's result can be JSON.stringify'd (e.g. call .toArray() on a cursor)."
    });
  }
}

// query is mysql: raw SQL text run via `mysql -e`; mongodb: a JS expression evaluated against `db`
// (e.g. "db.incidents.find({}).toArray()"). Both run as a single argv element to the DB's own CLI,
// never through a shell, so the string can't smuggle in shell syntax.
export async function runQuery(environmentId, serviceName, query) {
  const env = requireEnvironment(environmentId);
  if (!isProvisionedService(environmentId, serviceName)) {
    throw appError(ErrorCodes.SERVICE_NOT_FOUND, `Service "${serviceName}" not found in environment`, {
      service: serviceName,
      provisionedServices: listProvisionedServices(environmentId),
      hint: "Check provisionedServices for the correct name, or start it first via POST .../services/:service/start."
    });
  }

  const engine = resolveEngine(serviceName);
  if (!engine) {
    throw appError(ErrorCodes.UNSUPPORTED_DATABASE_ENGINE, `Service "${serviceName}" is not a queryable database`, {
      service: serviceName,
      validEngines: ["mysql", "mongodb"],
      hint: "Only mysql/mongodb services (shared \"mysql\"/\"mongodb\" or dynamically provisioned \"<engine>-<name>\" instances) can be queried."
    });
  }

  const container = await findContainer(env.compose_project, serviceName);
  if (!container) {
    throw appError(ErrorCodes.SERVICE_NOT_FOUND, `Service "${serviceName}" not found in environment`, {
      service: serviceName,
      provisionedServices: listProvisionedServices(environmentId),
      hint: "Check provisionedServices for the correct name, or start it first via POST .../services/:service/start."
    });
  }

  const payload = engine === "mysql" ? await queryMysql(container.Id, query) : await queryMongo(container.Id, query);
  return { service: serviceName, engine, ...payload };
}
