-- New tasks snapshot the complete reviewable working-tree delta so a task can
-- safely begin on pre-existing local edits while still failing closed on drift.
-- NULL preserves the legacy clean-tree contract for tasks created before v26.
ALTER TABLE tasks ADD COLUMN base_worktree_sha256 TEXT;
