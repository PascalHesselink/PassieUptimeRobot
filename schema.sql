CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS target_urls (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  url TEXT NOT NULL,
  url_hash CHAR(64) AS (SHA2(url,256)) STORED UNIQUE,
  enabled TINYINT NOT NULL DEFAULT 1,
  refresh_seconds INT NOT NULL DEFAULT 60,
  timeout_seconds INT NOT NULL DEFAULT 30,
  ssl_expiration_days INT NOT NULL DEFAULT 14,
  last_checked_unix BIGINT,
  last_up DATETIME NULL,
  last_down DATETIME NULL,
  INDEX idx_target_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS target_url_user (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  target_url_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  enabled TINYINT NOT NULL DEFAULT 1,
  UNIQUE KEY uq_target_user (target_url_id, user_id),
  FOREIGN KEY (target_url_id) REFERENCES target_urls(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS target_url_stats (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  target_url_id BIGINT NOT NULL,
  is_up TINYINT NOT NULL,
  checked_at DATETIME NOT NULL,
  checked_at_unix BIGINT,
  response_time_ms INT,
  status_code INT,
  response MEDIUMTEXT,
  FOREIGN KEY (target_url_id) REFERENCES target_urls(id) ON DELETE CASCADE,
  INDEX idx_stats_target_time (target_url_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS target_url_ssl (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  target_url_id BIGINT NOT NULL,
  is_valid TINYINT NOT NULL,
  valid_from DATETIME NULL,
  valid_to DATETIME NULL,
  issuer_cn TEXT,
  subject_cn TEXT,
  fingerprint256 TEXT,
  days_left INT,
  created_at DATETIME NOT NULL,
  last_checked_at DATETIME NOT NULL,
  FOREIGN KEY (target_url_id) REFERENCES target_urls(id) ON DELETE CASCADE,
  INDEX idx_ssl_target_created (target_url_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  target_url_id BIGINT NOT NULL,
  change_type VARCHAR(255) NOT NULL,
  change_key VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uq_notification (user_id, target_url_id, change_type, change_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (target_url_id) REFERENCES target_urls(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
