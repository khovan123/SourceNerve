CREATE TABLE IF NOT EXISTS desktop_installations (
    installation_id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    tunnel_id TEXT NOT NULL,
    dns_record_id TEXT NOT NULL,
    hostname TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_desktop_installations_subject
    ON desktop_installations(subject, status);
