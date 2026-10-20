// ---------------------------------------------------------------------------
// media 视频协议(api666888 / 灵柯同源网关)
//
// 本站自有异步协议, 与通用 OpenAI 兼容视频的差异:
//   - 提交 `POST /v1/media/generate`, 请求体是 **params 信封**:
//     { model, prompt, params: { duration(字符串), aspect_ratio, resolution,
//       image_url[], video_url[], audio_url[] } }
//   - 响应 `{"code":200,"data":{"task_id":123}}` —— task_id 可能是数字,
//     通用 `video_task_id` 只认字符串, 所以这里自己解析。
//   - 轮询优先 `GET /v1/skills/task-status?task_id=…`(字段更全),
//     兼容端点 `/v1/media/status?task_id=…`; 终态由 `is_final` + `state` 判定,
//     成片在 `result_url`。
//
// 覆盖的模型(seedance 2.5 / 2.0 的 参考生 / 全能参考 / 首尾帧 / 文生 共 7 个),
// 参数枚举见 `registry.ts` 的 `API666888_VIDEO_OPTION_TABLE`。
// ---------------------------------------------------------------------------
use serde_json::{json, Value};

use crate::ai::error::AIError;
use crate::ai::providers::video_protocols::{
    describe_reqwest_error, fetch_json, http_error, meta_string, queued, string_array_param, SubmitContext,
};
use crate::ai::{GenerateVideoRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission};

pub const TRANSPORT: &str = "media-generate";
const SUBMIT_PATH: &str = "/v1/media/generate";
const STATUS_PATH: &str = "/v1/skills/task-status?task_id={taskId}";
const PLATFORM_LABEL: &str = "API666888";

fn api_model(request: &GenerateVideoRequest) -> String {
    request
        .model
        .split_once('/')
        .map(|(_, model)| model.to_string())
        .unwrap_or_else(|| request.model.clone())
}

/// 从 `{"code":200,"data":{"task_id":123}}` 里取任务号 —— 数字/字符串都认。
fn task_id_of(payload: &Value) -> Option<String> {
    fn id_of(value: &Value) -> Option<String> {
        match value {
            Value::Object(map) => {
                for key in ["task_id", "taskId", "id"] {
                    match map.get(key) {
                        Some(Value::String(text)) if !text.trim().is_empty() => {
                            return Some(text.trim().to_string())
                        }
                        Some(Value::Number(number)) => return Some(number.to_string()),
                        _ => {}
                    }
                }
                for key in ["data", "result", "task"] {
                    if let Some(found) = map.get(key).and_then(id_of) {
                        return Some(found);
                    }
                }
                None
            }
            _ => None,
        }
    }
    id_of(payload)
}

/// 业务错误包: `{"code":400,"msg":"…"}` —— HTTP 200 也可能是失败。
fn business_error(payload: &Value) -> Option<String> {
    let map = payload.as_object()?;
    let code = map.get("code")?;
    let failed = match code {
        Value::Number(number) => number.as_i64().is_some_and(|value| value != 0 && value != 200),
        Value::String(text) => !matches!(text.trim(), "" | "0" | "200" | "success" | "ok"),
        _ => false,
    };
    if !failed {
        return None;
    }
    let message = ["msg", "message", "error"]
        .iter()
        .find_map(|key| map.get(*key).and_then(Value::as_str))
        .unwrap_or("未知错误");
    Some(format!("{} {}", code, message.trim()))
}

fn build_body(request: &GenerateVideoRequest, model: &str) -> Value {
    let mut params = json!({
        // 平台把 duration 定义成 enum<字符串>, 传数字会被判参数非法。
        "duration": request.duration.max(1).to_string(),
        "aspect_ratio": request.aspect_ratio,
    });
    let object = params.as_object_mut().expect("params 一定是对象");
    if let Some(resolution) = request
        .video_resolution
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        object.insert("resolution".into(), Value::String(resolution.to_string()));
    }
    let images: Vec<String> = request
        .reference_images
        .clone()
        .unwrap_or_default()
        .into_iter()
        .take(10)
        .collect();
    if !images.is_empty() {
        object.insert("image_url".into(), json!(images));
    }
    let videos = string_array_param(request, "reference_videos", 3);
    if !videos.is_empty() {
        object.insert("video_url".into(), json!(videos));
    }
    let audios: Vec<String> = request
        .reference_audio
        .clone()
        .unwrap_or_default()
        .into_iter()
        .take(3)
        .collect();
    if !audios.is_empty() {
        object.insert("audio_url".into(), json!(audios));
    }

    json!({
        "model": model,
        "prompt": request.prompt,
        "params": params,
    })
}

pub async fn submit(
    ctx: &SubmitContext,
    request: &GenerateVideoRequest,
) -> Result<ProviderTaskSubmission, AIError> {
    let model = api_model(request);
    let body = build_body(request, &model);
    let submit_url = ctx.endpoint(Some(SUBMIT_PATH), SUBMIT_PATH, None);
    let response = ctx
        .client
        .post(&submit_url)
        .bearer_auth(&ctx.api_key)
        .header("Accept-Encoding", "identity")
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            AIError::Provider(format!(
                "{} 视频提交失败(网络): {}",
                PLATFORM_LABEL,
                describe_reqwest_error(&error)
            ))
        })?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(http_error(
            &format!("{} 视频请求失败", PLATFORM_LABEL),
            status,
            &raw,
            &submit_url,
        ));
    }
    if let Some(reason) = business_error(&payload) {
        return Err(AIError::TaskFailed(format!("{} 视频请求失败: {}", PLATFORM_LABEL, reason)));
    }
    let task_id = task_id_of(&payload).ok_or_else(|| {
        AIError::TaskFailed(format!(
            "{} 响应中未找到任务 ID: {}",
            PLATFORM_LABEL,
            crate::ai::providers::video_protocols::assets::truncate(&payload.to_string(), 600)
        ))
    })?;
    let query_url = ctx.endpoint(Some(STATUS_PATH), STATUS_PATH, Some(&task_id));
    Ok(queued(task_id, &ctx.provider_id, TRANSPORT, query_url, None))
}

/// 状态体可能在顶层, 也可能被 `data` 包一层。
fn status_body(payload: &Value) -> &Value {
    payload
        .get("data")
        .filter(|value| value.is_object())
        .unwrap_or(payload)
}

pub async fn poll(
    ctx: &crate::ai::providers::video_protocols::PollContext,
    metadata: &serde_json::Map<String, Value>,
    _handle: &ProviderTaskHandle,
) -> Result<ProviderTaskPollResult, AIError> {
    // 落库的 query_url 可能指向"增强版"; 老任务若只记了兼容端点也照用。
    let query_url = meta_string(metadata, "query_url")
        .ok_or_else(|| AIError::InvalidRequest("视频任务缺少查询地址, 无法续查".into()))?;
    let query_url = if query_url.contains("/v1/media/status") {
        query_url.replace("/v1/media/status", "/v1/skills/task-status")
    } else {
        query_url.to_string()
    };
    let payload = fetch_json(&ctx.client, &ctx.api_key, &query_url, PLATFORM_LABEL).await?;
    Ok(classify_media(&payload))
}

fn classify_media(payload: &Value) -> ProviderTaskPollResult {
    let body = status_body(payload);
    let is_final = body.get("is_final").and_then(Value::as_bool).unwrap_or(false);
    let state = body
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let result_url = ["result_url", "video_url", "url"]
        .iter()
        .find_map(|key| body.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let error = body
        .get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if is_final {
        if matches!(state.as_str(), "success" | "succeeded" | "completed" | "finished" | "done") {
            return match result_url {
                Some(url) => ProviderTaskPollResult::Succeeded(url.to_string()),
                None => ProviderTaskPollResult::Failed(format!(
                    "{} 任务已完成但没有返回成片地址",
                    PLATFORM_LABEL
                )),
            };
        }
        if let Some(reason) = error {
            return ProviderTaskPollResult::Failed(format!("{} {}", PLATFORM_LABEL, reason));
        }
        return ProviderTaskPollResult::Failed(format!(
            "{} 任务失败(state={})",
            PLATFORM_LABEL,
            if state.is_empty() { "unknown" } else { &state }
        ));
    }
    if matches!(state.as_str(), "failed" | "error" | "canceled" | "cancelled" | "expired" | "rejected") {
        return ProviderTaskPollResult::Failed(format!(
            "{} 任务失败(state={}){}",
            PLATFORM_LABEL,
            state,
            error.map(|reason| format!(": {}", reason)).unwrap_or_default()
        ));
    }
    ProviderTaskPollResult::Running
}

/// 前端 `injectCustomApiRequestMode` 会按平台 id / Base URL 注入好 transport;
/// Base URL 兜底只在 transport 为空时生效, 免得用户显式配的通用协议被抢走。
pub fn matches(transport: &str, provider_base_url: &str, _provider_id: &str) -> bool {
    transport == TRANSPORT
        || (transport.is_empty()
            && (provider_base_url.contains("api666888.com") || provider_base_url.contains("lingkeai")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> GenerateVideoRequest {
        GenerateVideoRequest {
            prompt: "海边的日落".into(),
            model: "custom:api666888/seedance-2.5-anmiao-wensheng".into(),
            duration: 12,
            aspect_ratio: "9:16".into(),
            video_resolution: Some("1080p".into()),
            image_mode: None,
            reference_images: None,
            reference_audio: None,
            extra_params: None,
        }
    }

    #[test]
    fn 请求体走_params_信封且_duration_是字符串() {
        let body = build_body(&request(), "seedance-2.5-anmiao-wensheng");
        assert_eq!(body["model"], "seedance-2.5-anmiao-wensheng");
        assert_eq!(body["prompt"], "海边的日落");
        assert_eq!(body["params"]["duration"], "12");
        assert_eq!(body["params"]["aspect_ratio"], "9:16");
        assert_eq!(body["params"]["resolution"], "1080p");
        assert!(body.get("duration").is_none());
    }

    #[test]
    fn 任务号数字与字符串都能解析() {
        let numeric = json!({"code": 200, "data": {"task_id": 123456}, "msg": "任务创建成功"});
        assert_eq!(task_id_of(&numeric).as_deref(), Some("123456"));
        let textual = json!({"code": 200, "data": {"task_id": "abc-1"}});
        assert_eq!(task_id_of(&textual).as_deref(), Some("abc-1"));
    }

    #[test]
    fn 业务错误包必须报错而不是当成功() {
        let payload = json!({"code": 400, "msg": "参数非法: resolution"});
        assert!(business_error(&payload).is_some());
        assert!(business_error(&json!({"code": 200, "data": {"task_id": 1}})).is_none());
    }

    #[test]
    fn 终态判定() {
        let running = json!({"is_final": false, "state": "running", "progress": "30"});
        assert!(matches!(classify_media(&running), ProviderTaskPollResult::Running));

        let done = json!({"is_final": true, "state": "success", "result_url": "https://cdn/x.mp4"});
        match classify_media(&done) {
            ProviderTaskPollResult::Succeeded(url) => assert_eq!(url, "https://cdn/x.mp4"),
            other => panic!("期望成功, 实际 {:?}", other),
        }

        let failed = json!({"is_final": true, "state": "failed", "error": "内容审核不通过"});
        match classify_media(&failed) {
            ProviderTaskPollResult::Failed(reason) => assert!(reason.contains("内容审核")),
            other => panic!("期望失败, 实际 {:?}", other),
        }
    }

    #[test]
    fn data_包裹的状态体也能读() {
        let wrapped = json!({"code": 200, "data": {"is_final": true, "state": "success", "result_url": "https://cdn/y.mp4"}});
        assert!(matches!(classify_media(&wrapped), ProviderTaskPollResult::Succeeded(_)));
    }
}
