-- Keep workspace-removal cascades bounded. SQLite does not automatically index
-- child foreign-key columns, so deleting a graph-heavy workspace can otherwise
-- rescan large edge/reference tables for every parent row.
CREATE INDEX IF NOT EXISTS idx_fk_callback_outbox_workspace_id
    ON callback_outbox(workspace_id);
CREATE INDEX IF NOT EXISTS idx_fk_changesets_workspace_id
    ON changesets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_fk_edges_target_symbol_id
    ON edges(target_symbol_id);
CREATE INDEX IF NOT EXISTS idx_fk_edges_source_symbol_id
    ON edges(source_symbol_id);
CREATE INDEX IF NOT EXISTS idx_fk_graph_file_state_file_id
    ON graph_file_state(file_id);
CREATE INDEX IF NOT EXISTS idx_fk_harness_approvals_requested_execution_id
    ON harness_approvals(requested_execution_id);
CREATE INDEX IF NOT EXISTS idx_fk_harness_approvals_workspace_id
    ON harness_approvals(workspace_id);
CREATE INDEX IF NOT EXISTS idx_fk_harness_runs_conversation_id
    ON harness_runs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_fk_harness_tool_executions_approval_id
    ON harness_tool_executions(approval_id);
CREATE INDEX IF NOT EXISTS idx_fk_memories_workspace_id
    ON memories(workspace_id);
CREATE INDEX IF NOT EXISTS idx_fk_structural_references_source_file_id
    ON structural_references(source_file_id);
CREATE INDEX IF NOT EXISTS idx_fk_symbol_references_target_symbol_id
    ON symbol_references(target_symbol_id);
CREATE INDEX IF NOT EXISTS idx_fk_symbol_references_source_symbol_id
    ON symbol_references(source_symbol_id);
