-- Schema from fintech-payments (devchopra999/fintech-payments), copied verbatim for auto-restore.
CREATE DATABASE IF NOT EXISTS payment_db;
USE payment_db;

CREATE TABLE payments (
  id CHAR(36) PRIMARY KEY,
  wallet_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  amount BIGINT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  gateway VARCHAR(50) NOT NULL DEFAULT 'nexpay',
  status ENUM('PENDING','SUCCESS','FAILED') NOT NULL DEFAULT 'PENDING',
  reference VARCHAR(255) NOT NULL UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE transactions (
  id CHAR(36) PRIMARY KEY,
  payment_id CHAR(36) NOT NULL,
  gateway_transaction_id VARCHAR(255),
  status ENUM('PENDING','SUCCESS','FAILED') NOT NULL,
  response JSON,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_transactions_payment (payment_id)
);

-- Mock data seeded on every environment start (auto-restored via provisionDefaultDatabase).
-- wallet/user ids intentionally match the ids seeded in snapshots/mysql/auth.sql & ledger.sql.
INSERT INTO payments (id, wallet_id, user_id, amount, currency, gateway, status, reference, created_at, updated_at) VALUES
('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 20000, 'USD', 'nexpay', 'SUCCESS', 'REF-SEED-1001', '2026-08-10 13:55:00', '2026-08-10 13:55:02'),
('dddddddd-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 5000, 'USD', 'nexpay', 'PENDING', 'REF-SEED-1002', '2026-08-11 08:55:00', '2026-08-11 08:55:00'),
('dddddddd-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333', 75000, 'USD', 'stripe', 'FAILED', 'REF-SEED-1003', '2026-08-12 16:15:00', '2026-08-12 16:15:04');

INSERT INTO transactions (id, payment_id, gateway_transaction_id, status, response, created_at, updated_at) VALUES
('eeeeeeee-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'ntx_seed_001', 'SUCCESS', JSON_OBJECT('code', '00', 'message', 'Approved'), '2026-08-10 13:55:02', '2026-08-10 13:55:02'),
('eeeeeeee-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000002', 'ntx_seed_002', 'PENDING', JSON_OBJECT('code', '01', 'message', 'Awaiting confirmation'), '2026-08-11 08:55:00', '2026-08-11 08:55:00'),
('eeeeeeee-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000003', NULL, 'FAILED', JSON_OBJECT('code', '05', 'message', 'Insufficient funds'), '2026-08-12 16:15:04', '2026-08-12 16:15:04');
