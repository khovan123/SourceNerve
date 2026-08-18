CREATE TABLE mutation_leases (
    resource_key TEXT PRIMARY KEY,
    owner_instance_id TEXT,
    lease_id TEXT,
    fencing_token INTEGER NOT NULL DEFAULT 0 CHECK(fencing_token >= 0),
    acquired_at INTEGER,
    renewed_at INTEGER,
    expires_at INTEGER NOT NULL DEFAULT 0,
    CHECK((owner_instance_id IS NULL AND lease_id IS NULL) OR (owner_instance_id IS NOT NULL AND lease_id IS NOT NULL))
);

CREATE INDEX idx_mutation_leases_active
    ON mutation_leases(expires_at)
    WHERE lease_id IS NOT NULL;
