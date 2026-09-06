CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  compose_project TEXT NOT NULL,
  workspace TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  error_details TEXT,
  progress TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (environment_id) REFERENCES environments (id)
);

CREATE TABLE IF NOT EXISTS services (
  environment_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  status TEXT NOT NULL,
  container_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (environment_id, service_name),
  FOREIGN KEY (environment_id) REFERENCES environments (id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_environment ON jobs (environment_id);
