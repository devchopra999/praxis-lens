-- Minimal baseline fixture representing a realistic incident state for local debugging.
CREATE TABLE IF NOT EXISTS users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active'
);

INSERT INTO users (email, status) VALUES
  ('alice@example.com', 'active'),
  ('bob@example.com', 'suspended');

CREATE TABLE IF NOT EXISTS transactions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  amount_cents INT NOT NULL,
  status VARCHAR(32) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

INSERT INTO transactions (user_id, amount_cents, status) VALUES
  (1, 10000, 'settled'),
  (2, 5000, 'failed');
