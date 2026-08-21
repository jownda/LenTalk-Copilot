// ---------------------------------------------------------------------------
// 用量/扣费记录(账单)
// 每次 AI 生成(图片/视频)完成或失败时写一条记录, 供「账单」抽屉查询核对。
// 表与项目数据共用 projects.db; 费用为本地估算值(基于模型定价), 仅作参考,
// 实际扣费以平台账单为准。
// ---------------------------------------------------------------------------
use std::path::PathBuf;

use rusqlite::{params, Connection};
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLogRecord {
    pub id: String,
    pub created_at: i64,
    pub provider_id: String,
    pub provider_name: String,
    pub model_id: String,
    pub model_name: String,
    pub kind: String,
    pub size: String,
    pub duration: f64,
    pub reference_count: i64,
    pub estimated_cost: f64,
    pub currency: String,
    pub status: String,
    pub error_message: String,
    pub duration_ms: i64,
    pub project_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLogSummary {
    pub total_count: i64,
    pub succeeded_count: i64,
    pub failed_count: i64,
    pub total_cost: f64,
    pub month_count: i64,
    pub month_cost: f64,
}

fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    Ok(app_data_dir.join("projects.db"))
}

fn ensure_usage_log_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
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
        "#,
    )
    .map_err(|e| format!("Failed to initialize usage_log table: {}", e))
}

fn open_connection(app: &AppHandle) -> Result<Connection, String> {
    let db_path = resolve_db_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open db: {}", e))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("Failed to set journal_mode=WAL: {}", e))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("Failed to set synchronous=NORMAL: {}", e))?;
    conn.busy_timeout(Duration::from_millis(3000))
        .map_err(|e| format!("Failed to set busy timeout: {}", e))?;
    ensure_usage_log_table(&conn)?;
    Ok(conn)
}

/// 写入一条用量记录(幂等: 相同 id 重复写入会被忽略)。
#[tauri::command]
pub fn append_usage_record(app: AppHandle, record: UsageLogRecord) -> Result<(), String> {
    let conn = open_connection(&app)?;
    conn.execute(
        "INSERT OR IGNORE INTO usage_log (
          id, created_at, provider_id, provider_name, model_id, model_name,
          kind, size, duration, reference_count, estimated_cost, currency,
          status, error_message, duration_ms, project_id, session_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        params![
            record.id,
            record.created_at,
            record.provider_id,
            record.provider_name,
            record.model_id,
            record.model_name,
            record.kind,
            record.size,
            record.duration,
            record.reference_count,
            record.estimated_cost,
            record.currency,
            record.status,
            record.error_message,
            record.duration_ms,
            record.project_id,
            record.session_id,
        ],
    )
    .map_err(|e| format!("Failed to insert usage record: {}", e))?;
    Ok(())
}

/// 查询用量记录(按时间倒序)。
#[tauri::command]
pub fn query_usage_records(
    app: AppHandle,
    limit: Option<i64>,
    offset: Option<i64>,
    kind: Option<String>,
) -> Result<Vec<UsageLogRecord>, String> {
    let conn = open_connection(&app)?;
    let safe_limit = limit.unwrap_or(200).clamp(1, 1000);
    let safe_offset = offset.unwrap_or(0).max(0);

    let (where_clause, params_vec): (String, Vec<rusqlite::types::Value>) = match kind {
        Some(kind_value) if !kind_value.trim().is_empty() => {
            (format!("WHERE kind = ?1"), vec![rusqlite::types::Value::Text(kind_value.trim().to_string())])
        }
        _ => (String::new(), Vec::new()),
    };

    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, created_at, provider_id, provider_name, model_id, model_name,
                    kind, size, duration, reference_count, estimated_cost, currency,
                    status, error_message, duration_ms, project_id, session_id
             FROM usage_log
             {where_clause}
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?"
        ))
        .map_err(|e| format!("Failed to prepare usage query: {}", e))?;

    let mut rows = stmt
        .query_map(
            rusqlite::params_from_iter(params_vec.iter().chain([
                &rusqlite::types::Value::Integer(safe_limit),
                &rusqlite::types::Value::Integer(safe_offset),
            ])),
            |row| {
                Ok(UsageLogRecord {
                    id: row.get(0)?,
                    created_at: row.get(1)?,
                    provider_id: row.get(2)?,
                    provider_name: row.get(3)?,
                    model_id: row.get(4)?,
                    model_name: row.get(5)?,
                    kind: row.get(6)?,
                    size: row.get(7)?,
                    duration: row.get(8)?,
                    reference_count: row.get(9)?,
                    estimated_cost: row.get(10)?,
                    currency: row.get(11)?,
                    status: row.get(12)?,
                    error_message: row.get(13)?,
                    duration_ms: row.get(14)?,
                    project_id: row.get(15)?,
                    session_id: row.get(16)?,
                })
            },
        )
        .map_err(|e| format!("Failed to query usage records: {}", e))?;

    let mut records = Vec::new();
    while let Some(record) = rows.next().transpose().map_err(|e| format!("Failed to read usage row: {}", e))? {
        records.push(record);
    }
    Ok(records)
}

/// 用量汇总: 总次数/成功数/失败数/总费用 + 当前自然月次数与费用。
#[tauri::command]
pub fn query_usage_summary(app: AppHandle) -> Result<UsageLogSummary, String> {
    let conn = open_connection(&app)?;

    let (total_count, succeeded_count, failed_count, total_cost): (i64, i64, i64, f64) = conn
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(estimated_cost), 0)
             FROM usage_log",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| format!("Failed to query usage summary: {}", e))?;

    // 当前自然月聚合(created_at 为毫秒, 转秒后按本地时区取 YYYY-MM)
    let (month_count, month_cost): (i64, f64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(estimated_cost), 0)
             FROM usage_log
             WHERE strftime('%Y-%m', created_at / 1000, 'unixepoch', 'localtime')
                 = strftime('%Y-%m', 'now', 'localtime')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("Failed to query month usage: {}", e))?;

    Ok(UsageLogSummary {
        total_count,
        succeeded_count,
        failed_count,
        total_cost,
        month_count,
        month_cost,
    })
}
