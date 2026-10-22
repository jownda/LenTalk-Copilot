//! 账户余额查询(设置页「推荐平台」卡片用)。
//!
//! 各平台的余额接口形态差异很大, 这里按「平台族」分派:
//! - `runninghub`: POST /uc/openapi/accountStatus, 返回 RH 币余额;
//! - `openai-billing`: One-API / New-API 系中转站通用的
//!   GET /v1/dashboard/billing/subscription, `soft_limit_usd` 就是剩余额度。
//!
//! **查不到就返回 Err**(前端据此不渲染余额徽章)。余额是"顺带"展示的信息,
//! 宁可什么都不显示, 也不要猜一个数字出来误导用户。

use std::time::Duration;

use serde::Serialize;

/// 余额查询是交互式的顺带信息, 时间给短一点, 别让设置页卡住。
const BALANCE_TIMEOUT_SECONDS: u64 = 15;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBalance {
    /// 可用余额, 已按 `unit` 归一。
    pub amount: f64,
    /// 展示单位: `USD` / `RH`。
    pub unit: String,
    /// 额度明细(总额度 / 已用 / 注册赠送等), 前端放进 tooltip。
    pub detail: Option<String>,
}

fn build_client() -> reqwest::Client {
    // 与 openai_compat 的短超时 client 保持一致: 走系统/环境代理由 reqwest 自行处理。
    reqwest::Client::builder()
        .http1_only()
        .timeout(Duration::from_secs(BALANCE_TIMEOUT_SECONDS))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// 去掉尾部斜杠与 `/v1` 后缀 —— 预设里有的写 `https://host/v1`、有的写 `https://host`,
/// 拼接口路径前必须归一, 否则会出现 `/v1/v1/dashboard/...` 这种 404。
fn api_root(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("平台地址为空".to_string());
    }
    Ok(trimmed.strip_suffix("/v1").unwrap_or(trimmed).to_string())
}

/// 数字 / 数字字符串(中转站经常把余额序列化成字符串)统一取成 f64。
fn value_as_f64(value: &serde_json::Value) -> Option<f64> {
    match value {
        serde_json::Value::Number(number) => number.as_f64(),
        serde_json::Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn read_number(object: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(value_as_f64))
}

/// 解析 RunningHub `accountStatus` 的响应体(抽成纯函数以便单测)。
fn parse_runninghub_balance(payload: &serde_json::Value) -> Result<ProviderBalance, String> {
    if read_number(payload, &["code"]) != Some(0.0) {
        let message = payload
            .get("msg")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("未知错误");
        return Err(format!("RunningHub 返回错误: {message}"));
    }
    let data = payload
        .get("data")
        .ok_or_else(|| "RunningHub 未返回账户信息".to_string())?;
    let coins = read_number(data, &["remainCoins", "remainGpuCoins", "walletBalance"])
        .ok_or_else(|| "RunningHub 账户信息里没有余额字段".to_string())?;
    // 并行任务数只是补充信息; 部分账号类型没有这个字段。
    let running_tasks = read_number(data, &["currentTaskCounts"]).unwrap_or(0.0) as i64;
    Ok(ProviderBalance {
        amount: coins,
        unit: "RH".to_string(),
        detail: Some(format!("运行中任务 {running_tasks}")),
    })
}

/// 解析 One-API / New-API 系的额度响应体(抽成纯函数以便单测)。
fn parse_openai_billing_balance(payload: &serde_json::Value) -> Result<ProviderBalance, String> {
    let hard = read_number(payload, &["hard_limit_usd", "system_hard_limit_usd"]);
    let soft = read_number(payload, &["soft_limit_usd"]);
    let (amount, detail) = match (soft, hard) {
        (Some(soft), Some(hard)) => (
            soft,
            Some(format!(
                "总额度 ${hard:.2} · 已用 ${:.2}",
                (hard - soft).max(0.0)
            )),
        ),
        (Some(soft), None) => (soft, None),
        (None, Some(hard)) => {
            return Err(format!(
                "该平台只返回了总额度 ${hard:.2}, 无法判断剩余额度"
            ));
        }
        (None, None) => return Err("该平台返回里没有额度字段".to_string()),
    };
    Ok(ProviderBalance {
        amount,
        unit: "USD".to_string(),
        detail,
    })
}

/// RunningHub(国际版 / 国内版共用): `POST /uc/openapi/accountStatus`。
///
/// 成功时 `code == 0`, 余额在 `data.remainCoins`(单位为 RH 币)。
async fn query_runninghub(base_url: &str, api_key: &str) -> Result<ProviderBalance, String> {
    let url = format!("{}/uc/openapi/accountStatus", api_root(base_url)?);
    let response = build_client()
        .post(&url)
        .json(&serde_json::json!({ "apikey": api_key }))
        .send()
        .await
        .map_err(|error| format!("RunningHub 余额查询失败: {error}"))?;
    let status = response.status();
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("RunningHub 返回的不是 JSON: {error}"))?;
    if !status.is_success() {
        return Err(format!("RunningHub 余额查询失败(HTTP {status})"));
    }
    parse_runninghub_balance(&payload)
}

/// One-API / New-API 系中转站(知鸟AI 等): `GET /v1/dashboard/billing/subscription`。
///
/// 这两个字段的语义容易搞反: `hard_limit_usd` 是**总额度**(剩余 + 已用),
/// `soft_limit_usd` 才是**剩余额度** —— 所以优先用 soft, 兜底再自己算差额。
async fn query_openai_billing(base_url: &str, api_key: &str) -> Result<ProviderBalance, String> {
    let url = format!(
        "{}/v1/dashboard/billing/subscription",
        api_root(base_url)?
    );
    let response = build_client()
        .get(&url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|error| format!("余额查询失败: {error}"))?;
    let status = response.status();
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("平台返回的不是 JSON: {error}"))?;
    if !status.is_success() {
        // 401 是"这个平台的 Key 不对", 404 是"平台没有这个接口" —— 都不显示余额。
        return Err(format!("该平台未提供额度查询接口(HTTP {status})"));
    }

    parse_openai_billing_balance(&payload)
}

/// 查询平台余额。`kind` 由前端按 Base URL 判定:
/// - `runninghub`
/// - `openai-billing`
#[tauri::command]
pub async fn query_provider_balance(
    kind: String,
    base_url: String,
    api_key: String,
) -> Result<ProviderBalance, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("尚未填写 API Key".to_string());
    }
    match kind.trim() {
        "runninghub" => query_runninghub(&base_url, api_key).await,
        "openai-billing" => query_openai_billing(&base_url, api_key).await,
        other => Err(format!("暂不支持查询该平台的余额: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_root_strips_v1_suffix() {
        assert_eq!(api_root("https://host/v1").unwrap(), "https://host");
        assert_eq!(api_root("https://host/v1/").unwrap(), "https://host");
        assert_eq!(api_root("https://host").unwrap(), "https://host");
        assert_eq!(api_root("  https://host/  ").unwrap(), "https://host");
        assert!(api_root("   ").is_err());
    }

    #[test]
    fn read_number_accepts_numeric_strings() {
        let payload = serde_json::json!({ "remainCoins": "150.0", "currentTaskCounts": 2 });
        assert_eq!(read_number(&payload, &["remainCoins"]), Some(150.0));
        assert_eq!(read_number(&payload, &["currentTaskCounts"]), Some(2.0));
        assert_eq!(read_number(&payload, &["missing"]), None);
    }

    #[test]
    fn runninghub_balance_reads_coins() {
        // remainCoins 是字符串形式的数字(RunningHub 现状)。
        let payload = serde_json::json!({
            "code": 0,
            "msg": "success",
            "data": { "remainCoins": "150.0", "currentTaskCounts": "2" }
        });
        let balance = parse_runninghub_balance(&payload).expect("parses");
        assert_eq!(balance.amount, 150.0);
        assert_eq!(balance.unit, "RH");
        assert_eq!(balance.detail.as_deref(), Some("运行中任务 2"));
    }

    #[test]
    fn runninghub_balance_rejects_error_payload() {
        // 实测用假 Key 时返回的就是这个(HTTP 200 + code 806), 不能当成余额 0 显示。
        let payload = serde_json::json!({
            "code": 806,
            "msg": "APIKEY_USER_NOT_FOUND",
            "data": null
        });
        let error = parse_runninghub_balance(&payload).expect_err("rejects");
        assert!(error.contains("APIKEY_USER_NOT_FOUND"));
    }

    #[test]
    fn openai_billing_prefers_soft_limit_as_remaining() {
        // One-API 语义: hard_limit_usd 是总额度, soft_limit_usd 才是剩余。
        let payload = serde_json::json!({ "hard_limit_usd": 100.0, "soft_limit_usd": 87.66 });
        let balance = parse_openai_billing_balance(&payload).expect("parses");
        assert_eq!(balance.amount, 87.66);
        assert_eq!(balance.unit, "USD");
        assert_eq!(balance.detail.as_deref(), Some("总额度 $100.00 · 已用 $12.34"));
    }

    #[test]
    fn openai_billing_rejects_total_only_payload() {
        // 只给总额度时不能拿它当余额(会虚高), 宁可查不到。
        let payload = serde_json::json!({ "hard_limit_usd": 100.0 });
        assert!(parse_openai_billing_balance(&payload).is_err());
        assert!(parse_openai_billing_balance(&serde_json::json!({})).is_err());
    }
}
