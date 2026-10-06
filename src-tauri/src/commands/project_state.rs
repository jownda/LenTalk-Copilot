use std::path::PathBuf;
use std::collections::HashSet;
use std::time::{Duration, SystemTime};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::database;

/// 节点数据里图片的轻量引用前缀(与前端 projectStore 的 encodeImageReference 一致)。
const IMAGE_REF_PREFIX: &str = "__img_ref__:";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummaryRecord {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub node_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub node_count: i64,
    pub nodes_json: String,
    pub edges_json: String,
    pub viewport_json: String,
    pub history_json: String,
}

fn ensure_projects_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          node_count INTEGER NOT NULL DEFAULT 0,
          nodes_json TEXT NOT NULL,
          edges_json TEXT NOT NULL,
          viewport_json TEXT NOT NULL,
          history_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);
        CREATE TABLE IF NOT EXISTS project_image_refs (
          project_id TEXT NOT NULL,
          path TEXT NOT NULL,
          PRIMARY KEY(project_id, path)
        );
        CREATE INDEX IF NOT EXISTS idx_project_image_refs_path ON project_image_refs(path);
        "#,
    )
    .map_err(|e| format!("Failed to initialize projects table: {}", e))?;

    let mut has_node_count = false;
    let mut stmt = conn
        .prepare("PRAGMA table_info(projects)")
        .map_err(|e| format!("Failed to inspect projects schema: {}", e))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to inspect projects columns: {}", e))?;

    for name_result in rows {
        let column_name =
            name_result.map_err(|e| format!("Failed to read projects column name: {}", e))?;
        if column_name == "node_count" {
            has_node_count = true;
            break;
        }
    }

    if !has_node_count {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN node_count INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("Failed to add node_count column: {}", e))?;
    }

    Ok(())
}

fn parse_image_pool(history_json: &str) -> Vec<String> {
    let parsed: serde_json::Value = match serde_json::from_str(history_json) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    parsed
        .get("imagePool")
        .and_then(|value| value.as_array())
        .map(|array| {
            array
                .iter()
                .filter_map(|value| value.as_str().map(|item| item.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn resolve_image_ref(value: &str, image_pool: &[String]) -> Option<String> {
    if let Some(index_text) = value.strip_prefix(IMAGE_REF_PREFIX) {
        let index = index_text.parse::<usize>().ok()?;
        return image_pool.get(index).cloned();
    }

    if value.trim().is_empty() {
        return None;
    }

    Some(value.to_string())
}

/// 判断字符串是否像本地绝对路径(macOS/Linux 的 `/…`、Windows 的 `C:\…` 与 UNC `\\…`)。
///
/// 用来把节点数据里的普通文本(提示词、备注、节点名)挡在引用表之外,
/// 避免 `project_image_refs` 被无意义的字符串撑大。
fn looks_like_local_path(value: &str) -> bool {
    if value.starts_with('/') || value.starts_with("\\\\") {
        return true;
    }
    // 盘符后必须紧跟分隔符, 否则 `C: 备注` 这类文本也会被误判成路径。
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// 收集节点数据里出现的所有图片路径(已解码)。
///
/// 这里刻意递归扫描 `data` 下的任意字符串, 而不是维护一份字段白名单。
/// 原因是两种失误的代价完全不对称:
///   * 白名单漏字段 → 仍被引用的图片被资源回收误移走(确实漏过全景的
///     `outputImageUrl`、无缝拼图的 `outputPreviewImageUrl`、导演台的
///     `lastCaptureUrl` 等), 用户表现为「图突然变破图」且不可逆;
///   * 多保护几个路径 → 只是少回收一个文件。
/// 所以选择保守的一侧。
fn collect_image_paths_from_nodes(
    nodes: &[serde_json::Value],
    image_pool: &[String],
    paths: &mut HashSet<String>,
) {
    for node in nodes {
        if let Some(data) = node.get("data") {
            collect_image_paths_from_value(data, image_pool, paths);
        }
    }
}

fn collect_image_paths_from_value(
    value: &serde_json::Value,
    image_pool: &[String],
    paths: &mut HashSet<String>,
) {
    match value {
        serde_json::Value::String(raw) => {
            if raw.starts_with(IMAGE_REF_PREFIX) {
                if let Some(path) = resolve_image_ref(raw, image_pool) {
                    paths.insert(path);
                }
            } else if looks_like_local_path(raw) {
                paths.insert(raw.clone());
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_image_paths_from_value(item, image_pool, paths);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values() {
                collect_image_paths_from_value(item, image_pool, paths);
            }
        }
        _ => {}
    }
}

fn extract_project_image_paths(nodes_json: &str, history_json: &str) -> HashSet<String> {
    let image_pool = parse_image_pool(history_json);
    let mut paths = HashSet::new();

    if let Ok(parsed_nodes) = serde_json::from_str::<serde_json::Value>(nodes_json) {
        if let Some(nodes) = parsed_nodes.as_array() {
            collect_image_paths_from_nodes(nodes, &image_pool, &mut paths);
        }
    }

    if let Ok(parsed_history) = serde_json::from_str::<serde_json::Value>(history_json) {
        for timeline_key in ["past", "future"] {
            let Some(timeline) = parsed_history.get(timeline_key).and_then(|value| value.as_array()) else {
                continue;
            };

            for snapshot in timeline {
                let Some(nodes) = snapshot.get("nodes").and_then(|value| value.as_array()) else {
                    continue;
                };
                collect_image_paths_from_nodes(nodes, &image_pool, &mut paths);
            }
        }
    }

    paths
}

fn resolve_images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    let images_dir = app_data_dir.join("images");
    std::fs::create_dir_all(&images_dir)
        .map_err(|e| format!("Failed to create images dir: {}", e))?;
    Ok(images_dir)
}

fn collect_asset_library_paths_from_json(raw: &str, referenced: &mut HashSet<String>) {
    let Ok(state) = serde_json::from_str::<serde_json::Value>(raw) else {
        return;
    };
    let Some(assets) = state.get("assets").and_then(|value| value.as_array()) else {
        return;
    };

    for asset in assets {
        for key in ["sourcePath", "previewImageUrl"] {
            if let Some(path) = asset.get(key).and_then(|value| value.as_str()) {
                if !path.trim().is_empty() {
                    referenced.insert(path.to_string());
                }
            }
        }
    }
}

fn collect_asset_library_paths(
    conn: &Connection,
    referenced: &mut HashSet<String>,
) -> Result<(), String> {
    let state_json = conn
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = 'asset-library' LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query asset library refs: {}", e))?;

    if let Some(raw) = state_json {
        collect_asset_library_paths_from_json(&raw, referenced);
    }
    Ok(())
}

fn prune_unreferenced_images(app: &AppHandle) -> Result<(), String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare("SELECT DISTINCT path FROM project_image_refs")
        .map_err(|e| format!("Failed to prepare image refs query: {}", e))?;

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query image refs: {}", e))?;

    let mut referenced = HashSet::new();
    for path_result in rows {
        let path = path_result.map_err(|e| format!("Failed to decode image ref row: {}", e))?;
        referenced.insert(path);
    }
    // Older asset-library records may point into the shared images directory.
    // Keep those files protected even after their source canvas node is gone.
    collect_asset_library_paths(&conn, &mut referenced)?;

    let images_dir = resolve_images_dir(app)?;
    // Image persistence and project-reference persistence are separate IPC
    // operations. Keep a generous grace period and quarantine files instead of
    // deleting them immediately so an in-flight save cannot lose an image.
    const IMAGE_GRACE_PERIOD: Duration = Duration::from_secs(24 * 60 * 60);
    let quarantine_dir = images_dir.join(".quarantine");
    std::fs::create_dir_all(&quarantine_dir)
        .map_err(|e| format!("Failed to create image quarantine dir: {}", e))?;
    let entries = std::fs::read_dir(&images_dir)
        .map_err(|e| format!("Failed to read images dir: {}", e))?;

    for entry_result in entries {
        let entry = entry_result.map_err(|e| format!("Failed to iterate images dir: {}", e))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let path_string = path.to_string_lossy().to_string();
        let is_old_enough = std::fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age >= IMAGE_GRACE_PERIOD);
        if !referenced.contains(&path_string) && is_old_enough {
            let Some(file_name) = path.file_name() else { continue; };
            let target = quarantine_dir.join(file_name);
            if target.exists() {
                continue;
            }
            std::fs::rename(&path, &target)
                .map_err(|e| format!("Failed to quarantine unreferenced image: {}", e))?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        collect_asset_library_paths_from_json, collect_image_paths_from_nodes,
        extract_project_image_paths,
    };
    use std::collections::HashSet;

    #[test]
    fn asset_library_paths_are_protected_from_project_image_pruning() {
        let mut referenced = HashSet::new();
        collect_asset_library_paths_from_json(
            r#"{"assets":[{"sourcePath":"/app/images/original.png","previewImageUrl":"/app/images/preview.png"}]}"#,
            &mut referenced,
        );

        assert!(referenced.contains("/app/images/original.png"));
        assert!(referenced.contains("/app/images/preview.png"));
    }

    #[test]
    fn malformed_asset_library_state_does_not_break_project_pruning() {
        let mut referenced = HashSet::new();
        collect_asset_library_paths_from_json("not-json", &mut referenced);
        assert!(referenced.is_empty());
    }

    /// 全景 / 无缝拼图 / 导演台的图片产物字段曾经不在白名单里,
    /// 导致这些节点仍被引用时图片也会被资源回收移进 .quarantine。
    #[test]
    fn media_fields_outside_the_legacy_whitelist_stay_protected() {
        let nodes: Vec<serde_json::Value> = serde_json::from_str(
            r#"[
                {"id":"pano","type":"panoramaNode","data":{
                    "outputImageUrl":"/app/images/pano-out.png",
                    "inputImageUrl":"/app/images/pano-in.png",
                    "outputPreviewImageUrl":"/app/images/pano-out-thumb.png",
                    "previewInputImageUrl":"/app/images/pano-in-thumb.png"
                }},
                {"id":"mosaic","type":"seamlessMosaicNode","data":{
                    "outputImageUrl":"/app/images/mosaic.png"
                }},
                {"id":"desk","type":"directorDeskNode","data":{
                    "lastCaptureUrl":"/app/images/desk.png",
                    "lastCapturePreviewUrl":"/app/images/desk-thumb.png"
                }},
                {"id":"storyboard","type":"storyboardSplitNode","data":{
                    "frames":[
                        {"imageUrl":"/app/images/f0.png","previewImageUrl":"/app/images/f0-thumb.png"},
                        {"imageUrl":"/app/images/f1.png"}
                    ]
                }}
            ]"#,
        )
        .expect("test fixtures are valid json");

        let mut referenced = HashSet::new();
        collect_image_paths_from_nodes(&nodes, &[], &mut referenced);

        for path in [
            "/app/images/pano-out.png",
            "/app/images/pano-in.png",
            "/app/images/pano-out-thumb.png",
            "/app/images/pano-in-thumb.png",
            "/app/images/mosaic.png",
            "/app/images/desk.png",
            "/app/images/desk-thumb.png",
            "/app/images/f0.png",
            "/app/images/f0-thumb.png",
            "/app/images/f1.png",
        ] {
            assert!(referenced.contains(path), "{path} 应当被保护");
        }
    }

    /// 引用要按 imagePool 解码成真实路径, 否则回收侧永远匹配不上文件名。
    #[test]
    fn image_refs_are_decoded_through_the_pool() {
        let pool = vec![
            "/app/images/a.png".to_string(),
            "/app/images/b.png".to_string(),
        ];
        let nodes: Vec<serde_json::Value> = serde_json::from_str(
            r#"[{"id":"n","type":"imageNode","data":{"imageUrl":"__img_ref__:1"}}]"#,
        )
        .expect("test fixtures are valid json");

        let mut referenced = HashSet::new();
        collect_image_paths_from_nodes(&nodes, &pool, &mut referenced);

        assert!(referenced.contains("/app/images/b.png"));
        assert!(!referenced.contains("__img_ref__:1"));
    }

    /// 普通文本(提示词 / 备注 / 节点名)不该被当成图片引用写进引用表。
    #[test]
    fn plain_text_fields_are_not_treated_as_image_references() {
        let nodes: Vec<serde_json::Value> = serde_json::from_str(
            r#"[{"id":"t","type":"imageNode","data":{
                "displayName":"9月6日.png",
                "prompt":"一张 / 参考图",
                "note":"C: 这是备注",
                "imageUrl":"/app/images/real.png"
            }}]"#,
        )
        .expect("test fixtures are valid json");

        let mut referenced = HashSet::new();
        collect_image_paths_from_nodes(&nodes, &[], &mut referenced);

        assert_eq!(referenced.len(), 1, "只应收集真实路径: {referenced:?}");
        assert!(referenced.contains("/app/images/real.png"));
    }

    /// 端到端: nodesJson + historyJson(imagePool) → 引用集合。
    #[test]
    fn extract_project_image_paths_decodes_nodes_and_history() {
        let nodes_json = r#"[{"id":"n","type":"imageNode","data":{"imageUrl":"__img_ref__:0"}}]"#;
        let history_json = r#"{
            "past":[{"nodes":[{"id":"old","data":{"previewImageUrl":"/app/images/undone.png"}}]}],
            "future":[],
            "imagePool":["/app/images/current.png"]
        }"#;

        let referenced = extract_project_image_paths(nodes_json, history_json);

        assert!(referenced.contains("/app/images/current.png"));
        assert!(
            referenced.contains("/app/images/undone.png"),
            "撤销栈里的图片也必须保护, 否则撤销回来就是破图"
        );
    }
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let conn = database::open(app)?;
    ensure_projects_table(&conn)?;
    Ok(conn)
}

#[tauri::command]
pub fn list_project_summaries(app: AppHandle) -> Result<Vec<ProjectSummaryRecord>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              id,
              name,
              created_at,
              updated_at,
              node_count
            FROM projects
            ORDER BY updated_at DESC
            "#,
        )
        .map_err(|e| format!("Failed to prepare list summaries query: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ProjectSummaryRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                node_count: row.get(4)?,
            })
        })
        .map_err(|e| format!("Failed to query project summaries: {}", e))?;

    let mut projects = Vec::new();
    for row in rows {
        projects.push(row.map_err(|e| format!("Failed to decode summary row: {}", e))?);
    }
    Ok(projects)
}

#[tauri::command]
pub fn get_project_record(
    app: AppHandle,
    project_id: String,
) -> Result<Option<ProjectRecord>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              id,
              name,
              created_at,
              updated_at,
              node_count,
              nodes_json,
              edges_json,
              viewport_json,
              history_json
            FROM projects
            WHERE id = ?1
            LIMIT 1
            "#,
        )
        .map_err(|e| format!("Failed to prepare get project query: {}", e))?;

    let result = stmt.query_row(params![project_id], |row| {
        Ok(ProjectRecord {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
            node_count: row.get(4)?,
            nodes_json: row.get(5)?,
            edges_json: row.get(6)?,
            viewport_json: row.get(7)?,
            history_json: row.get(8)?,
        })
    });

    match result {
        Ok(record) => Ok(Some(record)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(format!("Failed to load project: {}", error)),
    }
}

#[tauri::command]
pub fn upsert_project_record(app: AppHandle, record: ProjectRecord) -> Result<(), String> {
    let mut conn = open_db(&app)?;
    let image_paths = extract_project_image_paths(&record.nodes_json, &record.history_json);
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    tx.execute(
        r#"
        INSERT INTO projects (
          id,
          name,
          created_at,
          updated_at,
          node_count,
          nodes_json,
          edges_json,
          viewport_json,
          history_json
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          node_count = excluded.node_count,
          nodes_json = excluded.nodes_json,
          edges_json = excluded.edges_json,
          viewport_json = excluded.viewport_json,
          history_json = excluded.history_json
        "#,
        params![
            record.id,
            record.name,
            record.created_at,
            record.updated_at,
            record.node_count,
            record.nodes_json,
            record.edges_json,
            record.viewport_json,
            record.history_json,
        ],
    )
    .map_err(|e| format!("Failed to upsert project: {}", e))?;

    tx.execute(
        "DELETE FROM project_image_refs WHERE project_id = ?1",
        params![record.id],
    )
    .map_err(|e| format!("Failed to clear project image refs: {}", e))?;

    for path in image_paths {
        tx.execute(
            "INSERT OR IGNORE INTO project_image_refs (project_id, path) VALUES (?1, ?2)",
            params![record.id, path],
        )
        .map_err(|e| format!("Failed to upsert project image ref: {}", e))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit upsert transaction: {}", e))?;

    prune_unreferenced_images(&app)?;
    Ok(())
}

#[tauri::command]
pub fn update_project_viewport_record(
    app: AppHandle,
    project_id: String,
    viewport_json: String,
) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE projects SET viewport_json = ?1 WHERE id = ?2",
        params![viewport_json, project_id],
    )
    .map_err(|e| format!("Failed to update project viewport: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn rename_project_record(
    app: AppHandle,
    project_id: String,
    name: String,
    updated_at: i64,
) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, updated_at, project_id],
    )
    .map_err(|e| format!("Failed to rename project: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn delete_project_record(app: AppHandle, project_id: String) -> Result<(), String> {
    let mut conn = open_db(&app)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin delete transaction: {}", e))?;

    tx.execute("DELETE FROM projects WHERE id = ?1", params![project_id])
        .map_err(|e| format!("Failed to delete project: {}", e))?;
    tx.execute(
        "DELETE FROM project_image_refs WHERE project_id = ?1",
        params![project_id],
    )
    .map_err(|e| format!("Failed to delete project image refs: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit delete transaction: {}", e))?;

    prune_unreferenced_images(&app)?;
    Ok(())
}
