CREATE TABLE IF NOT EXISTS onboarding_requests (
  id TEXT PRIMARY KEY NOT NULL,
  challenge_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('unlocked', 'device_received', 'building', 'ready', 'failed', 'expired')),
  cms_payload BLOB,
  product TEXT,
  version TEXT,
  install_url TEXT,
  error_code TEXT,
  github_run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  cms_claimed_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS onboarding_requests_state_idx
  ON onboarding_requests (state);

CREATE INDEX IF NOT EXISTS onboarding_requests_expiry_idx
  ON onboarding_requests (expires_at);
