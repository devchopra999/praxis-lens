-- Schema from distributed-payments (prerit-deviloper/distributed-payments), copied verbatim for auto-restore.
CREATE DATABASE IF NOT EXISTS payment_db;
USE payment_db;

CREATE TABLE payments (
  id CHAR(36) PRIMARY KEY,
  order_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  amount INT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'ETB',
  gateway ENUM('sandbox','stripe','chapa') NOT NULL,
  status ENUM('PENDING','SUCCESS','FAILED') NOT NULL DEFAULT 'PENDING',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE transactions (
  id CHAR(36) PRIMARY KEY,
  payment_id CHAR(36) NOT NULL,
  gateway_transaction_id VARCHAR(255),
  status ENUM('PENDING','SUCCESS','FAILED') NOT NULL,
  response JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  CONSTRAINT fk_transactions_payment FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE
);
