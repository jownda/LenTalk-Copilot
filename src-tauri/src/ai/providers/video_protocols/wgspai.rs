// ---------------------------------------------------------------------------
// WGSPAI 视频协议(api.wgspai.cn)
//
// 对应前端 `generateWgspaiVideo`。按站点四份对接文档对齐:
//   - API文档.md                              (总览: 两族接口 / 图床 / 错误体)
//   - api.wgspai.cn-seedance2.5-对接文档.md    (seedance2.5)
//   - minimax-h3-api.md                        (Minimax-h3)
//   - seedance-v2-720p-9-3-3对接文档.md        (seedance-v2-720p)
//
// ---------------------------------------------------------------------------
// 本轮(2026-09-25)按文档补齐的四条
// ---------------------------------------------------------------------------
//
//   A. **接口族分流**。站点在同一个 Base 下有两族接口, 早先只实现了族 1:
//        族 1 Videos: POST /v1/videos      → GET /v1/videos/{id}
//        族 2 Task:   POST /v1/task/create → GET /v1/task/{id}
//      总览文档「异步 · 视频类任务」一节里的 `sd-2` / `sd-2-vip` /
//      `LongXia-O-sora2-pro-*` / `LongXia-A-veo31-*` / `ltx2.3` / `voice-clone` /
//      `flashvsr-restore` / `VEO-3.1` / `seedance-v2-1080p*` 全在族 2, 而且
//      **模型参数一律包在 `params` 里**(文档: 「本站统一任务接口会将其展平,
//      `params` 里除 `model`、`prompt` 外的键会与顶层合并后交由对应模型处理」)。
//      原实现把这些模型也 POST 到 /v1/videos, 一个任务号都拿不到。
//
//   B. **时长规则按模型收敛**。原实现把用户选的秒数原样发给所有模型, 与文档冲突的
//      有三处: seedance2.5 是固定 30 秒按次计费(传了反而可能被校验拒绝);
//      sora2-pro / veo31 的时长编在模型名里(`…-8s-…`); Minimax-h3 只收 4~15 秒、
//      `sd-2` 只收 5~15 秒整数。现在按文档吸附到区间边界, 而不是让平台回 400。
//
//   C. **画幅吸附**。seedance-v2-720p 文档 §3.4 明确「仅支持 `9:16` / `16:9`,
//      不要传 `1:1`」。白名单外的比例按横/竖归属就近吸附, 不猜具体像素。
//
//   D. **提示词引用标记方言本地化**。画布用 `@图N` / `@音频N` 引用上游素材
//      (词法见 `src/features/canvas/application/referenceTokenEditing.ts`), 而
//      seedance2.5 文档 §4/§9.3 要求「提示词里写 `@图片1` / `@图片2` 时, 请保证
//      `images` 数组顺序与文案一致」, seedance-v2-720p 文档 §3.3 用的是
//      `[image1]` / `[audio_1]` / `[video_1]`。原样把 `@图1` 交出去, 平台只会
//      当普通文字读 —— 参考图挂上了却对不上号。
//      **只换方言, 不重编号**: N 与素材数组下标一一对应(1 起), 重编号会把对应
//      关系改错。索引超出本次实际提交的素材数量时保持原样(宁可让平台按文字处理,
//      也不映射到不存在的素材)。
//
// ---------------------------------------------------------------------------
// 更早一轮的修正(从炳火协议整份拷贝出来后逐条纠正)
// ---------------------------------------------------------------------------
//
// 早期本文件是从炳火协议整份拷贝出来的, 两家的响应形状确实同构, 但**请求字段并不
// 相同**, 拷贝带过来的几处与 WGSPAI 文档不符, 已逐条纠正:
//
//   1. 端点: 文档三处写明「推荐统一用 /v1/videos」, `/v1/video/generations` 只是
//      「兼容路径(可选)」。提交改 POST /v1/videos, 查询 GET /v1/videos/{id}。
//   2. 本地素材: 从「无上传端点, 只能内联 data URL」改为走**官方背景机图床**
//      https://wgspai.cn/image-bed/api/upload(字段 file, 匿名可传)。文档明确
//      「请求里的图片须为公网可访问 URL, 本地文件先上传本站图床」, 并对 data URL
//      标注「体积大、易触达请求上限」—— 这条不是优化而是修错。
//   3. 参考音频字段是 `audio_urls`(seedance-v2-720p 文档), 不是炳火的
//      `reference_audios`。
//   4. 参考视频字段是 `video_urls`(同上), 不是炳火的 `reference_videos`;
//      原实现**完全没有**透传参考视频。
//   5. 时长: 传 `seconds`(三份文档都认的字段名)。seedance2.5 固定 30 秒、按次
//      计费, 文档建议「不传或传 "30"」→ 该模型直接省略。
//   6. 画幅: `ratio` 与 `size` **同时**传。seedance2.5 / Minimax-h3 的正式字段是
//      `ratio`; seedance-v2-720p 的正式字段是 `size`, 只传 ratio 会被它忽略。
//      `size` 用像素值(1280x720 等), 文档都接受。
//   7. 首尾帧: 原实现用 `start_frame` / `end_frame`, 四份文档里**都没有**这两个
//      字段。改为文档口径 —— `images` 传全部, 首尾帧模式时附
//      `image_usage: "first_frame"`(seedance2.5 文档: 默认 reference, first_frame
//      表示第 1 张作首帧)。
//   8. 参考图上限按模型区分(720p / Minimax-h3 都是 9, 超出会被平台拒绝;
//      文档要求「超过上限请自行截断」)。
//
// 保留的两处非文档字段: `generate_audio` 与 `n`。它们是从炳火协议继承下来的,
// 四份文档均未提及; 但多发的字段在网关展平后通常被上游忽略, 删掉反而可能丢掉
// 某个模型上已经生效的行为, 因此保留不动。**族 2(Task)不带这两个字段** ——
// 那一族是本次新支持的, 没有"既有行为"需要保, 按文档最小集提交更安全。
//
// 已知未做: 首尾帧在 seedance-v2 系列上的文档别名是 `first_frame` / `last_frame`
// (总览文档「Seedance 2.0」一节), 与当前统一的 `images + image_usage` 写法不同。
// 该别名未被任何一份专档验证过, 贸然切换可能反而弄坏现在能跑的链路, 因此保留现状。
// ---------------------------------------------------------------------------
use serde_json::{json, Value};

use crate::ai::error::AIError;
use crate::ai::providers::video_protocols::assets::{
    extract_asset_url, resolve_reference_asset, truncate, upload_reference_asset_multipart,
    ReferenceAsset,
};
use crate::ai::providers::video_protocols::{
    classify, describe_reqwest_error, fetch_json, http_error, query_url_of, string_array_param,
    string_param, submission_from_payload, SubmitContext, PollContext,
};
use crate::ai::{
    GenerateVideoRequest, ProviderTaskPollResult, ProviderTaskSubmission,
};

pub const TRANSPORT: &str = "wgspai-video";
const PLATFORM_LABEL: &str = "WGSPAI";

/// 族 1(Videos)。三份模型专档都推荐它作为正典路径。
const VIDEOS_SUBMIT_PATH: &str = "/v1/videos";
/// 族 2(Task)。总览文档「异步：任务」一节。
const TASK_SUBMIT_PATH: &str = "/v1/task/create";
const TASK_QUERY_PATH: &str = "/v1/task/{taskId}";

/// 图床补全路径。API 域是 `api.wgspai.cn`, 而图床在同站的 `wgspai.cn`
/// (见 seedance2.5 文档第 1 节与 seedance-v2-720p 文档第 2.1 节) —— 两者不是
/// 同一个 host, 所以不能像炳火那样拿 base_url 直接拼, 需要先把 `api.` 前缀摘掉。
const IMAGE_BED_PATH: &str = "/image-bed/api/upload";

/// 未识别模型的参考图上限。文档没写上限时**宁可宽松**: 在这里悄悄丢素材, 用户只会
/// 看到"传了但没生效", 无从排查; 交给平台报出它自己的约束反而可诊断。
const DEFAULT_MAX_REFERENCE_IMAGES: usize = 30;

// ---------------------------------------------------------------------------
// 模型规则表
// ---------------------------------------------------------------------------

/// 接口族。决定提交/查询端点, 以及参数是平铺还是包 `params`。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ApiFamily {
    /// `POST /v1/videos` → `GET /v1/videos/{id}`, 参数在顶层。
    Videos,
    /// `POST /v1/task/create` → `GET /v1/task/{id}`, 参数在 `params` 里。
    Task,
}

/// 时长规则。`None` = 该模型不接受客户端指定时长。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DurationRule {
    /// 平台自己定(seedance2.5 固定 30 秒按次计费), 不传 `seconds`。
    PlatformDefault,
    /// 时长编在模型名里(`LongXia-O-sora2-pro-8s-*` / `LongXia-A-veo31-8s-*`), 不传。
    InModelName,
    /// 传 `seconds`, 并吸附到文档给定的闭区间。
    Range(u32, u32),
    /// 文档未写时长规则, 原样透传用户选择。
    Passthrough,
}

/// 参考素材的提交通道。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReferenceChannel {
    /// 族 1: 顶层平铺 `images` / `audio_urls` / `video_urls`。
    TopLevel,
    /// 族 2: `params.images` / `params.audios` / `params.videos`;
    /// seedance-v2 的 `-video` 模型改用类型化的 `params.content`(总览文档口径)。
    Params,
}

/// 提示词里的引用标记方言。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReferenceDialect {
    /// 文档没定义引用标记的模型: 一个字符都不动。
    Keep,
    /// `@图片N`(seedance2.5 文档 §4 / §9.3)。该文档没有音频/视频标记。
    AtPicture,
    /// `[imageN]` / `[audio_N]` / `[video_N]`(seedance-v2-720p 文档 §3.3)。
    Bracketed,
}

struct ModelSpec {
    family: ApiFamily,
    max_reference_images: usize,
    max_reference_audio: usize,
    max_reference_videos: usize,
    duration: DurationRule,
    supports_reference_audio: bool,
    supports_reference_video: bool,
    channel: ReferenceChannel,
    dialect: ReferenceDialect,
    /// 画幅白名单。`None` = 文档未限定, 用户选什么发什么。
    allowed_ratios: Option<&'static [&'static str]>,
    /// 白名单外 / 画幅缺失时的兜底。
    fallback_ratio: &'static str,
    /// 输入视频用**单数** `video_url` 而不是数组(flashvsr-restore)。
    single_video_url: bool,
}

/// 文档明确写了"仅支持这两种比例"的画幅白名单。
const SEEDANCE_V2_RATIOS: [&str; 2] = ["9:16", "16:9"];
/// seedance2.5 文档 §5.1: `9:16` / `16:9` / `1:1`。
const SEEDANCE_25_RATIOS: [&str; 3] = ["9:16", "16:9", "1:1"];

fn model_spec(model: &str) -> ModelSpec {
    let normalized = model.trim().to_ascii_lowercase();

    // ---- seedance2.5: 30 秒定长按次计费, 参考图 ≤30, 认 `@图片N` ----
    // 音频 / 参考视频「即使传了也不保证生效」(文档 §4) → 仍然透传, 由平台决定。
    if normalized.contains("seedance2.5") || normalized.contains("seedance-2.5") {
        return ModelSpec {
            family: ApiFamily::Videos,
            max_reference_images: 30,
            max_reference_audio: 3,
            max_reference_videos: 3,
            duration: DurationRule::PlatformDefault,
            supports_reference_audio: true,
            supports_reference_video: true,
            channel: ReferenceChannel::TopLevel,
            dialect: ReferenceDialect::AtPicture,
            allowed_ratios: Some(&SEEDANCE_25_RATIOS),
            fallback_ratio: "9:16",
            single_video_url: false,
        };
    }

    // ---- seedance v2 系列: 9 图 / 3 音频 / 3 视频(简称 9-3-3) ----
    if normalized.contains("seedance-v2") {
        // 只有 720p 有专档(明确走 /v1/videos、4~15 秒); 1080p 只在总览文档的
        // 「异步 · 视频类任务」一节里出现, 属于族 2 且「按次计费, 无需传时长」。
        // 用带连字符的完整名匹配 —— `seedance-v2.5-1080p` 这种没有文档依据的写法
        // 不该被顺手改到另一族去。
        let is_task_1080 = normalized.contains("seedance-v2-1080p");
        return ModelSpec {
            family: if is_task_1080 { ApiFamily::Task } else { ApiFamily::Videos },
            max_reference_images: 9,
            max_reference_audio: 3,
            max_reference_videos: 3,
            duration: if is_task_1080 {
                DurationRule::PlatformDefault
            } else {
                DurationRule::Range(4, 15)
            },
            supports_reference_audio: true,
            supports_reference_video: normalized.contains("-video"),
            channel: if is_task_1080 { ReferenceChannel::Params } else { ReferenceChannel::TopLevel },
            dialect: ReferenceDialect::Bracketed,
            allowed_ratios: Some(&SEEDANCE_V2_RATIOS),
            fallback_ratio: "9:16",
            single_video_url: false,
        };
    }

    // ---- minimax-h3: 图 ≤9, 文档明确「参考音视频: 不支持」----
    // 不透传音视频, 免得平台因为多出来的字段直接 400。时长 4~15 秒(默认 15)。
    if normalized.contains("minimax-h3") {
        return ModelSpec {
            family: ApiFamily::Videos,
            max_reference_images: 9,
            max_reference_audio: 0,
            max_reference_videos: 0,
            duration: DurationRule::Range(4, 15),
            supports_reference_audio: false,
            supports_reference_video: false,
            channel: ReferenceChannel::TopLevel,
            dialect: ReferenceDialect::Keep,
            // 文档只说「建议 16:9 或 9:16」, 是建议不是白名单 → 不强制吸附。
            allowed_ratios: None,
            fallback_ratio: "16:9",
            single_video_url: false,
        };
    }

    // ---- 族 2(Task): 总览文档「异步 · 视频类任务」一节的模型 ----
    if is_task_family(&normalized) {
        let is_sd2 = normalized.contains("sd-2");
        let is_flashvsr = normalized.contains("flashvsr");
        return ModelSpec {
            family: ApiFamily::Task,
            max_reference_images: DEFAULT_MAX_REFERENCE_IMAGES,
            max_reference_audio: 0,
            max_reference_videos: if is_sd2 || is_flashvsr { 3 } else { 0 },
            duration: if is_sd2 {
                // sd-2 文档: 「请使用 5～15 之间的整数秒」。
                DurationRule::Range(5, 15)
            } else if normalized.contains("sora2-pro")
                || normalized.contains("veo31")
                || normalized.contains("veo-3.1")
            {
                // 方向与时长已编进模型名(`…-8s-…` / `…-12s-…`)。
                DurationRule::InModelName
            } else {
                // ltx2.3 / voice-clone / flashvsr-restore 等: 文档未写时长规则。
                DurationRule::Passthrough
            },
            supports_reference_audio: false,
            supports_reference_video: is_sd2 || is_flashvsr,
            channel: ReferenceChannel::Params,
            dialect: ReferenceDialect::Keep,
            allowed_ratios: None,
            fallback_ratio: "16:9",
            single_video_url: is_flashvsr,
        };
    }

    // ---- 未识别的模型: 走文档推荐的正典 Videos 路径, 规则一律宽松 ----
    ModelSpec {
        family: ApiFamily::Videos,
        max_reference_images: DEFAULT_MAX_REFERENCE_IMAGES,
        max_reference_audio: 3,
        max_reference_videos: 3,
        duration: DurationRule::Passthrough,
        supports_reference_audio: true,
        supports_reference_video: true,
        channel: ReferenceChannel::TopLevel,
        dialect: ReferenceDialect::Keep,
        allowed_ratios: None,
        fallback_ratio: "16:9",
        single_video_url: false,
    }
}

/// 总览文档「异步 · 视频类任务」一节列出的族 2 模型名片段。
///
/// 只在**文档明确写在那一节**里才分流 —— 未识别模型继续走 `/v1/videos`, 这是三份
/// 模型专档一致推荐的路径, 拿它当默认比猜一个更安全。
fn is_task_family(normalized_model: &str) -> bool {
    const TASK_FAMILY_MARKERS: [&str; 9] = [
        "sd-2",
        "longxia-",
        "sora2-pro",
        "veo31",
        "veo-3.1",
        "ltx2.3",
        "voice-clone",
        "flashvsr-restore",
        "seedance-v2-1080p",
    ];
    TASK_FAMILY_MARKERS
        .iter()
        .any(|marker| normalized_model.contains(marker))
}

/// 画幅比例 → 像素尺寸。文档里 `ratio` 收比例串、`size` 收像素串(也接受比例串),
/// 两个都发能同时命中「只认 ratio」与「只认 size」的模型。
fn pixel_size_of(aspect_ratio: &str) -> Option<&'static str> {
    match aspect_ratio.trim() {
        "16:9" => Some("1280x720"),
        "9:16" => Some("720x1280"),
        "1:1" => Some("1024x1024"),
        "4:3" => Some("1024x768"),
        "3:4" => Some("768x1024"),
        "21:9" => Some("1280x548"),
        _ => None,
    }
}

/// 白名单外的比例就近吸附: 只看横/竖归属, 不猜具体数值(猜出来的档位平台不一定有)。
fn snap_ratio(requested: &str, allowed: &'static [&'static str], fallback: &'static str) -> &'static str {
    let Some((width, height)) = requested.split_once(':') else {
        return fallback;
    };
    let (Ok(width), Ok(height)) = (width.trim().parse::<u32>(), height.trim().parse::<u32>()) else {
        return fallback;
    };
    if width == 0 || height == 0 {
        return fallback;
    }
    let want_landscape = width > height;
    allowed
        .iter()
        .copied()
        .find(|candidate| match candidate.split_once(':') {
            Some((candidate_width, candidate_height)) => {
                let (Ok(candidate_width), Ok(candidate_height)) =
                    (candidate_width.trim().parse::<u32>(), candidate_height.trim().parse::<u32>())
                else {
                    return false;
                };
                (candidate_width > candidate_height) == want_landscape
            }
            None => false,
        })
        .unwrap_or(fallback)
}

/// 画幅最终值。白名单模型即使在用户没选画幅时也要落到文档默认值 ——
/// 让平台用它自己的默认(seedance-v2-720p = `9:16`)会与用户看到的界面对不上。
fn resolve_aspect_ratio(spec: &ModelSpec, aspect_ratio: &str) -> Option<String> {
    let requested = aspect_ratio.trim();
    match spec.allowed_ratios {
        Some(allowed) => {
            if requested.is_empty() {
                return Some(spec.fallback_ratio.to_string());
            }
            if allowed.contains(&requested) {
                return Some(requested.to_string());
            }
            Some(snap_ratio(requested, allowed, spec.fallback_ratio).to_string())
        }
        None => (!requested.is_empty()).then(|| requested.to_string()),
    }
}

/// 时长最终值。`None` = 本次请求不带时长字段。
fn resolve_duration(rule: DurationRule, requested: u32) -> Option<u32> {
    match rule {
        DurationRule::PlatformDefault | DurationRule::InModelName => None,
        DurationRule::Range(min, max) => Some(requested.clamp(min, max)),
        DurationRule::Passthrough => Some(requested.max(1)),
    }
}

// ---------------------------------------------------------------------------
// 提示词引用标记方言本地化
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TokenKind {
    Image,
    Audio,
    Video,
}

struct ReferenceToken {
    kind: TokenKind,
    number: usize,
    /// token 的字节长度(含前缀)。
    len: usize,
}

fn leading_digits_len(text: &str) -> usize {
    text.bytes().take_while(u8::is_ascii_digit).count()
}

/// 从 `index` 开始识别一个引用标记。
///
/// 接受的前缀形态: `@图` / `@图片` / `@音频` / `@audio` / `@video`(画布词法 + 文档
/// 里手写的 `@图片1`), 以及方括号形态 `[image…]` / `[audio…]` / `[video…]`,
/// 方括号内允许 `_` 分隔(`[audio_1]` 是文档 §3.3 的写法)。
///
/// **刻意不认裸 `图1`**: 「参考图1」「如图1所示」这类普通正文会被误伤, 而画布自己
/// 产出的 token 一定带 `@` 或 `[]`(见 `referenceTokenEditing.ts` 的词法)。
fn parse_reference_token(text: &str, index: usize) -> Option<ReferenceToken> {
    let tail = &text[index..];

    const PREFIXES: [(&str, TokenKind, bool); 8] = [
        // `@图片` 必须排在 `@图` 前面: 前者是后者的前缀延长, 顺序反了会把 `片` 当数字段。
        ("@图片", TokenKind::Image, false),
        ("@图", TokenKind::Image, false),
        ("@音频", TokenKind::Audio, false),
        ("@audio", TokenKind::Audio, false),
        ("@video", TokenKind::Video, false),
        ("[image", TokenKind::Image, true),
        ("[audio", TokenKind::Audio, true),
        ("[video", TokenKind::Video, true),
    ];

    for (prefix, kind, bracketed) in PREFIXES {
        let Some(rest) = tail.strip_prefix(prefix) else {
            continue;
        };
        let rest = if bracketed { rest.strip_prefix('_').unwrap_or(rest) } else { rest };
        let digits_len = leading_digits_len(rest);
        if digits_len == 0 {
            continue;
        }
        let Ok(number) = rest[..digits_len].parse::<usize>() else {
            continue;
        };
        // 前缀长度 = 已消费的字节数(含可选的下划线)。
        let mut len = (tail.len() - rest.len()) + digits_len;
        if bracketed {
            if rest.as_bytes().get(digits_len) != Some(&b']') {
                continue;
            }
            len += 1;
        }
        return Some(ReferenceToken { kind, number, len });
    }
    None
}

fn render_token(dialect: ReferenceDialect, kind: TokenKind, number: usize) -> Option<String> {
    match dialect {
        ReferenceDialect::Keep => None,
        ReferenceDialect::AtPicture => match kind {
            // seedance2.5 文档只有图片标记; 音频/视频没有定义 → 原样保留, 不臆造。
            TokenKind::Image => Some(format!("@图片{}", number)),
            TokenKind::Audio | TokenKind::Video => None,
        },
        ReferenceDialect::Bracketed => Some(match kind {
            TokenKind::Image => format!("[image{}]", number),
            TokenKind::Audio => format!("[audio_{}]", number),
            TokenKind::Video => format!("[video_{}]", number),
        }),
    }
}

/// 把画布的规范引用标记翻成目标模型认的方言。
///
/// 只换写法, 不重编号 —— N 与素材数组下标一一对应(1 起), 重编号会把对应关系改错。
/// 索引超出本次实际提交的数量(素材被上限截断、或模型不支持该通道)时保持原样。
fn localize_reference_tokens(
    prompt: &str,
    dialect: ReferenceDialect,
    image_count: usize,
    audio_count: usize,
    video_count: usize,
) -> String {
    if dialect == ReferenceDialect::Keep || prompt.is_empty() {
        return prompt.to_string();
    }

    let mut out = String::with_capacity(prompt.len() + 16);
    let mut cursor = 0usize;
    while cursor < prompt.len() {
        let Some(token) = parse_reference_token(prompt, cursor) else {
            // 非 token 位置: 原样搬运一个字符(按 UTF-8 边界推进)。
            let Some(ch) = prompt[cursor..].chars().next() else {
                break;
            };
            out.push(ch);
            cursor += ch.len_utf8();
            continue;
        };

        let limit = match token.kind {
            TokenKind::Image => image_count,
            TokenKind::Audio => audio_count,
            TokenKind::Video => video_count,
        };
        let raw = &prompt[cursor..cursor + token.len];
        let rendered = (token.number >= 1 && token.number <= limit)
            .then(|| render_token(dialect, token.kind, token.number))
            .flatten();
        out.push_str(rendered.as_deref().unwrap_or(raw));
        cursor += token.len;
    }
    out
}

// ---------------------------------------------------------------------------
// 请求体
// ---------------------------------------------------------------------------

/// 上传到图床换公网 URL 之后的参考素材。
struct ResolvedReferences {
    images: Vec<String>,
    audios: Vec<String>,
    videos: Vec<String>,
}

/// 构造提交请求体。**纯函数** —— 提交路径与单测共用同一份构造逻辑, 避免测试里
/// 再抄一遍字段名(抄出来的那份永远是对的, 线上那份永远错)。
fn build_request_body(
    spec: &ModelSpec,
    request: &GenerateVideoRequest,
    model: &str,
    references: &ResolvedReferences,
) -> Value {
    let is_first_last = request.image_mode.as_deref() == Some("first-last");
    let prompt = localize_reference_tokens(
        &request.prompt,
        spec.dialect,
        references.images.len(),
        references.audios.len(),
        references.videos.len(),
    );
    let duration = resolve_duration(spec.duration, request.duration);
    let aspect_ratio = resolve_aspect_ratio(spec, &request.aspect_ratio);
    let pixel_size = aspect_ratio.as_deref().and_then(pixel_size_of);
    let resolution = request
        .video_resolution
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    match spec.family {
        ApiFamily::Videos => {
            let mut body = json!({
                "model": model,
                "prompt": prompt,
                // 非文档字段, 从炳火协议继承; 保留以不改变既有行为(见文件头说明)。
                "generate_audio": true,
                "n": 1,
            });
            let Some(object) = body.as_object_mut() else {
                return body;
            };
            if let Some(seconds) = duration {
                object.insert("seconds".into(), Value::String(seconds.to_string()));
            }
            if let Some(ratio) = &aspect_ratio {
                // `ratio` 与 `size` 同传: seedance2.5 / Minimax-h3 认 ratio,
                // seedance-v2-720p 的正式字段是 size, 只发 ratio 会被它忽略。
                object.insert("ratio".into(), Value::String(ratio.clone()));
                if let Some(size) = pixel_size {
                    object.insert("size".into(), Value::String(size.to_string()));
                }
            }
            if !references.images.is_empty() {
                object.insert("images".into(), json!(references.images));
                // 首尾帧模式: 文档口径是 `images` + `image_usage: first_frame`
                // (第 1 张作首帧), 不是炳火那套 start_frame / end_frame。
                if is_first_last {
                    object.insert("image_usage".into(), Value::String("first_frame".into()));
                }
            }
            if !references.audios.is_empty() {
                object.insert("audio_urls".into(), json!(references.audios));
            }
            if !references.videos.is_empty() {
                object.insert("video_urls".into(), json!(references.videos));
            }
            if let Some(resolution) = resolution {
                object.insert("resolution".into(), Value::String(resolution));
            }
            body
        }
        ApiFamily::Task => {
            // 族 2: 除 model / prompt 外的参数一律进 `params`(总览文档「创建任务」节)。
            let mut params = serde_json::Map::new();
            if let Some(seconds) = duration {
                params.insert("seconds".into(), Value::String(seconds.to_string()));
            }
            if let Some(ratio) = &aspect_ratio {
                params.insert("ratio".into(), Value::String(ratio.clone()));
                if let Some(size) = pixel_size {
                    params.insert("size".into(), Value::String(size.to_string()));
                }
            }
            // seedance-v2 的 `-video` 模型按文档走类型化 `params.content`
            // (能同时带图 / 视频 / 音频); 其余用平铺的 `images` / `videos` / `audios`。
            if !references.videos.is_empty() && spec.dialect == ReferenceDialect::Bracketed {
                let mut items = Vec::new();
                for url in &references.images {
                    items.push(json!({
                        "type": "image_url",
                        "image_url": { "url": url },
                        "role": "reference_image",
                    }));
                }
                for url in &references.videos {
                    items.push(json!({
                        "type": "video_url",
                        "video_url": { "url": url },
                        "role": "reference_video",
                    }));
                }
                for url in &references.audios {
                    items.push(json!({
                        "type": "audio_url",
                        "audio_url": { "url": url },
                        "role": "reference_audio",
                    }));
                }
                params.insert("content".into(), Value::Array(items));
            } else {
                if !references.images.is_empty() {
                    params.insert("images".into(), json!(references.images));
                }
                if !references.audios.is_empty() {
                    params.insert("audios".into(), json!(references.audios));
                }
                if let Some(first) = references.videos.first() {
                    // flashvsr-restore 的输入视频字段是单数 `video_url`(总览文档
                    // 「工作流类 / 标准 API 模型」一节), 不是数组。
                    if spec.single_video_url {
                        params.insert("video_url".into(), Value::String(first.clone()));
                    } else if !references.videos.is_empty() {
                        params.insert("videos".into(), json!(references.videos));
                    }
                }
            }
            if let Some(resolution) = resolution {
                params.insert("resolution".into(), Value::String(resolution));
            }
            json!({
                "model": model,
                "prompt": prompt,
                "params": Value::Object(params),
            })
        }
    }
}

// ---------------------------------------------------------------------------
// 图床
// ---------------------------------------------------------------------------

/// 图床地址: 优先读平台配置里的 `reference_asset_upload_url`(设置页可填),
/// 否则按 base_url 推导出同站的图床入口。
fn image_bed_upload_url(base_url: &str, request: &GenerateVideoRequest) -> String {
    let configured = string_param(request, "reference_asset_upload_url");
    if !configured.is_empty() {
        return configured;
    }
    // `https://api.wgspai.cn` → `https://wgspai.cn`
    let root = base_url.trim().trim_end_matches('/').replacen("://api.", "://", 1);
    format!("{}{}", root, IMAGE_BED_PATH)
}

/// 本地素材上传到图床换公网 URL; 已经是公网 URL 的直接透传。
///
/// 图床按文档是**匿名可上传**的(官方 curl 不带鉴权头), 所以 api_key 传空 ——
/// `upload_reference_asset_multipart` 会据此跳过 Authorization 头。
async fn upload_one(
    ctx: &SubmitContext,
    upload_url: &str,
    source: &str,
    stem: &str,
    label: &str,
) -> Result<String, AIError> {
    let asset = resolve_reference_asset(source, label).await?;
    let extension = match &asset {
        ReferenceAsset::Url(url) => return Ok(url.clone()),
        ReferenceAsset::File { extension, .. } => extension.clone(),
    };
    let filename = format!("{}.{}", stem, extension);
    let payload =
        upload_reference_asset_multipart(&ctx.client, upload_url, "", &filename, &asset, PLATFORM_LABEL)
            .await?;
    extract_asset_url(&payload).ok_or_else(|| {
        AIError::TaskFailed(format!(
            "{} 参考素材上传响应中未找到公网 URL: {}",
            PLATFORM_LABEL,
            truncate(&payload.to_string(), 600)
        ))
    })
}

// ---------------------------------------------------------------------------
// 提交 / 查询
// ---------------------------------------------------------------------------

pub async fn submit(
    ctx: &SubmitContext,
    request: &GenerateVideoRequest,
) -> Result<ProviderTaskSubmission, AIError> {
    let model = request
        .model
        .split_once('/')
        .map(|(_, model)| model)
        .unwrap_or(request.model.as_str())
        .to_string();
    let spec = model_spec(&model);
    let is_first_last = request.image_mode.as_deref() == Some("first-last");

    let image_limit = if is_first_last { 2 } else { spec.max_reference_images };
    let raw_images: Vec<String> = request
        .reference_images
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|source| !source.trim().is_empty())
        .take(image_limit)
        .collect();
    let raw_audios: Vec<String> = if spec.supports_reference_audio {
        request
            .reference_audio
            .clone()
            .unwrap_or_default()
            .into_iter()
            .filter(|source| !source.trim().is_empty())
            .take(spec.max_reference_audio)
            .collect()
    } else {
        Vec::new()
    };
    let raw_videos: Vec<String> = if spec.supports_reference_video {
        string_array_param(request, "reference_videos", spec.max_reference_videos)
    } else {
        Vec::new()
    };

    let upload_url = image_bed_upload_url(&ctx.base_url, request);
    let mut images = Vec::with_capacity(raw_images.len());
    for (index, source) in raw_images.iter().enumerate() {
        images.push(
            upload_one(
                ctx,
                &upload_url,
                source,
                &format!("image-{}", index + 1),
                &format!("{} 参考图 {}", PLATFORM_LABEL, index + 1),
            )
            .await?,
        );
    }
    let mut audios = Vec::with_capacity(raw_audios.len());
    for (index, source) in raw_audios.iter().enumerate() {
        audios.push(
            upload_one(
                ctx,
                &upload_url,
                source,
                &format!("audio-{}", index + 1),
                &format!("{} 参考音频 {}", PLATFORM_LABEL, index + 1),
            )
            .await?,
        );
    }
    let mut videos = Vec::with_capacity(raw_videos.len());
    for (index, source) in raw_videos.iter().enumerate() {
        videos.push(
            upload_one(
                ctx,
                &upload_url,
                source,
                &format!("video-{}", index + 1),
                &format!("{} 参考视频 {}", PLATFORM_LABEL, index + 1),
            )
            .await?,
        );
    }

    let body = build_request_body(
        &spec,
        request,
        &model,
        &ResolvedReferences { images, audios, videos },
    );

    let submit_path = match spec.family {
        ApiFamily::Videos => VIDEOS_SUBMIT_PATH,
        ApiFamily::Task => TASK_SUBMIT_PATH,
    };
    let submit_url = ctx.endpoint(Some(submit_path), submit_path, None);
    let response = ctx
        .client
        .post(&submit_url)
        .bearer_auth(&ctx.api_key)
        .header("Accept-Encoding", "identity")
        .json(&body)
        .send()
        .await
        .map_err(|error| AIError::Provider(format!("{} 视频提交失败(网络): {}", PLATFORM_LABEL, describe_reqwest_error(&error))))?;
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

    // 查询地址在提交时算好并落库: 续查时 extra_params 已不可用。
    let query_path = match spec.family {
        ApiFamily::Videos => format!("{}/{{taskId}}", VIDEOS_SUBMIT_PATH),
        ApiFamily::Task => TASK_QUERY_PATH.to_string(),
    };
    let query_url = ctx.endpoint(Some(&query_path), &query_path, None);
    submission_from_payload(&payload, &ctx.provider_id, TRANSPORT, query_url, None)
}

/// 族 2 的失败体是**业务错误包**: `{"code": -1, "message": "...", "data": {...}}`。
///
/// 通用 `classify` 只认 `status` 字段与 `error` / `fail_reason` 系键, 认不出这种
/// 顶层 `code` + `message` 的形状 —— 一旦平台用 HTTP 200 返回业务错误, 任务会被
/// 一直当成"还在跑", 直到轮询窗口耗尽。这里补一层: 只在通用归类给出 Running、
/// 且平台**没有**给出任何在跑状态词时才采信业务错误, 保持"平台说还在跑就不判死"
/// 这条既有铁律(见 `classify` 的注释)。
fn business_error(payload: &Value) -> Option<String> {
    let object = payload.as_object()?;
    let status = crate::ai::providers::openai_compat::OpenAICompatibleProvider::video_task_status(payload);
    if crate::ai::providers::video_protocols::is_running_status(&status) {
        return None;
    }
    let code = object.get("code")?;
    let is_error_code = match code {
        Value::Number(number) => number.as_i64().is_some_and(|value| value != 0),
        Value::String(text) => !matches!(text.trim(), "" | "0" | "200" | "success" | "ok"),
        _ => false,
    };
    if !is_error_code {
        return None;
    }
    Some(
        crate::ai::providers::video_protocols::extract_error_reason(&payload.to_string())
            .unwrap_or_else(|| format!("平台返回业务错误 code={}", code)),
    )
}

pub async fn poll(
    ctx: &PollContext,
    metadata: &serde_json::Map<String, Value>,
    handle: &crate::ai::ProviderTaskHandle,
) -> Result<ProviderTaskPollResult, AIError> {
    let payload = fetch_json(&ctx.client, &ctx.api_key, query_url_of(metadata)?, TRANSPORT).await?;
    let verdict = classify(&payload, handle);
    if matches!(verdict, ProviderTaskPollResult::Running) {
        if let Some(reason) = business_error(&payload) {
            return Ok(ProviderTaskPollResult::Failed(format!("视频生成失败: {}", reason)));
        }
    }
    Ok(verdict)
}

/// 供 `openai_compat` 判定是否属于本协议。
///
/// transport 命中是主路径(前端 `injectCustomApiRequestMode` 已按 providerId /
/// Base URL 注入好)。Base URL 兜底**只在 transport 为空时**生效 —— 否则用户
/// 显式把平台配成 `openai-video` 自定义路径时会被误抢。
pub fn matches(transport: &str, provider_base_url: &str, _provider_id: &str) -> bool {
    transport == TRANSPORT
        || (transport.is_empty()
            && provider_base_url.to_ascii_lowercase().contains("api.wgspai.cn"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_with(model: &str, duration: u32, aspect_ratio: &str) -> GenerateVideoRequest {
        GenerateVideoRequest {
            prompt: String::new(),
            model: format!("custom:wgspai/{}", model),
            duration,
            aspect_ratio: aspect_ratio.into(),
            video_resolution: None,
            image_mode: None,
            reference_images: None,
            reference_audio: None,
            extra_params: None,
        }
    }

    fn empty_references() -> ResolvedReferences {
        ResolvedReferences { images: Vec::new(), audios: Vec::new(), videos: Vec::new() }
    }

    fn body_of(request: &GenerateVideoRequest) -> Value {
        let model = request.model.split_once('/').map(|(_, m)| m).unwrap_or("").to_string();
        let spec = model_spec(&model);
        build_request_body(&spec, request, &model, &empty_references())
    }

    // ---- 接口族分流 ----

    #[test]
    fn documented_videos_family_models_stay_on_videos_path() {
        for model in ["seedance2.5", "seedance-v2-720p", "Minimax-h3", "seedance-v2-720p-video"] {
            assert_eq!(model_spec(model).family, ApiFamily::Videos, "{} 应走 /v1/videos", model);
        }
    }

    #[test]
    fn documented_task_family_models_use_task_path_and_params_envelope() {
        for model in [
            "sd-2",
            "sd-2-vip",
            "LongXia-O-sora2-pro-8s-9x16",
            "LongXia-A-veo31-8s-16x9-1080p",
            "ltx2.3",
            "voice-clone",
            "flashvsr-restore",
            "VEO-3.1",
            "seedance-v2-1080p",
        ] {
            assert_eq!(model_spec(model).family, ApiFamily::Task, "{} 应走 /v1/task/create", model);
        }
        let body = body_of(&request_with("sd-2", 10, "16:9"));
        assert!(body.get("params").is_some(), "族 2 参数必须包在 params 里");
        assert!(body.get("seconds").is_none(), "族 2 不该在顶层出现 seconds");
        assert_eq!(body["params"]["seconds"], json!("10"));
        assert_eq!(body["params"]["size"], json!("1280x720"));
    }

    #[test]
    fn task_family_keeps_model_and_prompt_at_top_level() {
        let mut request = request_with("sd-2", 10, "16:9");
        request.prompt = "镜头缓慢推进".into();
        let body = body_of(&request);
        assert_eq!(body["model"], json!("sd-2"));
        assert_eq!(body["prompt"], json!("镜头缓慢推进"));
        // 族 2 不带炳火继承的 generate_audio / n。
        assert!(body.get("generate_audio").is_none());
        assert!(body.get("n").is_none());
    }

    #[test]
    fn undocumented_model_keeps_permissive_videos_defaults() {
        let spec = model_spec("some-other-video-model");
        assert_eq!(spec.family, ApiFamily::Videos);
        assert_eq!(spec.max_reference_images, DEFAULT_MAX_REFERENCE_IMAGES);
        assert_eq!(spec.duration, DurationRule::Passthrough);
        assert!(spec.supports_reference_audio);
        assert!(spec.supports_reference_video);
        assert_eq!(spec.dialect, ReferenceDialect::Keep);
    }

    #[test]
    fn undocumented_1080p_variant_is_not_moved_to_another_family() {
        // `seedance-v2.5-1080p` 没有文档依据, 不该被顺手当成 v2-1080p 改到族 2。
        let spec = model_spec("seedance-v2.5-1080p");
        assert_eq!(spec.family, ApiFamily::Videos);
        assert_eq!(spec.max_reference_images, 9);
        assert_eq!(spec.duration, DurationRule::Range(4, 15));
    }

    // ---- 模型限制 ----

    #[test]
    fn seedance25_is_fixed_30s_with_30_images() {
        let spec = model_spec("seedance2.5");
        assert_eq!(spec.duration, DurationRule::PlatformDefault);
        assert_eq!(spec.max_reference_images, 30);
        assert_eq!(spec.dialect, ReferenceDialect::AtPicture);
    }

    #[test]
    fn seedance_v2_uses_933_limits() {
        let spec = model_spec("seedance-v2-720p");
        assert_eq!(spec.max_reference_images, 9);
        assert_eq!(spec.max_reference_audio, 3);
        assert_eq!(spec.max_reference_videos, 3);
        assert!(spec.supports_reference_audio);
        // 参考视频只由 `-video` 后缀模型支持。
        assert!(!spec.supports_reference_video);
        assert!(model_spec("seedance-v2-720p-video").supports_reference_video);
    }

    #[test]
    fn minimax_h3_rejects_audio_and_video_references() {
        let spec = model_spec("Minimax-h3");
        assert_eq!(spec.max_reference_images, 9);
        assert!(!spec.supports_reference_audio);
        assert!(!spec.supports_reference_video);
        assert_eq!(spec.duration, DurationRule::Range(4, 15));
    }

    #[test]
    fn model_matching_is_case_insensitive_and_prefix_tolerant() {
        assert_eq!(model_spec("HF-Seedance-2.5-1080p").duration, DurationRule::PlatformDefault);
        assert_eq!(model_spec("seedance-v2.5-1080p").max_reference_images, 9);
        assert_eq!(model_spec("minimax-h3-pro-720p").max_reference_images, 9);
        assert_eq!(model_spec("SD-2-VIP").family, ApiFamily::Task);
    }

    // ---- 时长 ----

    #[test]
    fn duration_is_clamped_into_the_documented_range() {
        // Minimax-h3 / seedance-v2-720p 文档: 4~15 秒。
        assert_eq!(resolve_duration(DurationRule::Range(4, 15), 2), Some(4));
        assert_eq!(resolve_duration(DurationRule::Range(4, 15), 30), Some(15));
        assert_eq!(resolve_duration(DurationRule::Range(4, 15), 10), Some(10));
        // sd-2 文档: 5~15 秒整数。
        assert_eq!(resolve_duration(DurationRule::Range(5, 15), 4), Some(5));
        // 平台自己定 / 编在模型名里的都不带时长字段。
        assert_eq!(resolve_duration(DurationRule::PlatformDefault, 10), None);
        assert_eq!(resolve_duration(DurationRule::InModelName, 10), None);
        assert_eq!(resolve_duration(DurationRule::Passthrough, 0), Some(1));
    }

    #[test]
    fn fixed_duration_models_omit_seconds_entirely() {
        let body = body_of(&request_with("seedance2.5", 10, "16:9"));
        assert!(body.get("seconds").is_none(), "seedance2.5 固定 30 秒, 不该带 seconds");
        let body = body_of(&request_with("LongXia-O-sora2-pro-8s-9x16", 10, "9:16"));
        assert!(body["params"].get("seconds").is_none(), "时长编在模型名里, 不该带 seconds");
    }

    #[test]
    fn minimax_duration_is_clamped_not_passed_through() {
        let body = body_of(&request_with("Minimax-h3", 30, "16:9"));
        assert_eq!(body["seconds"], json!("15"));
    }

    // ---- 画幅 ----

    #[test]
    fn pixel_size_maps_documented_ratios() {
        assert_eq!(pixel_size_of("16:9"), Some("1280x720"));
        assert_eq!(pixel_size_of("9:16"), Some("720x1280"));
        assert_eq!(pixel_size_of("1:1"), Some("1024x1024"));
        // 未覆盖的比例只发 ratio, 不猜 size。
        assert_eq!(pixel_size_of("adaptive"), None);
    }

    #[test]
    fn seedance_v2_ratio_is_snapped_into_its_two_value_whitelist() {
        let spec = model_spec("seedance-v2-720p");
        // 文档 §3.4: 仅 9:16 / 16:9, 不要传 1:1。
        assert_eq!(resolve_aspect_ratio(&spec, "16:9").as_deref(), Some("16:9"));
        assert_eq!(resolve_aspect_ratio(&spec, "9:16").as_deref(), Some("9:16"));
        // 白名单外按横/竖归属就近吸附, 不猜具体档位。
        assert_eq!(resolve_aspect_ratio(&spec, "4:3").as_deref(), Some("16:9"));
        assert_eq!(resolve_aspect_ratio(&spec, "3:4").as_deref(), Some("9:16"));
        assert_eq!(resolve_aspect_ratio(&spec, "1:1").as_deref(), Some("9:16"));
        assert_eq!(resolve_aspect_ratio(&spec, "adaptive").as_deref(), Some("9:16"));
        // 用户没选画幅时也要落到文档默认, 不能交给平台默认(界面会对不上)。
        assert_eq!(resolve_aspect_ratio(&spec, "   ").as_deref(), Some("9:16"));
        assert_eq!(resolve_aspect_ratio(&spec, "16:9").as_deref(), Some("16:9"));
    }

    #[test]
    fn models_without_a_documented_whitelist_keep_the_user_choice() {
        let spec = model_spec("Minimax-h3");
        assert_eq!(resolve_aspect_ratio(&spec, "21:9").as_deref(), Some("21:9"));
        // 没选就不发, 让平台用它的默认。
        assert_eq!(resolve_aspect_ratio(&spec, ""), None);
    }

    #[test]
    fn seedance25_keeps_one_to_one_ratio() {
        let body = body_of(&request_with("seedance2.5", 30, "1:1"));
        assert_eq!(body["ratio"], json!("1:1"));
        assert_eq!(body["size"], json!("1024x1024"));
    }

    // ---- 引用标记方言 ----

    #[test]
    fn seedance25_rewrites_image_tokens_to_at_picture() {
        assert_eq!(
            localize_reference_tokens("保持@图1人物外观与@图2场景风格", ReferenceDialect::AtPicture, 2, 0, 0),
            "保持@图片1人物外观与@图片2场景风格"
        );
        // 已经是目标写法的保持原样(幂等)。
        assert_eq!(
            localize_reference_tokens("保持@图片1人物外观", ReferenceDialect::AtPicture, 1, 0, 0),
            "保持@图片1人物外观"
        );
    }

    #[test]
    fn seedance25_does_not_invent_audio_or_video_tokens() {
        // 该文档只定义了图片标记, 音频/视频标记没有依据 → 原样保留。
        assert_eq!(
            localize_reference_tokens("使用 @音频1 作为人声参考", ReferenceDialect::AtPicture, 1, 1, 0),
            "使用 @音频1 作为人声参考"
        );
    }

    #[test]
    fn seedance_v2_rewrites_to_bracketed_dialect() {
        assert_eq!(
            localize_reference_tokens(
                "人物跟着 @音频1 的节奏点头, 动作参考 @图2, 外形参考 @图1",
                ReferenceDialect::Bracketed,
                2,
                1,
                0
            ),
            "人物跟着 [audio_1] 的节奏点头, 动作参考 [image2], 外形参考 [image1]"
        );
    }

    #[test]
    fn bracketed_dialect_also_accepts_documented_underscore_form() {
        // 文档 §3.3 用的是 `[audio_1]` / `[video_1]`, 用户照抄进来也要认。
        assert_eq!(
            localize_reference_tokens("[audio_1] 与 [video_2]", ReferenceDialect::Bracketed, 0, 1, 2),
            "[audio_1] 与 [video_2]"
        );
    }

    #[test]
    fn out_of_range_tokens_are_left_untouched() {
        // 素材被上限截断 / 模型不支持该通道时, 不能映射到不存在的素材。
        assert_eq!(
            localize_reference_tokens("@图3 与 @图1", ReferenceDialect::AtPicture, 2, 0, 0),
            "@图3 与 @图片1"
        );
        assert_eq!(
            localize_reference_tokens("@音频1 参考", ReferenceDialect::Bracketed, 1, 0, 0),
            "@音频1 参考"
        );
    }

    #[test]
    fn bare_prose_is_never_rewritten() {
        // 「参考图1」「如图1所示」是普通正文, 不能当成引用标记。
        assert_eq!(
            localize_reference_tokens("如图1所示, 参考图2的构图", ReferenceDialect::AtPicture, 3, 0, 0),
            "如图1所示, 参考图2的构图"
        );
        // 非 token 位置的 `@` 也要原样搬过去。
        assert_eq!(
            localize_reference_tokens("邮箱 a@图b 与 @图1", ReferenceDialect::AtPicture, 1, 0, 0),
            "邮箱 a@图b 与 @图片1"
        );
    }

    #[test]
    fn keep_dialect_returns_the_prompt_verbatim() {
        let prompt = "保持 @图1 与 @音频1 一致";
        assert_eq!(localize_reference_tokens(prompt, ReferenceDialect::Keep, 9, 9, 9), prompt);
    }

    #[test]
    fn token_scanner_reports_the_right_lengths() {
        let prompt = "@图12 与 [audio_3]";
        let first = parse_reference_token(prompt, 0).expect("应识别出 @图12");
        assert_eq!(first.number, 12);
        assert_eq!(first.len, "@图12".len());
        let second_index = prompt.find('[').unwrap();
        let second = parse_reference_token(prompt, second_index).expect("应识别出 [audio_3]");
        assert_eq!(second.kind, TokenKind::Audio);
        assert_eq!(second.number, 3);
        assert_eq!(second.len, "[audio_3]".len());
        // 缺右括号 / 没有数字都不算 token。
        assert!(parse_reference_token("[audio_3", 0).is_none());
        assert!(parse_reference_token("@图", 0).is_none());
    }

    // ---- 图床 ----

    #[test]
    fn image_bed_url_strips_api_subdomain() {
        let request = request_with("seedance2.5", 10, "16:9");
        assert_eq!(
            image_bed_upload_url("https://api.wgspai.cn", &request),
            "https://wgspai.cn/image-bed/api/upload"
        );
        // 不带 api. 前缀的写法同样成立, 末尾斜杠不影响结果。
        assert_eq!(
            image_bed_upload_url("https://wgspai.cn/", &request),
            "https://wgspai.cn/image-bed/api/upload"
        );
    }

    #[test]
    fn configured_upload_url_wins() {
        let mut params = std::collections::HashMap::new();
        params.insert(
            "reference_asset_upload_url".to_string(),
            serde_json::json!("https://mirror.example.com/upload"),
        );
        let mut request = request_with("seedance2.5", 10, "16:9");
        request.extra_params = Some(params);
        assert_eq!(
            image_bed_upload_url("https://api.wgspai.cn", &request),
            "https://mirror.example.com/upload"
        );
    }

    // ---- 参考素材通道 ----

    #[test]
    fn task_family_routes_videos_into_params_videos() {
        let mut params = std::collections::HashMap::new();
        params.insert("reference_videos".to_string(), json!(["https://cdn.example.com/a.mp4"]));
        let mut request = request_with("sd-2", 10, "16:9");
        request.extra_params = Some(params);
        request.reference_images = Some(vec!["https://cdn.example.com/ref.jpg".into()]);

        let model = "sd-2";
        let spec = model_spec(model);
        let body = build_request_body(
            &spec,
            &request,
            model,
            &ResolvedReferences {
                images: vec!["https://cdn.example.com/ref.jpg".into()],
                audios: Vec::new(),
                videos: vec!["https://cdn.example.com/a.mp4".into()],
            },
        );
        assert_eq!(body["params"]["images"], json!(["https://cdn.example.com/ref.jpg"]));
        assert_eq!(body["params"]["videos"], json!(["https://cdn.example.com/a.mp4"]));
        assert!(body["params"].get("content").is_none());
    }

    #[test]
    fn seedance_v2_task_variant_uses_typed_content_array() {
        let spec = model_spec("seedance-v2-1080p-video");
        let request = request_with("seedance-v2-1080p-video", 10, "16:9");
        let body = build_request_body(
            &spec,
            &request,
            "seedance-v2-1080p-video",
            &ResolvedReferences {
                images: vec!["https://cdn.example.com/ref.jpg".into()],
                audios: vec!["https://cdn.example.com/bgm.mp3".into()],
                videos: vec!["https://cdn.example.com/motion.mp4".into()],
            },
        );
        let content = body["params"]["content"].as_array().expect("应为类型化数组");
        assert_eq!(content.len(), 3);
        assert_eq!(content[0]["role"], json!("reference_image"));
        assert_eq!(content[1]["role"], json!("reference_video"));
        assert_eq!(content[2]["role"], json!("reference_audio"));
        // 1080p 按次计费, 文档口径「无需传时长」。
        assert!(body["params"].get("seconds").is_none());
    }

    #[test]
    fn flashvsr_uses_singular_video_url() {
        let mut params = std::collections::HashMap::new();
        params.insert("reference_videos".to_string(), json!(["https://cdn.example.com/a.mp4"]));
        let mut request = request_with("flashvsr-restore", 10, "16:9");
        request.extra_params = Some(params);
        let spec = model_spec("flashvsr-restore");
        let body = build_request_body(
            &spec,
            &request,
            "flashvsr-restore",
            &ResolvedReferences {
                images: Vec::new(),
                audios: Vec::new(),
                videos: vec!["https://cdn.example.com/a.mp4".into()],
            },
        );
        assert_eq!(body["params"]["video_url"], json!("https://cdn.example.com/a.mp4"));
        assert!(body["params"].get("videos").is_none());
    }

    #[test]
    fn videos_family_keeps_top_level_reference_fields() {
        let request = request_with("seedance-v2-720p", 8, "16:9");
        let spec = model_spec("seedance-v2-720p");
        let body = build_request_body(
            &spec,
            &request,
            "seedance-v2-720p",
            &ResolvedReferences {
                images: vec!["https://cdn.example.com/ref.jpg".into()],
                audios: vec!["https://cdn.example.com/bgm.mp3".into()],
                videos: Vec::new(),
            },
        );
        assert!(body.get("params").is_none(), "族 1 不接受 params 信封");
        assert_eq!(body["images"], json!(["https://cdn.example.com/ref.jpg"]));
        assert_eq!(body["audio_urls"], json!(["https://cdn.example.com/bgm.mp3"]));
        assert_eq!(body["seconds"], json!("8"));
    }

    #[test]
    fn first_last_mode_marks_the_first_image_as_first_frame() {
        let mut request = request_with("seedance2.5", 30, "16:9");
        request.image_mode = Some("first-last".into());
        let spec = model_spec("seedance2.5");
        let body = build_request_body(
            &spec,
            &request,
            "seedance2.5",
            &ResolvedReferences {
                images: vec!["https://cdn.example.com/a.jpg".into(), "https://cdn.example.com/b.jpg".into()],
                audios: Vec::new(),
                videos: Vec::new(),
            },
        );
        assert_eq!(body["image_usage"], json!("first_frame"));
    }

    // ---- 业务错误体 ----

    #[test]
    fn task_family_business_error_is_reported() {
        let payload = json!({
            "code": -1,
            "message": "错误描述",
            "data": { "code": "error_code", "message": "详细错误信息" }
        });
        assert!(business_error(&payload).is_some());
        // code = 0 是正常响应。
        assert!(business_error(&json!({ "code": 0, "data": { "status": "pending" } })).is_none());
    }

    #[test]
    fn a_running_task_is_never_killed_by_a_stray_code() {
        // 平台说还在跑时, 顶层 code 一律不采信(否则已计费的长任务会被判死)。
        let payload = json!({ "code": -1, "message": "上游繁忙", "data": { "status": "processing" } });
        assert!(business_error(&payload).is_none());
    }
}
