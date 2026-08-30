//! Shared application database.
//!
//! All desktop persistence that used to open its own SQLite file goes through
//! this module.  Project packages remain portable files, but their version
//! index is kept in this database and keyed by the canonical package path.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager};

pub const DATABASE_FILE_NAME: &str = "lentalk.db";

const GLOBAL_MIGRATION_KEY: &str = "migration.projects-db.v1";

pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;
    Ok(dir)
}

pub fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(DATABASE_FILE_NAME))
}

pub fn open(app: &AppHandle) -> Result<Connection, String> {
    let path = database_path(app)?;
    let conn = Connection::open(&path)
        .map_err(|error| format!("Failed to open unified SQLite database: {error}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("Failed to set journal_mode=WAL: {error}"))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| format!("Failed to set synchronous=NORMAL: {error}"))?;
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(|error| format!("Failed to set temp_store=MEMORY: {error}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|error| format!("Failed to set SQLite busy timeout: {error}"))?;
    ensure_schema(&conn)?;
    migrate_legacy_global_database(&conn, app, &path)?;
    Ok(conn)
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let _conn = open(app)?;
    Ok(())
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS app_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cinematic_projects (
          id TEXT PRIMARY KEY,
          project_dir TEXT NOT NULL DEFAULT '',
          project_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cinematic_projects_dir
          ON cinematic_projects(project_dir)
          WHERE project_dir <> '';
        CREATE TABLE IF NOT EXISTS cinematic_prompt_versions (
          project_dir TEXT NOT NULL,
          id TEXT NOT NULL,
          template TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          output_text TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          PRIMARY KEY(project_dir, id)
        );
        CREATE INDEX IF NOT EXISTS idx_cinematic_prompt_versions_created_at
          ON cinematic_prompt_versions(project_dir, created_at DESC);
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
        CREATE TABLE IF NOT EXISTS usage_log (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          provider_id TEXT NOT NULL DEFAULT '',
          provider_name TEXT NOT NULL DEFAULT '',
          model_id TEXT NOT NULL DEFAULT '',
          model_name TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL DEFAULT 'image',
          size TEXT NOT NULL DEFAULT '',
          duration REAL NOT NULL DEFAULT 0,
          reference_count INTEGER NOT NULL DEFAULT 0,
          estimated_cost REAL NOT NULL DEFAULT 0,
          currency TEXT NOT NULL DEFAULT 'CNY',
          status TEXT NOT NULL DEFAULT 'succeeded',
          error_message TEXT NOT NULL DEFAULT '',
          duration_ms INTEGER NOT NULL DEFAULT 0,
          project_id TEXT NOT NULL DEFAULT '',
          session_id TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_usage_log_created_at ON usage_log(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_usage_log_provider ON usage_log(provider_id);
        CREATE INDEX IF NOT EXISTS idx_usage_log_kind ON usage_log(kind);
        CREATE TABLE IF NOT EXISTS ai_generation_jobs (
          job_id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          status TEXT NOT NULL,
          resumable INTEGER NOT NULL DEFAULT 0,
          external_task_id TEXT,
          external_task_meta_json TEXT,
          result TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_status ON ai_generation_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_updated_at ON ai_generation_jobs(updated_at DESC);
        "#,
    )
    .map_err(|error| format!("Failed to initialize unified database schema: {error}"))
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value_json FROM app_settings WHERE key = ?1 LIMIT 1",
        params![key],
        |row| row.get(0),
    )
    .map(Some)
    .or_else(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(format!("Failed to read app setting: {other}")),
    })
}

pub fn put_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        params![key, value, now_ms()],
    )
    .map_err(|error| format!("Failed to save app setting: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn load_cinematic_project(app: AppHandle) -> Result<Option<String>, String> {
    let conn = open(&app)?;
    conn.query_row(
        "SELECT project_json FROM cinematic_projects WHERE id = 'cinematic-project' LIMIT 1",
        [],
        |row| row.get(0),
    )
    .map(Some)
    .or_else(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(format!("Failed to load cinematic project: {other}")),
    })
}

#[tauri::command]
pub fn save_cinematic_project(app: AppHandle, project_json: String) -> Result<(), String> {
    let conn = open(&app)?;
    conn.execute(
        "INSERT INTO cinematic_projects (id, project_dir, project_json, updated_at)
         VALUES ('cinematic-project', '', ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET project_json = excluded.project_json,
                                       updated_at = excluded.updated_at",
        params![project_json, now_ms()],
    )
    .map_err(|error| format!("Failed to save cinematic project: {error}"))?;
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn meta_exists(conn: &Connection, key: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM app_meta WHERE key = ?1 LIMIT 1",
        params![key],
        |_| Ok(true),
    )
    .map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => String::new(),
        other => format!("Failed to inspect database migration state: {other}"),
    })
    .or_else(|error| if error.is_empty() { Ok(false) } else { Err(error) })
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_meta (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now_ms()],
    )
    .map_err(|error| format!("Failed to record database migration state: {error}"))?;
    Ok(())
}

fn table_exists(conn: &Connection, schema: &str, table: &str) -> Result<bool, String> {
    let sql = format!(
        "SELECT 1 FROM {schema}.sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1"
    );
    conn.query_row(&sql, params![table], |_| Ok(true))
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => String::new(),
            other => format!("Failed to inspect legacy table {table}: {other}"),
        })
        .or_else(|error| if error.is_empty() { Ok(false) } else { Err(error) })
}

fn table_has_column(conn: &Connection, schema: &str, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("SELECT 1 FROM {schema}.pragma_table_info(?1) WHERE name = ?2 LIMIT 1");
    conn.query_row(&sql, params![table, column], |_| Ok(true))
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => String::new(),
            other => format!("Failed to inspect legacy column {table}.{column}: {other}"),
        })
        .or_else(|error| if error.is_empty() { Ok(false) } else { Err(error) })
}

fn migrate_legacy_global_database(
    conn: &Connection,
    app: &AppHandle,
    unified_path: &Path,
) -> Result<(), String> {
    if meta_exists(conn, GLOBAL_MIGRATION_KEY)? {
        return Ok(());
    }

    let legacy_path = app_data_dir(app)?.join("projects.db");
    if !legacy_path.exists() || legacy_path == unified_path {
        set_meta(conn, GLOBAL_MIGRATION_KEY, "not-found")?;
        return Ok(());
    }

    conn.execute("ATTACH DATABASE ?1 AS legacy_global", params![legacy_path.to_string_lossy()])
        .map_err(|error| format!("Failed to attach legacy projects database: {error}"))?;

    let migration_result = (|| {
        if table_exists(conn, "legacy_global", "projects")? {
            let node_count = if table_has_column(conn, "legacy_global", "projects", "node_count")? {
                "node_count"
            } else {
                "0"
            };
            let sql = format!(
                "INSERT OR IGNORE INTO projects
                 (id, name, created_at, updated_at, node_count, nodes_json, edges_json, viewport_json, history_json)
                 SELECT id, name, created_at, updated_at, {node_count}, nodes_json, edges_json, viewport_json, history_json
                 FROM legacy_global.projects"
            );
            conn.execute(&sql, [])
                .map_err(|error| format!("Failed to migrate canvas projects: {error}"))?;
        }
        if table_exists(conn, "legacy_global", "project_image_refs")? {
            conn.execute(
                "INSERT OR IGNORE INTO project_image_refs (project_id, path)
                 SELECT project_id, path FROM legacy_global.project_image_refs",
                [],
            )
            .map_err(|error| format!("Failed to migrate project image references: {error}"))?;
        }
        if table_exists(conn, "legacy_global", "usage_log")? {
            conn.execute(
                "INSERT OR IGNORE INTO usage_log
                 (id, created_at, provider_id, provider_name, model_id, model_name, kind, size,
                  duration, reference_count, estimated_cost, currency, status, error_message,
                  duration_ms, project_id, session_id)
                 SELECT id, created_at, provider_id, provider_name, model_id, model_name, kind, size,
                  duration, reference_count, estimated_cost, currency, status, error_message,
                  duration_ms, project_id, session_id FROM legacy_global.usage_log",
                [],
            )
            .map_err(|error| format!("Failed to migrate usage records: {error}"))?;
        }
        if table_exists(conn, "legacy_global", "ai_generation_jobs")? {
            conn.execute(
                "INSERT OR IGNORE INTO ai_generation_jobs
                 (job_id, provider_id, status, resumable, external_task_id, external_task_meta_json,
                  result, error, created_at, updated_at)
                 SELECT job_id, provider_id, status, resumable, external_task_id, external_task_meta_json,
                  result, error, created_at, updated_at FROM legacy_global.ai_generation_jobs",
                [],
            )
            .map_err(|error| format!("Failed to migrate AI generation jobs: {error}"))?;
        }
        Ok::<(), String>(())
    })();

    let detach_result = conn.execute_batch("DETACH DATABASE legacy_global");
    migration_result?;
    detach_result.map_err(|error| format!("Failed to detach legacy projects database: {error}"))?;

    set_meta(conn, GLOBAL_MIGRATION_KEY, "migrated")?;
    backup_file(&legacy_path, "projects.db")?;
    Ok(())
}

/// Import a project package's old prompt-version database into the unified DB.
/// The old file is retained as a timestamped backup after a successful import.
pub fn migrate_cinematic_project_database(app: &AppHandle, dir: &Path) -> Result<String, String> {
    let canonical_dir = canonical_project_dir(dir)?;
    let legacy_path = canonical_dir.join("database.sqlite");
    if !legacy_path.exists() {
        return Ok(canonical_dir.to_string_lossy().to_string());
    }

    let conn = open(app)?;
    let migration_key = format!("migration.cinematic-db.v1:{}", canonical_dir.to_string_lossy());
    if meta_exists(&conn, &migration_key)? {
        return Ok(canonical_dir.to_string_lossy().to_string());
    }

    conn.execute("ATTACH DATABASE ?1 AS legacy_cinematic", params![legacy_path.to_string_lossy()])
        .map_err(|error| format!("Failed to attach legacy cinematic database: {error}"))?;
    let migration_result = (|| {
        if table_exists(&conn, "legacy_cinematic", "prompt_versions")? {
            conn.execute(
                "INSERT OR IGNORE INTO cinematic_prompt_versions
                 (project_dir, id, template, summary_json, output_text, created_at)
                 SELECT ?1, id, template, summary_json, '', created_at
                 FROM legacy_cinematic.prompt_versions",
                params![canonical_dir.to_string_lossy().to_string()],
            )
            .map_err(|error| format!("Failed to migrate cinematic prompt versions: {error}"))?;
        }
        Ok::<(), String>(())
    })();
    let detach_result = conn.execute_batch("DETACH DATABASE legacy_cinematic");
    migration_result?;
    detach_result.map_err(|error| format!("Failed to detach legacy cinematic database: {error}"))?;

    set_meta(&conn, &migration_key, "migrated")?;
    backup_file(&legacy_path, "database.sqlite")?;
    Ok(canonical_dir.to_string_lossy().to_string())
}

fn canonical_project_dir(dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(dir)
        .map_err(|error| format!("Failed to create cinematic project directory: {error}"))?;
    dir.canonicalize()
        .map_err(|error| format!("Failed to resolve cinematic project directory: {error}"))
}

fn backup_file(path: &Path, label: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let timestamp = now_ms();
    let backup = path.with_file_name(format!("{label}.migrated-{timestamp}.bak"));
    fs::rename(path, &backup)
        .map_err(|error| format!("Failed to archive legacy database {path:?}: {error}"))?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{}", path.to_string_lossy(), suffix));
        if sidecar.exists() {
            let sidecar_backup = PathBuf::from(format!("{}{}", backup.to_string_lossy(), suffix));
            let _ = fs::rename(sidecar, sidecar_backup);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn load_app_setting(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let conn = open(&app)?;
    get_setting(&conn, &key)
}

#[tauri::command]
pub fn save_app_setting(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let conn = open(&app)?;
    put_setting(&conn, &key, &value)
}

#[tauri::command]
pub fn delete_app_setting(app: AppHandle, key: String) -> Result<(), String> {
    let conn = open(&app)?;
    conn.execute("DELETE FROM app_settings WHERE key = ?1", params![key])
        .map_err(|error| format!("Failed to delete app setting: {error}"))?;
    Ok(())
}
