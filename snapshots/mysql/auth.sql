-- Schema from fintech-auth (devchopra999/fintech-auth), copied verbatim for auto-restore.
CREATE DATABASE IF NOT EXISTS auth_db;
USE auth_db;

CREATE TABLE users (
  id CHAR(36) PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  role ENUM('CUSTOMER','MERCHANT','ADMIN') NOT NULL DEFAULT 'CUSTOMER',
  kyc_status ENUM('PENDING','VERIFIED','REJECTED') NOT NULL DEFAULT 'PENDING',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Mock data seeded on every environment start (auto-restored via provisionDefaultDatabase).
-- password_hash for all seed users is bcrypt("Password123!", 10) - usable for demo logins.
INSERT INTO users (id, email, password_hash, full_name, role, kyc_status, created_at, updated_at) VALUES
('11111111-1111-1111-1111-111111111111', 'alice@example.com', '$2b$10$8ayudVm319LWaAFs5mAgFOvxPurJfb3HACFgJiHEnbptea67A2YG2', 'Alice Anderson', 'CUSTOMER', 'VERIFIED', '2026-08-01 09:00:00', '2026-08-01 09:00:00'),
('22222222-2222-2222-2222-222222222222', 'bob@example.com', '$2b$10$8ayudVm319LWaAFs5mAgFOvxPurJfb3HACFgJiHEnbptea67A2YG2', 'Bob Baker', 'CUSTOMER', 'VERIFIED', '2026-08-02 10:15:00', '2026-08-02 10:15:00'),
('33333333-3333-3333-3333-333333333333', 'carol.merchant@example.com', '$2b$10$8ayudVm319LWaAFs5mAgFOvxPurJfb3HACFgJiHEnbptea67A2YG2', 'Carol Chen', 'MERCHANT', 'VERIFIED', '2026-08-03 11:30:00', '2026-08-03 11:30:00'),
('44444444-4444-4444-4444-444444444444', 'dave@example.com', '$2b$10$8ayudVm319LWaAFs5mAgFOvxPurJfb3HACFgJiHEnbptea67A2YG2', 'Dave Diaz', 'CUSTOMER', 'PENDING', '2026-08-04 12:45:00', '2026-08-04 12:45:00');
