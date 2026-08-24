-- Backfill cached MCP extension tools discovered before SourceNerve gained its
-- own conservative name-based classification resolver. Future discoveries are
-- classified in Rust before persistence; this migration only repairs existing
-- cached rows during upgrade.
--
-- Mutation signals win over read-looking prefixes. Unknown names remain as-is
-- (NULL/false) so the gateway continues to route them conservatively.

WITH classified AS (
    SELECT
        rowid AS rid,
        lower(original_name) AS name,
        '_' || replace(replace(lower(original_name), '-', '_'), '.', '_') || '_' AS tokens
    FROM mcp_extension_tools
)
UPDATE mcp_extension_tools
SET
    read_only = 0,
    destructive = CASE
        WHEN rowid IN (
            SELECT rid
            FROM classified
            WHERE instr(tokens, '_delete_') > 0
               OR instr(tokens, '_remove_') > 0
               OR instr(tokens, '_clear_') > 0
               OR instr(tokens, '_reset_') > 0
               OR instr(tokens, '_drop_') > 0
               OR instr(tokens, '_truncate_') > 0
               OR instr(tokens, '_uninstall_') > 0
        ) THEN 1
        ELSE destructive
    END
WHERE rowid IN (
    SELECT rid
    FROM classified
    WHERE
           instr(tokens, '_add_') > 0
        OR instr(tokens, '_apply_') > 0
        OR instr(tokens, '_approve_') > 0
        OR instr(tokens, '_clear_') > 0
        OR instr(tokens, '_commit_') > 0
        OR instr(tokens, '_copy_') > 0
        OR instr(tokens, '_create_') > 0
        OR instr(tokens, '_delete_') > 0
        OR instr(tokens, '_deploy_') > 0
        OR instr(tokens, '_disable_') > 0
        OR instr(tokens, '_drop_') > 0
        OR instr(tokens, '_edit_') > 0
        OR instr(tokens, '_enable_') > 0
        OR instr(tokens, '_execute_') > 0
        OR instr(tokens, '_import_') > 0
        OR instr(tokens, '_ingest_') > 0
        OR instr(tokens, '_insert_') > 0
        OR instr(tokens, '_install_') > 0
        OR instr(tokens, '_manage_') > 0
        OR instr(tokens, '_merge_') > 0
        OR instr(tokens, '_move_') > 0
        OR instr(tokens, '_mutate_') > 0
        OR instr(tokens, '_patch_') > 0
        OR instr(tokens, '_publish_') > 0
        OR instr(tokens, '_push_') > 0
        OR instr(tokens, '_remove_') > 0
        OR instr(tokens, '_rename_') > 0
        OR instr(tokens, '_reset_') > 0
        OR instr(tokens, '_revoke_') > 0
        OR instr(tokens, '_save_') > 0
        OR instr(tokens, '_send_') > 0
        OR instr(tokens, '_set_') > 0
        OR instr(tokens, '_start_') > 0
        OR instr(tokens, '_stop_') > 0
        OR instr(tokens, '_store_') > 0
        OR instr(tokens, '_truncate_') > 0
        OR instr(tokens, '_uninstall_') > 0
        OR instr(tokens, '_update_') > 0
        OR instr(tokens, '_upload_') > 0
        OR instr(tokens, '_upsert_') > 0
        OR instr(tokens, '_write_') > 0
        OR name LIKE 'refresh%'
        OR name LIKE 'restart%'
        OR name LIKE 'run%'
        OR name LIKE 'sync%'
        OR ((name LIKE 'index_%' OR name LIKE 'reindex_%') AND name NOT LIKE '%status')
);

WITH classified AS (
    SELECT
        rowid AS rid,
        lower(original_name) AS name,
        '_' || replace(replace(lower(original_name), '-', '_'), '.', '_') || '_' AS tokens
    FROM mcp_extension_tools
)
UPDATE mcp_extension_tools
SET
    read_only = 1,
    destructive = 0
WHERE rowid IN (
    SELECT rid
    FROM classified
    WHERE (
           name LIKE 'get_%'
        OR name LIKE 'list_%'
        OR name LIKE 'search_%'
        OR name LIKE 'find_%'
        OR name LIKE 'query_%'
        OR name LIKE 'check_%'
        OR name LIKE 'detect_%'
        OR name LIKE 'trace_%'
        OR name LIKE 'inspect_%'
        OR name LIKE 'describe_%'
        OR name LIKE 'read_%'
        OR name LIKE 'lookup_%'
        OR name LIKE 'fetch_%'
        OR name LIKE 'resolve_%'
        OR name LIKE 'explain_%'
        OR name LIKE 'summarize_%'
        OR name LIKE 'preview_%'
        OR name LIKE 'diff_%'
        OR name LIKE 'status_%'
        OR name LIKE 'show_%'
        OR name LIKE 'view_%'
        OR name LIKE 'count_%'
        OR name LIKE 'calculate_%'
        OR name LIKE 'analyze_%'
        OR name LIKE 'analyse_%'
        OR name LIKE '%_status'
    )
    AND NOT (
           instr(tokens, '_add_') > 0
        OR instr(tokens, '_apply_') > 0
        OR instr(tokens, '_approve_') > 0
        OR instr(tokens, '_clear_') > 0
        OR instr(tokens, '_commit_') > 0
        OR instr(tokens, '_copy_') > 0
        OR instr(tokens, '_create_') > 0
        OR instr(tokens, '_delete_') > 0
        OR instr(tokens, '_deploy_') > 0
        OR instr(tokens, '_disable_') > 0
        OR instr(tokens, '_drop_') > 0
        OR instr(tokens, '_edit_') > 0
        OR instr(tokens, '_enable_') > 0
        OR instr(tokens, '_execute_') > 0
        OR instr(tokens, '_import_') > 0
        OR instr(tokens, '_ingest_') > 0
        OR instr(tokens, '_insert_') > 0
        OR instr(tokens, '_install_') > 0
        OR instr(tokens, '_manage_') > 0
        OR instr(tokens, '_merge_') > 0
        OR instr(tokens, '_move_') > 0
        OR instr(tokens, '_mutate_') > 0
        OR instr(tokens, '_patch_') > 0
        OR instr(tokens, '_publish_') > 0
        OR instr(tokens, '_push_') > 0
        OR instr(tokens, '_remove_') > 0
        OR instr(tokens, '_rename_') > 0
        OR instr(tokens, '_reset_') > 0
        OR instr(tokens, '_revoke_') > 0
        OR instr(tokens, '_save_') > 0
        OR instr(tokens, '_send_') > 0
        OR instr(tokens, '_set_') > 0
        OR instr(tokens, '_start_') > 0
        OR instr(tokens, '_stop_') > 0
        OR instr(tokens, '_store_') > 0
        OR instr(tokens, '_truncate_') > 0
        OR instr(tokens, '_uninstall_') > 0
        OR instr(tokens, '_update_') > 0
        OR instr(tokens, '_upload_') > 0
        OR instr(tokens, '_upsert_') > 0
        OR instr(tokens, '_write_') > 0
    )
);
