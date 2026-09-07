-- Schema from fintech-notifications (devchopra999/fintech-notifications), copied verbatim for auto-restore.
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

-- Mock data seeded on every environment start (auto-restored via provisionDefaultDatabase).
-- user ids intentionally match the ids seeded in snapshots/mysql/auth.sql.
INSERT INTO notifications (id, user_id, event_type, message, channel, status, is_read, data, created_at, updated_at) VALUES
('ffffffff-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'PAYMENT_SUCCESS', 'Your payment of $200.00 was successful.', 'IN_APP', 'SENT', FALSE, JSON_OBJECT('paymentId', 'dddddddd-0000-0000-0000-000000000001'), '2026-08-10 13:55:03', '2026-08-10 13:55:03'),
('ffffffff-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'PAYMENT_PENDING', 'Your payment of $50.00 is pending confirmation.', 'EMAIL', 'SENT', FALSE, JSON_OBJECT('paymentId', 'dddddddd-0000-0000-0000-000000000002'), '2026-08-11 08:55:01', '2026-08-11 08:55:01'),
('ffffffff-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333', 'PAYMENT_FAILED', 'Your payment of $750.00 failed: insufficient funds.', 'SMS', 'FAILED', FALSE, JSON_OBJECT('paymentId', 'dddddddd-0000-0000-0000-000000000003'), '2026-08-12 16:15:05', '2026-08-12 16:15:05'),
('ffffffff-0000-0000-0000-000000000004', '44444444-4444-4444-4444-444444444444', 'ACCOUNT_CREATED', 'Welcome to the platform!', 'IN_APP', 'SENT', TRUE, NULL, '2026-08-04 12:50:01', '2026-08-04 12:50:01');
