mod runtime;
mod video;
#[cfg(test)]
mod tests;

use serde::Serialize;
use runtime::{args, run};
#[tauri::command]
pub async fn generate_wan_cli_video(app: tauri::AppHandle, request: video::GenerateWanCliVideoRequest) -> Result<String, String> {
    video::generate_wan_cli_video(app, request).await
}

#[derive(Serialize)]
pub struct WanCliStatus {
    version: String,
    authenticated: bool,
    message: Option<String>,
}

#[tauri::command]
pub async fn wan_cli_status(executable: String) -> Result<WanCliStatus, String> {
    let version = run(&executable, &args(&["--version"]), 30).await?;
    let version = version.get("version").and_then(serde_json::Value::as_str)
        .unwrap_or("unknown").to_string();
    match run(&executable, &args(&["auth", "status"]), 30).await {
        Ok(status) => Ok(WanCliStatus {
            version, authenticated: status.get("authenticated").and_then(serde_json::Value::as_bool) == Some(true),
            message: None,
        }),
        Err(message) => Ok(WanCliStatus { version, authenticated: false, message: Some(message) }),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WanCliCredits {
    /// 当前可用积分。
    available_count: f64,
    /// 积分构成(会员额度 / 充值 / 赠送), 前端拼成 tooltip。
    member_count: Option<f64>,
    top_up_count: Option<f64>,
    bonus_count: Option<f64>,
}

fn json_number(value: Option<&serde_json::Value>) -> Option<f64> {
    match value? {
        serde_json::Value::Number(number) => number.as_f64(),
        serde_json::Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// 查询万相 CLI 剩余积分(`wan credits --output json`), 设置页「万相 CLI」面板展示。
#[tauri::command]
pub async fn wan_cli_credits(executable: String) -> Result<WanCliCredits, String> {
    let value = run(&executable, &args(&["credits"]), 30).await?;
    let available_count = match json_number(value.get("availableCount").or_else(|| value.get("totalCount"))) {
        Some(number) => number,
        None => return Err("万相 CLI 未返回积分字段".to_string()),
    };
    let amount = value.get("amount");
    let amount_number = |key: &str| -> Option<f64> {
        json_number(amount.and_then(|item| item.get(key)))
    };
    Ok(WanCliCredits {
        available_count,
        member_count: amount_number("member"),
        top_up_count: amount_number("topUp"),
        bonus_count: amount_number("bonus"),
    })
}

#[tauri::command]
pub async fn wan_cli_login(executable: String, site: String, access_key: String) -> Result<(), String> {
    if !matches!(site.as_str(), "cn" | "intl") { return Err("万相站点必须为 cn 或 intl".into()); }
    let key = access_key.trim();
    if !key.starts_with("wan-sk.") || key.chars().any(char::is_whitespace) {
        return Err("请填写万相账号页面创建的 AccessKey（wan-sk.…）".into());
    }
    // The official CLI owns credential persistence and file permissions.
    let result = run(&executable, &args(&["auth", "login", "--site", &site, "--access-key", key]), 30)
        .await.map_err(|error| error.replace(key, "[REDACTED]"))?;
    if result.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("万相 AccessKey 配置失败".into());
    }
    Ok(())
}
