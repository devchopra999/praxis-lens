-- Schema from distributed-notifications (prerit-deviloper/distributed-notifications), copied verbatim for auto-restore.
CREATE DATABASE IF NOT EXISTS notification_db;
USE notification_db;

CREATE TABLE notifications (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36),
  event_type VARCHAR(100) NOT NULL,
  message TEXT NOT NULL,
  channel ENUM('IN_APP','EMAIL','SMS') NOT NULL DEFAULT 'IN_APP',
  status ENUM('PENDING','SENT','FAILED') NOT NULL DEFAULT 'SENT',
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  data JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  INDEX idx_notifications_user_read (user_id, is_read)
);
