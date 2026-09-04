ALTER TABLE mcp_extension_invocation_audit
ADD COLUMN diagnostic TEXT
CHECK (
    diagnostic IS NULL OR (
        length(diagnostic) BETWEEN 1 AND 256
        AND instr(diagnostic, char(0)) = 0
        AND instr(diagnostic, char(10)) = 0
        AND instr(diagnostic, char(13)) = 0
    )
);
