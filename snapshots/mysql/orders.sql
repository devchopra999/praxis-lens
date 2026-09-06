-- Schema from distributed-orders (prerit-deviloper/distributed-orders), copied verbatim for auto-restore.
CREATE DATABASE IF NOT EXISTS order_db;
USE order_db;

CREATE TABLE restaurants (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(150) NOT NULL UNIQUE,
  location VARCHAR(255),
  owner_id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE items (
  id CHAR(36) PRIMARY KEY,
  restaurant_id CHAR(36) NOT NULL,
  name VARCHAR(150) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  available BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  CONSTRAINT fk_items_restaurant FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE TABLE orders (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  restaurant_id CHAR(36) NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  status ENUM('PENDING','PREPARING','READY','COMPLETED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  is_paid BOOLEAN NOT NULL DEFAULT FALSE,
  driver_id CHAR(36),
  delivery_status ENUM('PENDING','PICKED_UP','ON_THE_WAY','DELIVERED'),
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  CONSTRAINT fk_orders_restaurant FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
);

CREATE TABLE order_items (
  id CHAR(36) PRIMARY KEY,
  order_id CHAR(36) NOT NULL,
  item_id CHAR(36) NOT NULL,
  quantity INT NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);
