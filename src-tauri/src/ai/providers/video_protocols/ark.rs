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

// ---------------------------------------------------------------------------
// 筷子 AI(aiopenapi.kuaizi.cn): 同样是火山方舟形态, 只有路径前缀不同。
//   提交 POST /ai-open-platform-api/api/v3/contents/generations/tasks
//   查询 GET  /ai-open-platform-api/api/v3/contents/generations/tasks/{id}
// 所以复用这一整套 content/轮询逻辑, 只按 provider 换路径与文案。
// ---------------------------------------------------------------------------
pub const KZ_PROVIDER_ID: &str = "kz-ai";
const KZ_SUBMIT_PATH: &str = "/ai-open-platform-api/api/v3/contents/generations/tasks";
const KZ_TASK_PATH: &str = "/ai-open-platform-api/api/v3/contents/generations/tasks/{taskId}";
const KZ_LABEL: &str = "筷子 AI";

/// 按 Base URL 判断, 不按 provider id —— 筷子在内置平台里的 id 可能被用户改成任意值,
/// 而域名是稳定的 (`aiopenapi.kuaizi.cn`)。
fn is_kuaizi(base_url: &str) -> bool {
    base_url.to_ascii_lowercase().contains("kuaizi.cn")
}

/// 按 provider 选路径与展示名。轮询用的完整 URL 在 submit 时就已写进 handle,
/// 所以这里只需要在提交阶段区分。
fn paths_for(base_url: &str) -> (&'static str, &'static str, &'static str) {
    if is_kuaizi(base_url) {
        (KZ_SUBMIT_PATH, KZ_TASK_PATH, KZ_LABEL)
    } else {
        (SUBMIT_PATH, TASK_PATH, PLATFORM_LABEL)
    }
}

fn api_model(request: &GenerateVideoRequest) -> String {
    request
        .model
        .split_once('/')
        .map(|(_, model)| model.to_string())
        .unwrap_or_else(|| request.model.clone())
}

/// 筷子AI 的素材条数上限(《视频生成 兼容接口文档》v1.6「分档参数矩阵」)。
///
/// 🔴 与前端 `src/features/canvas/models/kuaiziModels.ts` 的 `maxImages` / `maxAudios`
/// 是**两份实现**: 前端裁是为了不白上传超限素材, 这里裁是为了不因为多传一条让整单
/// 400。改上限时两处必须一起改。
fn kuaizi_limits(model: &str) -> (usize, usize) {
    if is_seedance_25(model) {
        // 2.5: 图 ≤30 / 视频 ≤10 / 音频 ≤10
        (30, 10)
    } else {
        // 2.0 三兄弟(pro / fast / mini): 图 ≤9 / 视频 ≤3 / 音频 ≤3
        (9, 3)
    }
}

fn is_seedance_25(model: &str) -> bool {
    model.trim().eq_ignore_ascii_case("doubao-seedance-2-5-260628")
}

/// 方舟的 content 是"多段素材"数组: 文本一段、每张图一段、视频/音频各一段。
///
/// 筷子AI 额外要求:
/// - `role` 显式区分首帧 / 尾帧 —— 只给 image_url 时它按普通参考图处理, 用户在
///   节点里选的「首尾帧」就会静默退化成「参考图」;
/// - 参考素材条数按模型分档(见 `kuaizi_limits`), 超限在创建任务时同步 400。
fn build_content(request: &GenerateVideoRequest, kuaizi: bool, model: &str) -> Vec<Value> {
    let (max_images, max_audios) = if kuaizi { kuaizi_limits(model) } else { (10, 1) };
    let images: Vec<String> = request
        .reference_images
        .clone()
        .unwrap_or_default()
        .into_iter()
        .take(max_images)
        .collect();
    // 首尾帧只在**确实给了两张图**时才打 first_frame/last_frame: 单图打 first_frame 会让
    // 平台走首帧模式并沿用图片比例(用户选的画幅被忽略), 与知鸟链路踩过的坑同源。
    let first_last = kuaizi && request.image_mode.as_deref() == Some("first-last") && images.len() >= 2;
    let mut content = vec![json!({ "type": "text", "text": request.prompt })];
    for (index, url) in images.into_iter().enumerate() {
        // 🔴 筷子(上游方舟)对图片素材**强制要求 role**: 只给 image_url 时任务能建成功,
        // 但执行阶段直接失败 ——
        //   `The parameter content specified in the request is not valid:
        //    role must be specified for image contents`
        // 而这个错误要等轮询才看得到(创建时是 200), 极易误判成「生成失败」。
        // 所以图片一律显式打角色: 首尾帧模式前两张是 first_frame / last_frame,
        // 其余都是 reference_image。
        if kuaizi {
            let role = if first_last && index == 0 {
                "first_frame"
            } else if first_last && index == 1 {
                "last_frame"
            } else {
                "reference_image"
            };
            content.push(json!({
                "type": "image_url",
                "image_url": { "url": url },
                "role": role,
            }));
        } else {
            content.push(json!({ "type": "image_url", "image_url": { "url": url } }));
        }
    }
    // 参考视频同样是分档上限(2.0 系 ≤3 / 2.5 系 ≤10), 超限整单 400。
    let max_videos = if kuaizi {
        if is_seedance_25(model) {
            10
        } else {
            3
        }
    } else {
        1
    };
    for url in string_array_param(request, "reference_videos", max_videos) {
        content.push(json!({ "type": "video_url", "video_url": { "url": url } }));
    }
    for url in request
        .reference_audio
        .clone()
        .unwrap_or_default()
        .into_iter()
        .take(max_audios)
    {
        content.push(json!({ "type": "audio_url", "audio_url": { "url": url } }));
    }
    content
}

fn build_body(request: &GenerateVideoRequest, model: &str, kuaizi: bool) -> Value {
    // 2.5 的首帧 / 首尾帧、视频编辑、视频延长三类任务**只接受 ratio=adaptive**
    // (创建时同步校验, 传具体比例直接 400)。节点里没有「自适应」这一档, 所以这里
    // 在提交时自动改写 —— 用户的画幅选择由首帧图片本身决定。
    let ratio = if kuaizi && is_seedance_25(model) && request.image_mode.as_deref() == Some("first-last") {
        "adaptive".to_string()
    } else {
        request.aspect_ratio.clone()
    };
    let mut body = json!({
        "model": model,
        "content": build_content(request, kuaizi, model),
        // 方舟的 duration 是整数; 这里和 media 协议相反, 不能传字符串。
        "duration": request.duration.max(1),
        "ratio": ratio,
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

/// 筷子AI 的媒体 URL 白名单预检。
///
/// 文档 v1.4 起对 `content[].*_url` 做同步校验: 只接受 `http(s)://` / `asset://`,
/// 单条 ≤4000 字符, base64 一律 400。真实事故: 4 张本地参考图(各 ~3MB)被当成
/// data URL 发出去, 平台回的是
/// `content[1].image_url.url is too long (13707382 chars, max 4000)` —— 用户完全
/// 看不出「是本地素材没上传」。
///
/// 前端已经会把本地素材换成公网 URL(`infrastructure/imageHostReferences.ts`), 这里
/// 只是**最后一道拦截**: 与其把十几兆 base64 发出去, 不如立刻给出能照着做的错误。
fn validate_kuaizi_media_urls(request: &GenerateVideoRequest) -> Result<(), AIError> {
    let sources = request
        .reference_images
        .iter()
        .flatten()
        .chain(request.reference_audio.iter().flatten());
    for (index, url) in sources.enumerate() {
        let trimmed = url.trim();
        let looks_inline = trimmed.to_ascii_lowercase().starts_with("data:");
        if looks_inline || trimmed.chars().count() > 4000 {
            return Err(AIError::InvalidRequest(format!(
                "筷子 AI 的参考素材只收公网 URL(http/https 或 asset://), 第 {} 条是 base64 内嵌数据({} 字符)。\
                 本地素材应先上传到图床(设置里添加并填写「知鸟 AI」)再提交; 若刚改过设置, 请重新生成一次。",
                index + 1,
                trimmed.chars().count()
            )));
        }
    }
    Ok(())
}

pub async fn submit(
    ctx: &SubmitContext,
    request: &GenerateVideoRequest,
) -> Result<ProviderTaskSubmission, AIError> {
    let model = api_model(request);
    let kuaizi = is_kuaizi(&ctx.base_url);
    if kuaizi {
        validate_kuaizi_media_urls(request)?;
    }
    let (submit_path, task_path, label) = paths_for(&ctx.base_url);
    let body = build_body(request, &model, kuaizi);
    let submit_url = ctx.endpoint(Some(submit_path), submit_path, None);
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
                label,
                describe_reqwest_error(&error)
            ))
        })?;
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(http_error(
            &format!("{} 视频请求失败", label),
            status,
            &raw,
            &submit_url,
        ));
    }
    let task_id = task_id_of(&payload).ok_or_else(|| {
        AIError::TaskFailed(format!(
            "{} 响应中未找到任务 ID: {}",
            label,
            crate::ai::providers::video_protocols::assets::truncate(&payload.to_string(), 600)
        ))
    })?;
    let query_url = ctx.endpoint(Some(task_path), task_path, Some(&task_id));
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

/// 按展台标签判定: 同一个协议实现挂了两个平台, 报错文案不能串 ——
/// 筷子任务查询失败时若显示「API666888 方舟 查询失败」, 用户会以为是另一个平台出问题。
fn classify_ark(payload: &Value, label: &str) -> ProviderTaskPollResult {
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
            None => ProviderTaskPollResult::Failed(format!("{} 任务已完成但没有返回成片地址", label)),
        },
        "failed" | "error" | "canceled" | "cancelled" | "expired" | "rejected" => {
            let reason = body
                .get("error")
                .and_then(|value| value.get("message").or(Some(value)))
                .and_then(Value::as_str)
                .unwrap_or("平台未给出原因");
            ProviderTaskPollResult::Failed(format!("{} {}", label, reason.trim()))
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
    // 轮询只拿得到完整 URL(提交时写进 handle), 所以这里按 URL 认平台。
    let label = if is_kuaizi(&query_url) {
        KZ_LABEL
    } else {
        PLATFORM_LABEL
    };
    let payload = fetch_json(&ctx.client, &ctx.api_key, query_url, label).await?;
    Ok(classify_ark(&payload, label))
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
        let body = build_body(&request(), "seedance-2.5-guanfang-anmiao", false);
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
        match classify_ark(&payload, PLATFORM_LABEL) {
            ProviderTaskPollResult::Succeeded(url) => assert_eq!(url, "https://cdn/a.mp4"),
            other => panic!("期望成功, 实际 {:?}", other),
        }
    }

    #[test]
    fn 运行中与失败的判定() {
        assert!(matches!(
            classify_ark(&json!({"status": "running"}), PLATFORM_LABEL),
            ProviderTaskPollResult::Running
        ));
        match classify_ark(
            &json!({"status": "failed", "error": {"message": "生成失败: 审核"}}),
            PLATFORM_LABEL,
        ) {
            ProviderTaskPollResult::Failed(reason) => assert!(reason.contains("审核")),
            other => panic!("期望失败, 实际 {:?}", other),
        }
    }

    #[test]
    fn 筷子首尾帧打上_first_frame_与_last_frame_角色() {
        let mut req = request();
        req.model = "custom:kz-ai/doubao-seedance-2-0-260128".into();
        req.image_mode = Some("first-last".into());
        req.reference_images = Some(vec!["https://cdn/a.jpg".into(), "https://cdn/b.jpg".into()]);
        let body = build_body(&req, "doubao-seedance-2-0-260128", true);
        let content = body["content"].as_array().expect("content 是数组");
        assert_eq!(content[1]["role"], "first_frame");
        assert_eq!(content[2]["role"], "last_frame");
        // 2.0 没有 adaptive 约束, 用户选的画幅照发。
        assert_eq!(body["ratio"], "16:9");
    }

    #[test]
    fn 筷子参考模式的每张图都必须带_reference_image_角色() {
        // 上游方舟强制要求: 只给 image_url 时任务能创建, 但执行阶段报
        // `role must be specified for image contents`(要轮询才看得到)。
        let mut req = request();
        req.image_mode = Some("reference".into());
        req.reference_images = Some(
            (1..=4)
                .map(|index| format!("asset://1800657071180349{index}"))
                .collect(),
        );
        let body = build_body(&req, "doubao-seedance-2-5-260628", true);
        let content = body["content"].as_array().expect("content 是数组");
        let images: Vec<&Value> = content.iter().filter(|item| item["type"] == "image_url").collect();
        assert_eq!(images.len(), 4);
        for item in &images {
            assert_eq!(item["role"], "reference_image");
        }
        // 非筷子链路(api666888 满血版)保持原样, 不加 role —— 那条线本来就没这个要求。
        let body = build_body(&req, "seedance-2.5-guanfang-anmiao", false);
        let content = body["content"].as_array().expect("content 是数组");
        assert!(content.iter().filter(|item| item["type"] == "image_url").all(|item| item.get("role").is_none()));
    }

    #[test]
    fn 筷子与_api666888_的失败文案不串台() {
        let payload = json!({"status": "failed", "error": {"message": "内容审核未通过"}});
        match classify_ark(&payload, KZ_LABEL) {
            ProviderTaskPollResult::Failed(reason) => {
                assert!(reason.contains("筷子"), "实际: {reason}");
                assert!(!reason.contains("API666888"), "实际: {reason}");
            }
            other => panic!("期望失败, 实际 {:?}", other),
        }
    }

    #[test]
    fn 筷子_seedance25_首尾帧自动改成_adaptive() {
        let mut req = request();
        req.image_mode = Some("first-last".into());
        req.reference_images = Some(vec!["https://cdn/a.jpg".into(), "https://cdn/b.jpg".into()]);
        let body = build_body(&req, "doubao-seedance-2-5-260628", true);
        // 文档: 2.5 的首帧/首尾帧、编辑、延长三类任务只收 adaptive。
        assert_eq!(body["ratio"], "adaptive");
        // 参考生视频(非首尾帧)不受这条约束限制。
        req.image_mode = None;
        let body = build_body(&req, "doubao-seedance-2-5-260628", true);
        assert_eq!(body["ratio"], "16:9");
    }

    #[test]
    fn 筷子拒绝_base64_参考素材时给出可行动的报错() {
        let mut req = request();
        // 默认 request() 就是一张 data URL —— 正是线上那次 13MB 的事故形态。
        assert!(validate_kuaizi_media_urls(&req).is_err());
        req.reference_images = Some(vec!["https://cdn/a.jpg".into()]);
        assert!(validate_kuaizi_media_urls(&req).is_ok());
        // 超长 URL(>4000 字符)同样拦下, 不必等平台回 400。
        req.reference_images = Some(vec![format!("https://cdn/{}", "a".repeat(4001))]);
        assert!(validate_kuaizi_media_urls(&req).is_err());
    }

    #[test]
    fn 筷子按模型裁剪素材条数() {
        let mut req = request();
        req.reference_images = Some((0..12).map(|index| format!("https://cdn/{index}.jpg")).collect());
        req.reference_audio = Some((0..5).map(|index| format!("https://cdn/{index}.mp3")).collect());
        // 2.0: 图 ≤9 / 音频 ≤3
        let body = build_body(&req, "doubao-seedance-2-0-fast-260128", true);
        let content = body["content"].as_array().expect("content 是数组");
        let images = content.iter().filter(|item| item["type"] == "image_url").count();
        let audios = content.iter().filter(|item| item["type"] == "audio_url").count();
        assert_eq!((images, audios), (9, 3));
        // 2.5: 图 ≤30 / 音频 ≤10
        let body = build_body(&req, "doubao-seedance-2-5-260628", true);
        let content = body["content"].as_array().expect("content 是数组");
        let images = content.iter().filter(|item| item["type"] == "image_url").count();
        let audios = content.iter().filter(|item| item["type"] == "audio_url").count();
        assert_eq!((images, audios), (12, 5));
    }
}
