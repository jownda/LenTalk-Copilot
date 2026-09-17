use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::database;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateStorageRecord {
    pub id: String,
    pub name: String,
    pub payload_json: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn ensure_templates_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_templates_updated_at ON templates(updated_at DESC);
        "#,
    )
    .map_err(|error| format!("Failed to initialize templates table: {error}"))
}

fn open_connection(app: &AppHandle) -> Result<Connection, String> {
    let conn = database::open(app)?;
    ensure_templates_table(&conn)?;
    Ok(conn)
}

#[tauri::command]
pub fn list_template_records(app: AppHandle) -> Result<Vec<TemplateStorageRecord>, String> {
    let conn = open_connection(&app)?;
    let mut statement = conn
        .prepare("SELECT id, name, payload_json, created_at, updated_at FROM templates ORDER BY updated_at DESC")
        .map_err(|error| format!("Failed to prepare templates query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(TemplateStorageRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                payload_json: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|error| format!("Failed to query templates: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode template row: {error}"))
}

#[tauri::command]
pub fn get_template_record(
    app: AppHandle,
    template_id: String,
) -> Result<Option<TemplateStorageRecord>, String> {
    let conn = open_connection(&app)?;
    conn.query_row(
        "SELECT id, name, payload_json, created_at, updated_at FROM templates WHERE id = ?1 LIMIT 1",
        params![template_id],
        |row| {
            Ok(TemplateStorageRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                payload_json: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|error| format!("Failed to load template: {error}"))
}

#[tauri::command]
pub fn save_template_record(
    app: AppHandle,
    record: TemplateStorageRecord,
) -> Result<(), String> {
    if record.id.trim().is_empty() || record.payload_json.trim().is_empty() {
        return Err("Template id and payload are required".to_string());
    }
    let conn = open_connection(&app)?;
    conn.execute(
        "INSERT INTO templates (id, name, payload_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                                       payload_json = excluded.payload_json,
                                       updated_at = excluded.updated_at",
        params![record.id, record.name, record.payload_json, record.created_at, record.updated_at],
    )
    .map_err(|error| format!("Failed to save template: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn delete_template_record(app: AppHandle, template_id: String) -> Result<(), String> {
    let conn = open_connection(&app)?;
    conn.execute("DELETE FROM templates WHERE id = ?1", params![template_id])
        .map_err(|error| format!("Failed to delete template: {error}"))?;
    Ok(())
}
