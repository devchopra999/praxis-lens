import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { findContainer, execInContainer } from "../docker/docker-client.js";
import { appError, ErrorCodes } from "../utils/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_ROOT = path.resolve(__dirname, "../../snapshots");

function availableSnapshots(databaseType) {
  const dir = path.join(SNAPSHOTS_ROOT, databaseType === "mysql" ? "mysql" : "mongodb");
  if (!fs.existsSync(dir)) return [];
  if (databaseType === "mysql") {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql.gz"))
      .map((f) => f.replace(/\.sql\.gz$/, ""));
  }
  return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isDirectory());
}

// True if a snapshot with this exact name exists on disk for the given engine; used to decide
// whether a per-service default database has a same-named fixture to auto-restore.
export function snapshotExists(databaseType, snapshotName) {
  return availableSnapshots(databaseType).includes(snapshotName);
}

// snapshotName is only ever compared against files that actually exist on disk, never interpolated from raw input.
// serviceName defaults to the shared mysql/mongodb container but can target any per-environment database instance.
export async function restore(databaseType, snapshotName, project, serviceName = databaseType === "mysql" ? "mysql" : "mongodb") {
  const available = availableSnapshots(databaseType);
  if (!available.includes(snapshotName)) {
    throw appError(ErrorCodes.DATABASE_RESTORE_FAILED, `Unknown ${databaseType} snapshot "${snapshotName}"`, {
      databaseType,
      snapshotName,
      available,
      hint: "Use one of the names in available, or omit the snapshot to start the database empty."
    });
  }

  const container = await findContainer(project, serviceName);
  if (!container) {
    throw appError(ErrorCodes.DATABASE_RESTORE_FAILED, `${serviceName} container not found`, {
      databaseType,
      hint: "The database container must be started (healthy) before a snapshot can be restored into it."
    });
  }

  try {
    if (databaseType === "mysql") {
      const password = process.env.MYSQL_ROOT_PASSWORD || "praxis";
      await execInContainer(container.Id, [
        "sh",
        "-c",
        `gunzip -c /snapshots/${snapshotName}.sql.gz | mysql -uroot -p${password} app`
      ]);
    } else {
      // fixtures are plain JSON arrays (one file per collection) loaded via mongoimport
      const dir = path.join(SNAPSHOTS_ROOT, "mongodb", snapshotName);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const collection = file.replace(/\.json$/, "");
        await execInContainer(container.Id, [
          "mongoimport",
          "--db",
          "app",
          "--collection",
          collection,
          "--file",
          `/snapshots/${snapshotName}/${file}`,
          "--jsonArray",
          "--drop"
        ]);
      }
    }
  } catch (err) {
    throw appError(ErrorCodes.DATABASE_RESTORE_FAILED, `Failed to restore ${databaseType} snapshot "${snapshotName}"`, {
      databaseType,
      snapshotName,
      cause: String(err.message || err),
      hint: "See cause for the underlying failure (e.g. malformed fixture); check GET .../services/:service/logs for more detail."
    });
  }
}
