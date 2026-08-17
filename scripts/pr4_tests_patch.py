from pathlib import Path

p = Path('src/graph.rs')
s = p.read_text()
if 'incremental_rename_removes_stale_edges_and_matches_rebuild' in s:
    raise SystemExit(0)

anchor = '''mod tests {\n    use super::{assemble_file_graph, language_name_for_path, language_spec};\n'''
replacement = '''mod tests {\n    use sqlx::SqlitePool;\n    use tempfile::TempDir;\n\n    use crate::{db, workspace::Workspace};\n\n    use super::{assemble_file_graph, language_name_for_path, language_spec, sha256, sync_paths};\n'''
if anchor not in s:
    raise SystemExit('test import anchor not found')
s = s.replace(anchor, replacement, 1)

block = r'''

    fn has_reference(graph: &super::ParsedFileGraph, reference_type: &str, name: &str) -> bool {
        graph.references.iter().any(|reference| {
            reference.reference_type == reference_type && reference.name == name
        })
    }

    #[test]
    fn extracts_javascript_import_and_extends() {
        let source = "import { Base } from './base.js'; class Child extends Base {}";
        let graph = assemble_file_graph(
            "src/child.js",
            source,
            language_spec("src/child.js").unwrap(),
        )
        .expect("parse javascript graph");
        assert!(has_reference(&graph, "import", "./base.js"));
        assert!(has_reference(&graph, "extends", "Base"));
    }

    #[test]
    fn extracts_typescript_implements_and_interface_extends() {
        let source = "interface Parent {} interface Contract {} interface Child extends Parent {} class Service implements Contract {}";
        let graph = assemble_file_graph(
            "src/types.ts",
            source,
            language_spec("src/types.ts").unwrap(),
        )
        .expect("parse typescript graph");
        assert!(has_reference(&graph, "extends", "Parent"));
        assert!(has_reference(&graph, "implementation", "Contract"));
    }

    #[test]
    fn extracts_python_import_and_extends() {
        let source = "from .base import Base\nclass Child(Base):\n    pass\n";
        let graph = assemble_file_graph(
            "pkg/child.py",
            source,
            language_spec("pkg/child.py").unwrap(),
        )
        .expect("parse python graph");
        assert!(has_reference(&graph, "import", ".base"));
        assert!(has_reference(&graph, "extends", "Base"));
    }

    #[test]
    fn extracts_rust_use_as_import() {
        let source = "use crate::base::Base;\nfn run() {}\n";
        let graph = assemble_file_graph(
            "src/child.rs",
            source,
            language_spec("src/child.rs").unwrap(),
        )
        .expect("parse rust graph");
        assert!(has_reference(&graph, "import", "crate::base::Base"));
    }

    async fn fixture_workspace() -> (TempDir, SqlitePool, Workspace) {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("repo");
        std::fs::create_dir_all(&root).expect("create repo root");
        let pool = db::connect(&temp.path().join("state"))
            .await
            .expect("connect sqlite");
        sqlx::query(
            "INSERT INTO workspaces(id, name, writable, updated_at) VALUES('test', 'test', 1, unixepoch())",
        )
        .execute(&pool)
        .await
        .expect("insert workspace");
        let workspace = Workspace {
            id: "test".into(),
            name: "test".into(),
            root,
            writable: true,
        };
        (temp, pool, workspace)
    }

    async fn put_file(pool: &SqlitePool, path: &str, content: &str) {
        sqlx::query(
            "INSERT INTO files(workspace_id, path, content_hash, content, size_bytes, indexed_at) \
             VALUES('test', ?1, ?2, ?3, ?4, unixepoch()) \
             ON CONFLICT(workspace_id, path) DO UPDATE SET \
               content_hash=excluded.content_hash, content=excluded.content, \
               size_bytes=excluded.size_bytes, indexed_at=unixepoch()",
        )
        .bind(path)
        .bind(sha256(content))
        .bind(content)
        .bind(content.len() as i64)
        .execute(pool)
        .await
        .expect("upsert fixture file");
    }

    async fn edge_count(
        pool: &SqlitePool,
        edge_type: &str,
        source_qualified_name: &str,
        target_qualified_name: &str,
    ) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM edges e \
             JOIN symbols source ON source.id=e.source_symbol_id \
             JOIN symbols target ON target.id=e.target_symbol_id \
             WHERE e.workspace_id='test' AND e.edge_type=?1 \
               AND source.qualified_name=?2 AND target.qualified_name=?3",
        )
        .bind(edge_type)
        .bind(source_qualified_name)
        .bind(target_qualified_name)
        .fetch_one(pool)
        .await
        .expect("count edge")
    }

    async fn graph_snapshot(pool: &SqlitePool) -> Vec<(String, String, String)> {
        sqlx::query_as(
            "SELECT source.qualified_name, e.edge_type, target.qualified_name \
             FROM edges e \
             JOIN symbols source ON source.id=e.source_symbol_id \
             JOIN symbols target ON target.id=e.target_symbol_id \
             WHERE e.workspace_id='test' \
             ORDER BY source.qualified_name, e.edge_type, target.qualified_name",
        )
        .fetch_all(pool)
        .await
        .expect("graph snapshot")
    }

    #[tokio::test]
    async fn resolves_typescript_imports_and_inheritance() {
        let (_temp, pool, workspace) = fixture_workspace().await;
        put_file(&pool, "src/base.ts", "export class Base {}\n").await;
        put_file(
            &pool,
            "src/child.ts",
            "import { Base } from './base';\nexport class Child extends Base {}\n",
        )
        .await;
        sync_paths(
            &pool,
            &workspace,
            &["src/base.ts".into(), "src/child.ts".into()],
        )
        .await
        .expect("sync graph");
        assert_eq!(edge_count(&pool, "IMPORTS", "src/child.ts", "src/base.ts").await, 1);
        assert_eq!(
            edge_count(&pool, "EXTENDS", "src/child.ts::Child", "src/base.ts::Base").await,
            1
        );
    }

    #[tokio::test]
    async fn incremental_rename_removes_stale_edges_and_matches_rebuild() {
        let (_temp, pool, workspace) = fixture_workspace().await;
        put_file(&pool, "src/base.ts", "export class Base { value = 1; }\n").await;
        put_file(
            &pool,
            "src/child.ts",
            "import { Base } from './base';\nexport class Child extends Base {}\n",
        )
        .await;
        sync_paths(
            &pool,
            &workspace,
            &["src/base.ts".into(), "src/child.ts".into()],
        )
        .await
        .expect("initial sync");

        put_file(&pool, "src/base.ts", "export class Base { value = 2; }\n").await;
        sync_paths(&pool, &workspace, &["src/base.ts".into()])
            .await
            .expect("body refresh");
        assert_eq!(
            edge_count(&pool, "EXTENDS", "src/child.ts::Child", "src/base.ts::Base").await,
            1,
            "reverse dependency must reconnect to the replacement symbol row"
        );

        sqlx::query("DELETE FROM files WHERE workspace_id='test' AND path='src/base.ts'")
            .execute(&pool)
            .await
            .expect("delete old file");
        put_file(&pool, "src/model.ts", "export class Base { value = 3; }\n").await;
        sync_paths(
            &pool,
            &workspace,
            &["src/base.ts".into(), "src/model.ts".into()],
        )
        .await
        .expect("rename refresh");
        assert_eq!(edge_count(&pool, "IMPORTS", "src/child.ts", "src/model.ts").await, 0);
        assert_eq!(
            edge_count(&pool, "EXTENDS", "src/child.ts::Child", "src/model.ts::Base").await,
            0,
            "broken import must not fabricate inheritance"
        );

        put_file(
            &pool,
            "src/child.ts",
            "import { Base } from './model';\nexport class Child extends Base {}\n",
        )
        .await;
        sync_paths(&pool, &workspace, &["src/child.ts".into()])
            .await
            .expect("refresh child");
        assert_eq!(edge_count(&pool, "IMPORTS", "src/child.ts", "src/model.ts").await, 1);
        assert_eq!(
            edge_count(&pool, "EXTENDS", "src/child.ts::Child", "src/model.ts::Base").await,
            1
        );

        let incremental = graph_snapshot(&pool).await;
        sqlx::query("DELETE FROM symbols WHERE workspace_id='test'")
            .execute(&pool)
            .await
            .expect("clear symbols");
        sqlx::query("DELETE FROM graph_file_state WHERE workspace_id='test'")
            .execute(&pool)
            .await
            .expect("clear graph state");
        sync_paths(
            &pool,
            &workspace,
            &["src/model.ts".into(), "src/child.ts".into()],
        )
        .await
        .expect("full rebuild");
        let rebuilt = graph_snapshot(&pool).await;
        assert_eq!(incremental, rebuilt, "incremental state must equal rebuild");
    }
'''
pos = s.rfind('\n}')
if pos < 0:
    raise SystemExit('closing brace not found')
s = s[:pos] + block + s[pos:]
p.write_text(s)
