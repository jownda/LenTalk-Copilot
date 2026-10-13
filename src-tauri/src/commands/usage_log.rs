// ---------------------------------------------------------------------------
// 用量/扣费记录(账单)
// 每次 AI 生成(图片/视频)完成或失败时写一条记录, 供「账单」抽屉查询核对。
// 表与项目数据共用统一 lentalk.db; 费用为本地估算值(基于模型定价), 仅作参考,
// 实际扣费以平台账单为准。
// ---------------------------------------------------------------------------
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::database;

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

/// 按天聚合的用量桶(本地时区)。供「创作历程」热力图与统计卡片使用。
///
/// 与 `query_usage_records` 的 1000 条上限不同, 这里是 SQL 侧 GROUP BY 全表聚合,
/// 不会因为记录数超过上限而漏统计。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDailyBucket {
    /// 本地时区日期, 形如 `2026-10-08`。
    pub day: String,
    pub total: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub image: i64,
    pub video: i64,
    pub audio: i64,
    pub cost: f64,
    pub image_cost: f64,
    pub video_cost: f64,
    pub audio_cost: f64,
}

/// 按模型聚合的用量(全表), 用于「常用模型」排行。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelBreakdown {
    pub model_id: String,
    pub model_name: String,
    pub provider_name: String,
    pub total: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub image: i64,
    pub video: i64,
    pub audio: i64,
    pub cost: f64,
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
    let conn = database::open(app)?;
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

/// 按天聚合的用量统计(升序), 覆盖全部历史记录。
///
/// `kind` 传空/不传时统计全部媒体类型。
#[tauri::command]
pub fn query_usage_daily(app: AppHandle, kind: Option<String>) -> Result<Vec<UsageDailyBucket>, String> {
    let conn = open_connection(&app)?;
    let kind_filter = kind.unwrap_or_default();
    let kind_filter = kind_filter.trim().to_string();

    let where_clause = if kind_filter.is_empty() {
        String::new()
    } else {
        "WHERE kind = ?1".to_string()
    };
    let params_vec: Vec<rusqlite::types::Value> = if kind_filter.is_empty() {
        Vec::new()
    } else {
        vec![rusqlite::types::Value::Text(kind_filter)]
    };

    let mut stmt = conn
        .prepare(&format!(
            "SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
                    COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'image' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'video' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'audio' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(estimated_cost), 0),
                    COALESCE(SUM(CASE WHEN kind = 'image' THEN estimated_cost ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'video' THEN estimated_cost ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'audio' THEN estimated_cost ELSE 0 END), 0)
             FROM usage_log
             {where_clause}
             GROUP BY day
             ORDER BY day ASC"
        ))
        .map_err(|e| format!("Failed to prepare daily usage query: {}", e))?;

    let mut rows = stmt
        .query_map(rusqlite::params_from_iter(params_vec.iter()), |row| {
            Ok(UsageDailyBucket {
                day: row.get(0)?,
                total: row.get(1)?,
                succeeded: row.get(2)?,
                failed: row.get(3)?,
                image: row.get(4)?,
                video: row.get(5)?,
                audio: row.get(6)?,
                cost: row.get(7)?,
                image_cost: row.get(8)?,
                video_cost: row.get(9)?,
                audio_cost: row.get(10)?,
            })
        })
        .map_err(|e| format!("Failed to query daily usage: {}", e))?;

    let mut buckets = Vec::new();
    while let Some(bucket) = rows
        .next()
        .transpose()
        .map_err(|e| format!("Failed to read daily usage row: {}", e))?
    {
        // 理论上 day 不会为空, 兜底跳过避免脏数据污染前端热力图的日期解析。
        if !bucket.day.is_empty() {
            buckets.push(bucket);
        }
    }
    Ok(buckets)
}

/// 按模型聚合的用量排行(生成次数降序), 覆盖全部历史记录。
#[tauri::command]
pub fn query_usage_breakdown(
    app: AppHandle,
    limit: Option<i64>,
) -> Result<Vec<UsageModelBreakdown>, String> {
    let conn = open_connection(&app)?;
    let safe_limit = limit.unwrap_or(10).clamp(1, 50);

    let mut stmt = conn
        .prepare(
            "SELECT model_id, model_name, provider_name,
                    COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'image' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'video' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'audio' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(estimated_cost), 0)
             FROM usage_log
             GROUP BY model_id, model_name, provider_name
             ORDER BY COUNT(*) DESC, model_name ASC
             LIMIT ?1",
        )
        .map_err(|e| format!("Failed to prepare breakdown query: {}", e))?;

    let mut rows = stmt
        .query_map([safe_limit], |row| {
            Ok(UsageModelBreakdown {
                model_id: row.get(0)?,
                model_name: row.get(1)?,
                provider_name: row.get(2)?,
                total: row.get(3)?,
                succeeded: row.get(4)?,
                failed: row.get(5)?,
                image: row.get(6)?,
                video: row.get(7)?,
                audio: row.get(8)?,
                cost: row.get(9)?,
            })
        })
        .map_err(|e| format!("Failed to query model breakdown: {}", e))?;

    let mut items = Vec::new();
    while let Some(item) = rows
        .next()
        .transpose()
        .map_err(|e| format!("Failed to read breakdown row: {}", e))?
    {
        items.push(item);
    }
    Ok(items)
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
