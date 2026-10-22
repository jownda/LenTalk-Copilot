// ---------------------------------------------------------------------------
// ark_anmiao 视频协议(api666888 的"满血版"方舟线路)
//
// 火山方舟官方格式, 与本站 media 协议完全不同:
//   - 提交 `POST /api/v3/anmiao/contents/generations/tasks`
//     body = { model, content: [{type:"text",text}, {type:"image_url",image_url:{url}}…],
//              duration(整数), ratio, resolution }
//     响应 `{"id":"99936297"}`
//   - 轮询 `GET /api/v3/anmiao/contents/generations/tasks/{id}`
//     直到 `status` 为 succeeded / failed; 成片在 `content.video_url`。
//
// 目前挂在这条链路上的是 SD 2.5 / 2.0 的"满血版 按秒"两个模型。
// ---------------------------------------------------------------------------
use serde_json::{json, Value};

use crate::ai::error::AIError;
use crate::ai::providers::video_protocols::{
    describe_reqwest_error, fetch_json, http_error, meta_string, queued, string_array_param, SubmitContext,
};
use crate::ai::{GenerateVideoRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission};

pub const TRANSPORT: &str = "ark-anmiao";
const SUBMIT_PATH: &str = "/api/v3/anmiao/contents/generations/tasks";
const TASK_PATH: &str = "/api/v3/anmiao/contents/generations/tasks/{taskId}";
const PLATFORM_LABEL: &str = "API666888 方舟";

fn api_model(request: &GenerateVideoRequest) -> String {
    request
        .model
        .split_once('/')
        .map(|(_, model)| model.to_string())
        .unwrap_or_else(|| request.model.clone())
}

/// 方舟的 content 是"多段素材"数组: 文本一段、每张图一段、视频/音频各一段。
fn build_content(request: &GenerateVideoRequest) -> Vec<Value> {
    let mut content = vec![json!({ "type": "text", "text": request.prompt })];
    for url in request
        .reference_images
        .clone()
        .unwrap_or_default()
        .into_iter()
        .take(10)
    {
        content.push(json!({ "type": "image_url", "image_url": { "url": url } }));
    }
    for url in string_array_param(request, "reference_videos", 1) {
        content.push(json!({ "type": "video_url", "video_url": { "url": url } }));
    }
    for url in request
        .reference_audio
        .clone()
        .unwrap_or_default()
        .into_iter()
        .take(1)
    {
        content.push(json!({ "type": "audio_url", "audio_url": { "url": url } }));
    }
    content
}

fn build_body(request: &GenerateVideoRequest, model: &str) -> Value {
    let mut body = json!({
        "model": model,
        "content": build_content(request),
        // 方舟的 duration 是整数; 这里和 media 协议相反, 不能传字符串。
        "duration": request.duration.max(1),
        "ratio": request.aspect_ratio,
    });
    if let Some(resolution) = request
        .video_resolution
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body.as_object_mut()
            .expect("body 一定是对象")
            .insert("resolution".into(), Value::String(resolution.to_string()));
    }
    body
}

fn task_id_of(payload: &Value) -> Option<String> {
    match payload {
        Value::Object(map) => {
            for key in ["id", "task_id", "taskId"] {
                match map.get(key) {
                    Some(Value::String(text)) if !text.trim().is_empty() => {
                        return Some(text.trim().to_string())
                    }
                    Some(Value::Number(number)) => return Some(number.to_string()),
                    _ => {}
                }
            }
            for key in ["data", "result"] {
                if let Some(found) = map.get(key).and_then(task_id_of) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
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
    let task_id = task_id_of(&payload).ok_or_else(|| {
        AIError::TaskFailed(format!(
            "{} 响应中未找到任务 ID: {}",
            PLATFORM_LABEL,
            crate::ai::providers::video_protocols::assets::truncate(&payload.to_string(), 600)
        ))
    })?;
    let query_url = ctx.endpoint(Some(TASK_PATH), TASK_PATH, Some(&task_id));
    Ok(queued(task_id, &ctx.provider_id, TRANSPORT, query_url, None))
}

fn video_url_of(payload: &Value) -> Option<String> {
    let content = payload.get("content")?;
    if let Some(url) = content.get("video_url").and_then(Value::as_str) {
        return Some(url.trim().to_string()).filter(|value| !value.is_empty());
    }
    // 部分线路把成片放在 content[] 数组里(`{"type":"video_url","video_url":{"url"}}`)。
    if let Some(items) = content.as_array() {
        for item in items {
            let url = item
                .get("video_url")
                .and_then(|value| value.get("url").or(Some(value)))
                .and_then(Value::as_str)
                .or_else(|| item.get("url").and_then(Value::as_str));
            if let Some(url) = url.map(str::trim).filter(|value| !value.is_empty()) {
                return Some(url.to_string());
            }
        }
    }
    None
}

fn classify_ark(payload: &Value) -> ProviderTaskPollResult {
    let body = payload
        .get("data")
        .filter(|value| value.is_object())
        .unwrap_or(payload);
    let status = body
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match status.as_str() {
        "succeeded" | "success" | "completed" | "finished" => match video_url_of(body) {
            Some(url) => ProviderTaskPollResult::Succeeded(url),
            None => ProviderTaskPollResult::Failed(format!(
                "{} 任务已完成但没有返回成片地址",
                PLATFORM_LABEL
            )),
        },
        "failed" | "error" | "canceled" | "cancelled" | "expired" | "rejected" => {
            let reason = body
                .get("error")
                .and_then(|value| value.get("message").or(Some(value)))
                .and_then(Value::as_str)
                .unwrap_or("平台未给出原因");
            ProviderTaskPollResult::Failed(format!("{} {}", PLATFORM_LABEL, reason.trim()))
        }
        _ => ProviderTaskPollResult::Running,
    }
}

pub async fn poll(
    ctx: &crate::ai::providers::video_protocols::PollContext,
    metadata: &serde_json::Map<String, Value>,
    _handle: &ProviderTaskHandle,
) -> Result<ProviderTaskPollResult, AIError> {
    let query_url = meta_string(metadata, "query_url")
        .ok_or_else(|| AIError::InvalidRequest("视频任务缺少查询地址, 无法续查".into()))?;
    let payload = fetch_json(&ctx.client, &ctx.api_key, query_url, PLATFORM_LABEL).await?;
    Ok(classify_ark(&payload))
}

pub fn matches(transport: &str, _provider_base_url: &str, _provider_id: &str) -> bool {
    transport == TRANSPORT
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> GenerateVideoRequest {
        GenerateVideoRequest {
            prompt: "金毛奔向浪花".into(),
            model: "custom:api666888/seedance-2.5-guanfang-anmiao".into(),
            duration: 8,
            aspect_ratio: "16:9".into(),
            video_resolution: Some("720p".into()),
            image_mode: None,
            reference_images: Some(vec!["data:image/png;base64,AAA".into()]),
            reference_audio: None,
            extra_params: None,
        }
    }

    #[test]
    fn 请求体是方舟的_content_数组且_duration_为整数() {
        let body = build_body(&request(), "seedance-2.5-guanfang-anmiao");
        assert_eq!(body["model"], "seedance-2.5-guanfang-anmiao");
        assert_eq!(body["duration"], 8);
        assert!(body["duration"].is_number());
        assert_eq!(body["ratio"], "16:9");
        assert_eq!(body["resolution"], "720p");
        let content = body["content"].as_array().expect("content 是数组");
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(content[1]["image_url"]["url"], "data:image/png;base64,AAA");
    }

    #[test]
    fn 成片地址从_content_取() {
        let payload = json!({"status": "succeeded", "content": {"video_url": "https://cdn/a.mp4"}});
        match classify_ark(&payload) {
            ProviderTaskPollResult::Succeeded(url) => assert_eq!(url, "https://cdn/a.mp4"),
            other => panic!("期望成功, 实际 {:?}", other),
        }
    }

    #[test]
    fn 运行中与失败的判定() {
        assert!(matches!(
            classify_ark(&json!({"status": "running"})),
            ProviderTaskPollResult::Running
        ));
        match classify_ark(&json!({"status": "failed", "error": {"message": "生成失败: 审核"}})) {
            ProviderTaskPollResult::Failed(reason) => assert!(reason.contains("审核")),
            other => panic!("期望失败, 实际 {:?}", other),
        }
    }
}
