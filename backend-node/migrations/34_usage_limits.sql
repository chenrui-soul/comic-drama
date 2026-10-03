CREATE TABLE IF NOT EXISTS daily_request_usage (
  organization_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, day)
);
