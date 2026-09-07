-- Schema from fintech-ledger (devchopra999/fintech-ledger), copied verbatim for auto-restore.
CREATE DATABASE IF NOT EXISTS ledger_db;
USE ledger_db;

CREATE TABLE wallets (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  balance BIGINT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE transfers (
  id CHAR(36) PRIMARY KEY,
  from_wallet_id CHAR(36) NOT NULL,
  to_wallet_id CHAR(36) NOT NULL,
  amount BIGINT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  status ENUM('PENDING','COMPLETED','FAILED') NOT NULL DEFAULT 'PENDING',
  idempotency_key VARCHAR(255) UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE ledger_entries (
  id CHAR(36) PRIMARY KEY,
  wallet_id CHAR(36) NOT NULL,
  transfer_id CHAR(36),
  direction ENUM('DEBIT','CREDIT') NOT NULL,
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ledger_entries_wallet (wallet_id)
);

-- Mock data seeded on every environment start (auto-restored via provisionDefaultDatabase).
-- wallet/user ids intentionally match the ids seeded in snapshots/mysql/auth.sql & payments.sql.
INSERT INTO wallets (id, user_id, currency, balance, created_at, updated_at) VALUES
('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'USD', 490000, '2026-08-01 09:05:00', '2026-08-10 14:00:00'),
('aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'USD', 260000, '2026-08-02 10:20:00', '2026-08-10 14:00:00'),
('aaaaaaaa-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333', 'USD', 1000000, '2026-08-03 11:35:00', '2026-08-03 11:35:00'),
('aaaaaaaa-0000-0000-0000-000000000004', '44444444-4444-4444-4444-444444444444', 'USD', 0, '2026-08-04 12:50:00', '2026-08-04 12:50:00');

INSERT INTO transfers (id, from_wallet_id, to_wallet_id, amount, currency, status, idempotency_key, created_at, updated_at) VALUES
('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 10000, 'USD', 'COMPLETED', 'seed-transfer-1', '2026-08-10 14:00:00', '2026-08-10 14:00:05'),
('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003', 5000, 'USD', 'PENDING', 'seed-transfer-2', '2026-08-11 09:00:00', '2026-08-11 09:00:00'),
('bbbbbbbb-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000004', 2500, 'USD', 'FAILED', 'seed-transfer-3', '2026-08-12 16:20:00', '2026-08-12 16:20:03');

INSERT INTO ledger_entries (id, wallet_id, transfer_id, direction, amount, balance_after, created_at) VALUES
('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'DEBIT', 10000, 490000, '2026-08-10 14:00:05'),
('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', 'CREDIT', 10000, 260000, '2026-08-10 14:00:05');
