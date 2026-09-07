import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dataDir = process.env.PRAXIS_DATA_DIR || path.resolve(__dirname, "../../data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "praxis.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

// schema.sql's CREATE TABLE IF NOT EXISTS won't add new columns to an already-existing database
// file, so newly added columns need an explicit guarded migration here.
const jobColumns = db.prepare("PRAGMA table_info(jobs)").all();
if (!jobColumns.some((col) => col.name === "error_details")) {
  db.exec("ALTER TABLE jobs ADD COLUMN error_details TEXT");
}
if (!jobColumns.some((col) => col.name === "result")) {
  db.exec("ALTER TABLE jobs ADD COLUMN result TEXT");
}

export default db;
