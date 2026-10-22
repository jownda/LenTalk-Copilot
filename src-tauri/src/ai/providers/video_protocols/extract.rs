// ---------------------------------------------------------------------------
// 平台响应解析(与前端 `ai.ts` / `videoApi.ts` 的取值逻辑逐条对齐)
//
// 这里刻意**不复用** `OpenAICompatibleProvider::video_result_url` —— 那套只认
// `url` / `data` / `result` 几个键, 覆盖不到专有协议的真实形状:
//   - 字子动画 / Kling 的成片地址会落在顶层数组里(`[{ "url": ... }]`);
//   - 帧间的成片地址是**相对路径**, 还要再拼站点根;
//   - Sub2API 的 task_id 可能是数字。
// 少认一个键的表现是「任务一直轮询到超时」(付费任务白等), 比多认一个键危险得多,
// 所以这几个协议统一走这里更宽松的取值。
// ---------------------------------------------------------------------------
use serde_json::{Map, Value};

/// 前端 `getVideoResultUrl` 遍历的键序(顺序即优先级, 不能重排)。
const RESULT_KEYS: [&str; 24] = [
    "video_url",
    "videoUrl",
    "result_url",
    "resultUrl",
    "url",
    "uri",
    "value",
    "output_url",
    "download_url",
    "downloadUrl",
    "data",
    "videos",
    "video_urls",
    "videoUrls",
    "output_videos",
    "outputs",
    "output",
    "results",
    "task_result",
    "files",
    "task",
    "content",
    "detail",
    "response",
];

/// 前端 `getVideoTaskId` 遍历的键序。
const TASK_ID_KEYS: [&str; 11] = [
    "id",
    "task_id",
    "taskId",
    "video_id",
    "videoId",
    "job_id",
    "jobId",
    "request_id",
    "requestId",
    "generation_id",
    "generationId",
];

const TASK_ID_NESTED_KEYS: [&str; 8] = [
    "data", "detail", "result", "task", "job", "video", "generation", "response",
];

const FAILURE_KEYS: [&str; 7] = [
    "error",
    "error_message",
    "failure_reason",
    "fail_reason",
    "message",
    "reason",
    "detail",
];

const FAILURE_NESTED_KEYS: [&str; 5] = ["data", "result", "task", "job", "response"];

/// 前端正则 `https?:\/\/[^\s\])}",]+` 的等价实现: 从串里抠出第一个内嵌 URL。
///
/// 有些平台把地址写在文案里(`"视频已就绪: https://cdn/x.mp4"`), 只认「整串是 URL」
/// 会漏掉这类响应, 于是任务白等到超时。
fn find_embedded_url(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut index = 0usize;
    while index + 7 <= bytes.len() {
        if &bytes[index..index + 4] == b"http" {
            let rest = &lower[index..];
            if rest.starts_with("http://") || rest.starts_with("https://") {
                let tail = &value[index..];
                let end = tail
                    .char_indices()
                    .find(|(_, ch)| {
                        ch.is_whitespace() || matches!(ch, ']' | ')' | '}' | '"' | ',')
                    })
                    .map(|(offset, _)| offset)
                    .unwrap_or(tail.len());
                // 正则要求 `//` 之后至少还有一个字符。
                if end > tail.find("//").map(|offset| offset + 2).unwrap_or(end) {
                    return Some(tail[..end].to_string());
                }
            }
        }
        index += 1;
    }
    None
}

fn push_url(found: &mut Vec<String>, raw: &str) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("data:video/") {
        if !found.iter().any(|item| item == trimmed) {
            found.push(trimmed.to_string());
        }
    }
    if let Some(embedded) = find_embedded_url(trimmed) {
        if !found.iter().any(|item| item == &embedded) {
            found.push(embedded);
        }
    }
}

fn collect_result_urls(payload: &Value, found: &mut Vec<String>) {
    match payload {
        Value::String(text) => push_url(found, text),
        Value::Array(items) => items.iter().for_each(|item| collect_result_urls(item, found)),
        Value::Object(map) => {
            for key in RESULT_KEYS {
                if let Some(value) = map.get(key) {
                    collect_result_urls(value, found);
                }
            }
        }
        _ => {}
    }
}

/// 深度优先取第一个成片地址。
pub fn result_url(payload: &Value) -> Option<String> {
    let mut found: Vec<String> = Vec::new();
    collect_result_urls(payload, &mut found);
    found.into_iter().next()
}

fn scalar_id(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// 深度优先取任务 ID。与前端一致: **顶层裸字符串不算 ID**(只有数字/对象才算),
/// 否则 `{"status":"completed"}` 这类响应会被误当成 task_id。
pub fn task_id(payload: &Value) -> Option<String> {
    match payload {
        Value::Number(number) => Some(number.to_string()),
        Value::Array(items) => items.iter().find_map(task_id),
        Value::Object(map) => TASK_ID_KEYS
            .iter()
            .find_map(|key| map.get(*key).and_then(scalar_id))
            .or_else(|| {
                TASK_ID_NESTED_KEYS
                    .iter()
                    .find_map(|key| map.get(*key).and_then(task_id))
            }),
        _ => None,
    }
}

/// 任务状态, 统一大写。前端 `getVideoTaskStatus` 只认对象 —— 顶层数组返回空串,
/// 这一行为必须保留: Kling `motion-control` 的查询返回数组, 其中元素可能带
/// `status`, 若在这一层就下判会把「列表中某一个任务的终态」当成整单的终态。
pub fn task_status(payload: &Value) -> String {
    match payload {
        Value::Object(map) => {
            if let Some(status) = ["status", "task_status", "state"]
                .iter()
                .find_map(|key| map.get(*key).and_then(Value::as_str))
            {
                return status.trim().to_ascii_uppercase();
            }
            ["data", "detail", "result", "task"]
                .iter()
                .map(|key| map.get(*key).map(task_status).unwrap_or_default())
                .find(|status| !status.is_empty())
                .unwrap_or_default()
        }
        _ => String::new(),
    }
}

fn visit_failure(value: &Value, depth: usize) -> Option<String> {
    if depth > 6 {
        return None;
    }
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Array(items) => items.iter().find_map(|item| visit_failure(item, depth + 1)),
        Value::Object(map) => FAILURE_KEYS
            .iter()
            .find_map(|key| map.get(*key).and_then(|node| visit_failure(node, depth + 1)))
            .or_else(|| {
                FAILURE_NESTED_KEYS
                    .iter()
                    .find_map(|key| map.get(*key).and_then(|node| visit_failure(node, depth + 1)))
            }),
        _ => None,
    }
}

/// 从失败响应里挖出平台给出的具体原因(比裸 status 有用得多)。
pub fn failure_reason(payload: &Value) -> Option<String> {
    visit_failure(payload, 0).map(|reason| reason.chars().take(800).collect())
}

/// 已知的「完成」状态枚举。各家写法不一, 集中维护。
pub fn is_completed_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_uppercase().as_str(),
        "COMPLETED" | "COMPLETE" | "SUCCESS" | "SUCCEEDED" | "DONE"
    )
}

/// 帧间 `extractTaskId`: 兼顾 asset 上传响应与任务响应。
pub fn task_or_asset_id(payload: &Value) -> Option<String> {
    match payload {
        Value::Array(items) => items.iter().find_map(task_or_asset_id),
        Value::Object(map) => ["id", "asset_id", "assetId", "task_id", "taskId", "job_id", "jobId"]
            .iter()
            .find_map(|key| map.get(*key).and_then(scalar_id))
            .or_else(|| {
                ["data", "task", "job", "result"]
                    .iter()
                    .find_map(|key| map.get(*key).and_then(task_or_asset_id))
            }),
        _ => None,
    }
}

fn is_media_string(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("data:") || lower.starts_with('/')
}

/// 帧间 `extractMediaReference`: 与 `result_url` 的差别是它**还认** `data:` 任意类型
/// 与以 `/` 开头的站内相对路径, 并且优先看 `b64_json` / `base64` 内联字段。
pub fn media_reference(payload: &Value, kind: MediaKind) -> Option<String> {
    match payload {
        Value::String(text) => {
            let trimmed = text.trim();
            is_media_string(trimmed).then(|| trimmed.to_string())
        }
        Value::Array(items) => items.iter().find_map(|item| media_reference(item, kind)),
        Value::Object(map) => {
            for key in ["b64_json", "base64", "data_base64"] {
                if let Some(encoded) = map.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()) {
                    if encoded.starts_with("data:") {
                        return Some(encoded.to_string());
                    }
                    return Some(format!("data:{};base64,{}", kind.default_mime(), encoded));
                }
            }
            let preferred = kind.preferred_keys();
            for key in preferred {
                if let Some(value) = map.get(*key) {
                    if let Some(text) = value.as_str() {
                        let trimmed = text.trim();
                        if is_media_string(trimmed) {
                            return Some(trimmed.to_string());
                        }
                    }
                    if let Some(nested) = media_reference(value, kind) {
                        return Some(nested);
                    }
                }
            }
            for key in ["data", "result", "task", "outputs", "files", "detail"] {
                if let Some(nested) = map.get(key).and_then(|node| media_reference(node, kind)) {
                    return Some(nested);
                }
            }
            None
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Video,
}

impl MediaKind {
    fn default_mime(self) -> &'static str {
        match self {
            MediaKind::Image => "image/png",
            MediaKind::Video => "video/mp4",
        }
    }

    fn preferred_keys(self) -> &'static [&'static str] {
        match self {
            MediaKind::Image => &[
                "url",
                "image_url",
                "download_url",
                "downloadUrl",
                "images",
                "image",
                "output",
            ],
            MediaKind::Video => &[
                "url",
                "video_url",
                "videoUrl",
                "download_url",
                "downloadUrl",
                "video",
                "output",
            ],
        }
    }
}

/// 小工具: 安全取对象。
pub fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_nested_video_url_in_array() {
        let payload = serde_json::json!({ "data": { "videos": [{ "url": "https://cdn/a.mp4" }] } });
        assert_eq!(result_url(&payload).as_deref(), Some("https://cdn/a.mp4"));
    }

    #[test]
    fn finds_embedded_url_in_plain_text() {
        // 地址写在文案里是真实形态(`output` / `content` 一类字段会带说明文字)。
        // 注意键集合与前端严格一致: 前端只遍历固定键序, 不遍历 `message`。
        let payload = serde_json::json!({ "output": "视频已就绪: https://cdn/b.mp4 请查收" });
        assert_eq!(result_url(&payload).as_deref(), Some("https://cdn/b.mp4"));
    }

    #[test]
    fn ignores_keys_outside_frontend_key_set() {
        let payload = serde_json::json!({ "message": "视频已就绪: https://cdn/b.mp4" });
        assert_eq!(result_url(&payload), None);
    }

    #[test]
    fn report_url_wins_over_task_key() {
        let payload = serde_json::json!({ "url": "https://cdn/c.mp4", "id": "t1" });
        assert_eq!(result_url(&payload).as_deref(), Some("https://cdn/c.mp4"));
    }

    #[test]
    fn task_id_accepts_numeric_and_rejects_bare_string() {
        assert_eq!(task_id(&serde_json::json!({ "id": 1234 })).as_deref(), Some("1234"));
        assert_eq!(task_id(&serde_json::json!("done")), None);
        assert_eq!(
            task_id(&serde_json::json!({ "data": { "videoId": "v-9" } })).as_deref(),
            Some("v-9")
        );
    }

    #[test]
    fn status_is_uppercased_and_array_awareness_matches_frontend() {
        assert_eq!(task_status(&serde_json::json!({ "state": "completed" })), "COMPLETED");
        // 顶层数组不下判(前端同样返回空串)。
        assert_eq!(task_status(&serde_json::json!([{ "status": "completed" }])), "");
    }

    #[test]
    fn failure_reason_finds_deep_message() {
        let payload = serde_json::json!({ "data": { "task": { "error": "生成失败: 版权" } } });
        assert_eq!(failure_reason(&payload).as_deref(), Some("生成失败: 版权"));
    }

    #[test]
    fn media_reference_accepts_relative_path_and_inline_base64() {
        assert_eq!(
            media_reference(&serde_json::json!({ "url": "/v1/tasks/1/video" }), MediaKind::Video).as_deref(),
            Some("/v1/tasks/1/video")
        );
        assert_eq!(
            media_reference(&serde_json::json!({ "b64_json": "AAAA" }), MediaKind::Video).as_deref(),
            Some("data:video/mp4;base64,AAAA")
        );
    }
}
