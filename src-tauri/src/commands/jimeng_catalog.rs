//! 即梦画布 CLI 的**模型目录自动同步**。
//!
//! ## 为什么需要这个模块
//!
//! 以前模型列表是手抄进 `registry.ts` 的：CLI 每加一个型号，我们就要人肉比对
//! `dreamina-canvas model list`、抄档位、抄画幅上限、补一条价格、发版。漏一次的表现是
//! 「平台已经有 5.5 了，但软件里选不到」，而且没人知道漏了。
//!
//! 画布 CLI 自带机器可读的模型清单：
//!
//! ```text
//! dreamina-canvas model list --type=image|video|audio --format json
//! {"data":{"items":[{"type":"image","model":"seedream_5.5","displayName":"Seedream 5.5",
//!   "modes":[{"name":"t2i","flags":[{"flag":"--resolution","values":["1.5K","2K"]}, ...],
//!            "references":{"min":0,"max":14}}]}]}}
//! ```
//!
//! 档位、画幅、时长区间、参考图上限全在里面 —— 所以能力部分可以**完全自动**。
//!
//! ## 价格为什么要单独走「探针」
//!
//! 积分价目不在清单里，只能问服务端。好在 `node quote` 是**免费**的：建节点（不 run）
//! 不扣分，报价只是预估。实测 `seedream_5.5 @1.5K` 报 4 分、`seedance_2.5 @720p`
//! 4 秒 80 分 / 8 秒 160 分（严格线性），与之前人工核对的表一致。
//!
//! 于是价格同步 = 建一批探针节点 → 一次批量报价 → 立刻批量删除。它**有副作用**
//! （会在用户账号里留下草稿版本号），所以只在用户点「刷新积分价格」时执行，不在启动时跑。

use std::collections::BTreeSet;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::jimeng_cli::{
    canvas_cli_args, find_json_number_field, find_json_string_field, parse_canvas_payload,
    run_canvas_cli_with_timeout, spawn_cli_capture, try_spawn_cli_capture, CANVAS_QUOTE_KEYS,
};
use crate::database;

const CATALOG_SETTING_KEY: &str = "jimeng_canvas_model_catalog";
const PRICE_SETTING_KEY: &str = "jimeng_canvas_model_prices";
/// 旧 CLI（`dreamina`）的合并型号清单缓存。以前不缓存（纯本地解析很便宜），
/// 现在带服务端探针，一次刷新要几秒，所以同样按 24 小时兜住。
const LEGACY_SETTING_KEY: &str = "jimeng_cli_legacy_catalog";

/// 目录缓存有效期。CLI 升级是低频事件，一天一次足够；用户也可以手动强制刷新。
const CATALOG_TTL_SECS: i64 = 24 * 60 * 60;

/// 目录结构版本。加了「分媒体参考额度」这类字段就 +1 ——
/// 旧缓存里没有这些字段，`serde(default)` 会补成 0，前端会把 0 当成
/// 「该模型不收视频」，节点上就会一直显示「不读取视频参考」。
const CATALOG_SCHEMA_VERSION: u32 = 2;

/// `model list` 单次超时。它要打一次网络，比普通命令慢。
const MODEL_LIST_TIMEOUT: Duration = Duration::from_secs(60);

/// 探针节点的标题前缀。删除批次清理时靠它认领，也方便用户在网页端一眼看出这些是什么。
const PROBE_TITLE_PREFIX: &str = "LenTalk 价目探针";

/// 专用画布名。价格探针会往里建/删节点，绝不能污染用户的创作画布。
const PROBE_CANVAS_NAME: &str = "LenTalk-价格探针";

/// 一次 `node quote` 最多带多少个节点。CLI 用可重复的 `--node-id`，命令行过长会被系统截断，
/// 40 个（约 40×20 字符）离 Windows 的 32K 限制还很远。
const QUOTE_BATCH: usize = 40;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

// ── 数据结构 ────────────────────────────────────────────────────────────────

/// 清单里的一个模型，能力字段已经按「取并集」的口径归一过。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogEntry {
    pub model: String,
    pub display_name: String,
    pub aliases: Vec<String>,
    /// `image` / `video` / `audio`
    pub media_type: String,
    /// 支持的 mode 名（t2i / i2i / t2v / first_last_frame / m2v …）
    pub modes: Vec<String>,
    /// 分辨率档位，已按画质从小到大排序
    pub resolutions: Vec<String>,
    pub aspect_ratios: Vec<String>,
    /// 可选时长（秒），由 `--duration` 的 min/max/step 展开
    pub durations: Vec<u32>,
    pub max_count: u32,
    /// `--count` 的下限。固定张数模型等于 `fixed_count`，普通模型是 1。
    #[serde(default = "default_min_count")]
    pub min_count: u32,
    /// 固定出图张数（如 MJ 8.2 一次必出 4 张）：`--count` 声明 required 且 min==max 时才有值。
    /// 报价拿到的是**这一批**的积分，界面要显示单张价就得除以它。
    pub fixed_count: Option<u32>,
    pub max_references: u32,
    /// `m2v` 模式下能带几张参考图（`references.types[mediaType=image].max`）。
    ///
    /// 图片模型里它等于 `max_references`，但视频模型不是：`seedance_2.5` 总数 50
    /// （图 30 + 视频 10 + 音频 10），拿总数当图片额度会允许用户选 50 张。
    #[serde(default)]
    pub max_image_references: u32,
    /// `m2v` 模式下能带几段参考视频（`references.types[mediaType=video].max`）。
    ///
    /// `max_references` 是各类素材的**总数**，不能当视频额度用：`seedance_2.5_flash`
    /// 总数 20，但视频只收 5 段；`vidu Q2` 总数 7，却一段视频都不收。节点上的
    /// 「参考视频会不会被提交」只能按这个字段判。
    #[serde(default)]
    pub max_video_references: u32,
    /// `m2v` 模式下能带几段参考音频（`references.types[mediaType=audio].max`）。
    #[serde(default)]
    pub max_audio_references: u32,
    /// 图生图最少要几张参考图（`references.min`）。1 = 必须给图，0 = 可以不给。
    #[serde(default)]
    pub min_references: u32,
    /// `--prompt` 的字符上限，取各 mode 的**最小值**。
    ///
    /// 这个值每个模型都不一样(实测 MJ 8.2 只有 1024, seedream 4.x 2000, 5.x 5000,
    /// GPT Image 系 7000)，超了服务端直接 `service.2 / params.prompt` 拒掉。
    /// 0 = 目录没声明, 不限制。
    #[serde(default)]
    pub max_prompt_length: u32,
    pub supports_first_frame: bool,
    pub vip_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    /// 结构版本，用于让旧缓存自动失效（见 `CATALOG_SCHEMA_VERSION`）。
    #[serde(default)]
    pub schema_version: u32,
    pub cli_version: String,
    pub fetched_at: i64,
    pub image: Vec<ModelCatalogEntry>,
    pub video: Vec<ModelCatalogEntry>,
    pub audio: Vec<ModelCatalogEntry>,
}

impl ModelCatalog {
    /// 按模型 id 找条目（跨三类媒体）。
    pub fn find(&self, model: &str) -> Option<&ModelCatalogEntry> {
        self.image
            .iter()
            .chain(self.video.iter())
            .chain(self.audio.iter())
            .find(|entry| entry.model == model)
    }

    fn is_empty(&self) -> bool {
        self.image.is_empty() && self.video.is_empty() && self.audio.is_empty()
    }
}

/// 一次报价请求：一个「模型 × 档位」组合。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceProbeRequest {
    pub model: String,
    /// `image` 或 `video`
    pub media_type: String,
    pub resolution: String,
    /// 视频必填：基准时长。价格随时长线性，所以报一个点就够（实测 4s=80、8s=160）。
    pub duration: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelPriceQuote {
    pub model: String,
    pub media_type: String,
    pub resolution: String,
    pub duration: Option<u32>,
    /// 这一次报价的**总**积分（图片=一批的张数，视频=基准时长的整段）
    pub credits: f64,
    /// 批内数量：图片=张数，视频=秒数
    pub units: u32,
    /// 计价单位积分：图片=单张，视频=每秒。价目表直接用它。
    pub unit_credits: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPriceReport {
    pub quotes: Vec<ModelPriceQuote>,
    /// 一条条「模型 @ 档位：原因」，前端折叠展示，不影响能用价格
    pub failures: Vec<String>,
    pub probed_at: i64,
}

// ── 解析 ────────────────────────────────────────────────────────────────────

/// 画质档位排序键。
///
/// 清单给的顺序是服务端登记顺序，既不是从低到高也不稳定（实测 `["2K","4K"]` 与
/// `["1K","2K","4K"]` 混排）。下拉框要按画质递增，所以自己排：
/// 先按单位分组（`p` 系在 `K` 系之前），再按数值。
fn resolution_sort_key(value: &str) -> (u8, f64) {
    let lower = value.trim().to_ascii_lowercase();
    let (number, unit) = if let Some(rest) = lower.strip_suffix('p') {
        (rest, 0u8)
    } else if let Some(rest) = lower.strip_suffix('k') {
        (rest, 1u8)
    } else {
        (lower.as_str(), 2u8)
    };
    (unit, number.parse::<f64>().unwrap_or(f64::MAX))
}

fn collect_flag_values(mode: &serde_json::Value, flag: &str) -> Vec<String> {
    mode.get("flags")
        .and_then(serde_json::Value::as_array)
        .map(|flags| {
            flags
                .iter()
                .filter(|item| item.get("flag").and_then(serde_json::Value::as_str) == Some(flag))
                .filter_map(|item| item.get("values").and_then(serde_json::Value::as_array))
                .flatten()
                .filter_map(|value| value.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn collect_flag_number(mode: &serde_json::Value, flag: &str, key: &str) -> Option<f64> {
    mode.get("flags")?
        .as_array()?
        .iter()
        .find(|item| item.get("flag").and_then(serde_json::Value::as_str) == Some(flag))?
        .get(key)?
        .as_f64()
}

/// 把 `min/max/step` 展开成可选时长列表。
///
/// 两道闸门都是防呆：`max` 截到 120 秒（清单里真出现 `max: 3600` 的异常值时不至于
/// 让前端渲染一屏按钮），条数截到 64（`step: 0.5` 且区间很宽时同理）。
fn expand_durations(min: u32, max: u32, step: u32) -> Vec<u32> {
    const MAX_DURATION_SEC: u32 = 120;
    const MAX_DURATION_OPTIONS: usize = 64;

    let step = step.max(1);
    let max = max.min(MAX_DURATION_SEC);
    let mut values = Vec::new();
    let mut current = min.max(1);
    while current <= max && values.len() < MAX_DURATION_OPTIONS {
        values.push(current);
        current = match current.checked_add(step) {
            Some(next) => next,
            None => break,
        };
    }
    values
}

fn parse_entry(item: &serde_json::Value) -> Option<ModelCatalogEntry> {
    let model = item.get("model")?.as_str()?.trim().to_string();
    if model.is_empty() {
        return None;
    }

    let media_type = item
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("image")
        .to_string();
    let display_name = item
        .get("displayName")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&model)
        .to_string();
    let aliases = item
        .get("aliases")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let modes: Vec<&serde_json::Value> = item
        .get("modes")
        .and_then(serde_json::Value::as_array)
        .map(|values| values.iter().collect())
        .unwrap_or_default();
    if modes.is_empty() {
        return None;
    }

    let mut mode_names = Vec::new();
    let mut resolutions = BTreeSet::new();
    let mut aspect_ratios: Vec<String> = Vec::new();
    let mut durations = Vec::new();
    let mut max_count = 1u32;
    let mut min_count = 1u32;
    let mut fixed_count: Option<u32> = None;
    let mut max_references = 0u32;
    let mut max_image_references = 0u32;
    let mut max_video_references = 0u32;
    let mut max_audio_references = 0u32;
    let mut min_references: Option<u32> = None;
    let mut max_prompt_length: Option<u32> = None;
    let mut vip_required = false;

    for mode in &modes {
        if let Some(name) = mode.get("name").and_then(serde_json::Value::as_str) {
            if !mode_names.iter().any(|existing: &String| existing == name) {
                mode_names.push(name.to_string());
            }
        }

        for value in collect_flag_values(mode, "--resolution") {
            resolutions.insert(value);
        }
        for value in collect_flag_values(mode, "--ratio") {
            if !aspect_ratios.contains(&value) {
                aspect_ratios.push(value);
            }
        }

        // 时长只取最宽的区间：同一模型不同 mode 的时长可能不同，取并集才不漏。
        if let (Some(min), Some(max)) = (
            collect_flag_number(mode, "--duration", "min"),
            collect_flag_number(mode, "--duration", "max"),
        ) {
            let step = collect_flag_number(mode, "--duration", "step").unwrap_or(1.0);
            let expanded = expand_durations(min as u32, max as u32, step as u32);
            if expanded.len() > durations.len() {
                durations = expanded;
            }
        }

        if let Some(count) = collect_flag_number(mode, "--count", "max") {
            max_count = max_count.max(count as u32);
        }
        if let Some(count) = collect_flag_number(mode, "--count", "min") {
            // 取各 mode 的最小值：能文生图的模型必须允许 1 张，否则界面会把下限抬死。
            min_count = min_count.min(count.max(1.0) as u32);
        }
        // `--prompt` 的字符上限：取各 mode 的最小值。超了服务端报
        // `service.2 / params.prompt`，本地提前拦住比让用户改提示词重试友好。
        if let Some(length) = mode
            .get("flags")
            .and_then(serde_json::Value::as_array)
            .and_then(|flags| {
                flags.iter().find(|item| {
                    item.get("flag").and_then(serde_json::Value::as_str) == Some("--prompt")
                })
            })
            .and_then(|flag| flag.get("maxLength"))
            .and_then(serde_json::Value::as_u64)
        {
            let length = length as u32;
            max_prompt_length = Some(match max_prompt_length {
                Some(existing) => existing.min(length),
                None => length,
            });
        }
        // 固定张数模型（MJ 8.2 必须一次 4 张）：required 且 min==max。
        // 不显式传 --count 会直接被 CLI 拒，报价也就拿不到。
        if let (Some(min), Some(max)) = (
            collect_flag_number(mode, "--count", "min"),
            collect_flag_number(mode, "--count", "max"),
        ) {
            let required = mode
                .get("flags")
                .and_then(serde_json::Value::as_array)
                .map(|flags| {
                    flags.iter().any(|item| {
                        item.get("flag").and_then(serde_json::Value::as_str) == Some("--count")
                            && item
                                .get("required")
                                .and_then(serde_json::Value::as_bool)
                                .unwrap_or(false)
                    })
                })
                .unwrap_or(false);
            if required && (min - max).abs() < f64::EPSILON && min >= 1.0 {
                fixed_count = Some(min as u32);
            }
        }
        if let Some(references) = mode
            .get("references")
            .and_then(|value| value.get("max"))
            .and_then(serde_json::Value::as_u64)
        {
            max_references = max_references.max(references as u32);
        }
        if let Some(references) = mode
            .get("references")
            .and_then(|value| value.get("min"))
            .and_then(serde_json::Value::as_u64)
        {
            let references = references as u32;
            min_references = Some(match min_references {
                Some(existing) => existing.min(references),
                None => references,
            });
        }
        // 分媒体类型的额度：`references.types` 才有，`references.max` 是总数。
        // 视频/音频额度取各 mode 的最大值 —— 换 mode 不该让节点上的上限变小。
        if let Some(types) = mode
            .get("references")
            .and_then(|value| value.get("types"))
            .and_then(serde_json::Value::as_array)
        {
            for item in types {
                let media_max = item
                    .get("max")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0) as u32;
                match item
                    .get("mediaType")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                {
                    "image" => max_image_references = max_image_references.max(media_max),
                    "video" => max_video_references = max_video_references.max(media_max),
                    "audio" => max_audio_references = max_audio_references.max(media_max),
                    _ => {}
                }
            }
        }
        if mode
            .get("vipRequired")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            vip_required = true;
        }
    }

    let mut sorted_resolutions: Vec<String> = resolutions.into_iter().collect();
    sorted_resolutions.sort_by(|a, b| {
        resolution_sort_key(a)
            .partial_cmp(&resolution_sort_key(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let supports_first_frame = mode_names
        .iter()
        .any(|mode| mode == "first_last_frame" || mode == "m2v");

    // 固定张数模型的「下限」就是那个固定值：传少了服务端直接拒。
    if let Some(fixed) = fixed_count {
        min_count = fixed;
    }

    Some(ModelCatalogEntry {
        model,
        display_name,
        aliases,
        media_type,
        modes: mode_names,
        resolutions: sorted_resolutions,
        aspect_ratios,
        durations,
        max_count,
        min_count,
        fixed_count,
        max_references,
        max_image_references,
        max_video_references,
        max_audio_references,
        min_references: min_references.unwrap_or(0),
        max_prompt_length: max_prompt_length.unwrap_or(0),
        supports_first_frame,
        vip_required,
    })
}

fn default_min_count() -> u32 {
    1
}

fn parse_catalog_items(value: &serde_json::Value) -> Vec<ModelCatalogEntry> {
    value
        .get("items")
        .and_then(serde_json::Value::as_array)
        .map(|items| items.iter().filter_map(parse_entry).collect())
        .unwrap_or_default()
}

// ── 缓存 ────────────────────────────────────────────────────────────────────

fn read_cached_catalog(app: &AppHandle) -> Option<ModelCatalog> {
    let conn = database::open(app).ok()?;
    let raw = database::get_setting(&conn, CATALOG_SETTING_KEY).ok()??;
    let catalog = serde_json::from_str::<ModelCatalog>(&raw).ok()?;
    // 旧版本缓存直接当作没有：否则缺字段会被补成 0，判定结果全错。
    if catalog.schema_version < CATALOG_SCHEMA_VERSION {
        return None;
    }
    Some(catalog)
}

fn write_cached_catalog(app: &AppHandle, catalog: &ModelCatalog) -> Result<(), String> {
    let conn = database::open(app)?;
    let serialized = serde_json::to_string(catalog)
        .map_err(|error| format!("序列化模型目录失败: {error}"))?;
    database::put_setting(&conn, CATALOG_SETTING_KEY, &serialized)
}

// ── 命令：读取 / 刷新模型目录 ───────────────────────────────────────────────

fn fetch_cli_version(executable: &str) -> String {
    run_canvas_cli_with_timeout(
        executable,
        &canvas_cli_args(&["version", "--format", "json"]),
        Duration::from_secs(20),
    )
    .ok()
    .and_then(|output| parse_canvas_payload(&output).ok())
    .and_then(|data| {
        data.get("version")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    })
    .unwrap_or_default()
}

fn fetch_catalog(executable: &str) -> Result<ModelCatalog, String> {
    let cli_version = fetch_cli_version(executable);

    let mut image = Vec::new();
    let mut video = Vec::new();
    let mut audio = Vec::new();
    let mut last_error = String::new();

    for (kind, bucket) in [
        ("image", &mut image),
        ("video", &mut video),
        ("audio", &mut audio),
    ] {
        let output = match run_canvas_cli_with_timeout(
            executable,
            &canvas_cli_args(&[
                "model",
                "list",
                &format!("--type={kind}"),
                "--non-interactive",
                "--format",
                "json",
            ]),
            MODEL_LIST_TIMEOUT,
        ) {
            Ok(output) => output,
            Err(error) => {
                last_error = error;
                continue;
            }
        };
        match parse_canvas_payload(&output) {
            Ok(data) => *bucket = parse_catalog_items(&data),
            Err(error) => last_error = error,
        }
    }

    let catalog = ModelCatalog {
        schema_version: CATALOG_SCHEMA_VERSION,
        cli_version,
        fetched_at: now_secs(),
        image,
        video,
        audio,
    };

    // 三类全空 = 这次压根没问到（未登录 / 网络 / CLI 版本太老），不能拿它覆盖旧缓存。
    if catalog.is_empty() {
        return Err(if last_error.is_empty() {
            "即梦画布 CLI 未返回任何模型，请确认已登录且 CLI 版本不低于 1.2.0".to_string()
        } else {
            last_error
        });
    }

    Ok(catalog)
}

/// 读取模型目录。
///
/// - `force_refresh=false`：24 小时内直接用缓存（启动路径，不发网络请求）。
/// - `force_refresh=true`：重新问 CLI；失败时**仍然回退到旧缓存**并把错误吞掉 ——
///   刷新按钮不该因为一次网络抖动就让模型列表变空。
#[tauri::command]
pub async fn jimeng_canvas_model_catalog(
    app: AppHandle,
    executable: String,
    force_refresh: Option<bool>,
) -> Result<ModelCatalog, String> {
    let force = force_refresh.unwrap_or(false);
    let cached = read_cached_catalog(&app);

    if !force {
        if let Some(catalog) = &cached {
            if now_secs() - catalog.fetched_at < CATALOG_TTL_SECS && !catalog.is_empty() {
                return Ok(catalog.clone());
            }
        }
    }

    let executable = executable.trim().to_string();
    if executable.is_empty() {
        return cached.ok_or_else(|| "请先填写即梦画布 CLI 的可执行命令".to_string());
    }

    let fetched = tokio::task::spawn_blocking(move || fetch_catalog(&executable))
        .await
        .map_err(|error| format!("即梦画布 CLI 模型清单任务中断: {error}"))?;

    match fetched {
        Ok(catalog) => {
            write_cached_catalog(&app, &catalog)?;
            Ok(catalog)
        }
        Err(error) => cached.ok_or(error),
    }
}

/// 只读缓存（不触发任何 CLI 调用）。Rust 侧的模型校验用它来决定放行哪些型号。
pub fn load_cached_catalog(app: &AppHandle) -> Option<ModelCatalog> {
    read_cached_catalog(app)
}

/// 校验辅助：某个模型是否支持指定档位。
pub fn catalog_supports(
    catalog: &ModelCatalog,
    model: &str,
    resolution: Option<&str>,
) -> bool {
    let Some(entry) = catalog.find(model) else {
        return false;
    };
    match resolution {
        None => true,
        Some(resolution) => entry
            .resolutions
            .iter()
            .any(|value| value.eq_ignore_ascii_case(resolution)),
    }
}

// ── 命令：积分价格探针 ──────────────────────────────────────────────────────

fn find_probe_canvas(executable: &str) -> Result<Option<String>, String> {
    let output = run_canvas_cli_with_timeout(
        executable,
        &canvas_cli_args(&["canvas", "ls", "--non-interactive", "--format", "json"]),
        MODEL_LIST_TIMEOUT,
    )?;
    let data = parse_canvas_payload(&output)?;
    let items = data
        .get("items")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(items
        .iter()
        .find(|item| {
            item.get("name").and_then(serde_json::Value::as_str) == Some(PROBE_CANVAS_NAME)
        })
        .and_then(|item| {
            item.get("projectId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        }))
}

fn ensure_probe_canvas(executable: &str) -> Result<String, String> {
    if let Some(project_id) = find_probe_canvas(executable)? {
        return Ok(project_id);
    }
    let output = run_canvas_cli_with_timeout(
        executable,
        &canvas_cli_args(&[
            "canvas",
            "create",
            PROBE_CANVAS_NAME,
            "--non-interactive",
            "--format",
            "json",
        ]),
        MODEL_LIST_TIMEOUT,
    )?;
    let data = parse_canvas_payload(&output)?;
    find_json_string_field(&data, "projectId")
        .ok_or_else(|| "创建价格探针画布后未返回 projectId".to_string())
}

fn probe_create_args(
    request: &PriceProbeRequest,
    project_id: &str,
    aspect_ratio: &str,
    node_title: &str,
    count: u32,
) -> Option<Vec<String>> {
    let media_kind = match request.media_type.as_str() {
        "image" => "image",
        "video" => "video",
        // 音频按次计费且依赖音色，报价模型与图片/视频不同，这一版不做。
        _ => return None,
    };

    let mut args = vec![
        "node".to_string(),
        "create".to_string(),
        media_kind.to_string(),
        format!("--project-id={project_id}"),
        format!("--model={}", request.model),
        format!("--mode={}", if media_kind == "image" { "t2i" } else { "t2v" }),
        "--prompt=price probe".to_string(),
        format!("--resolution={}", request.resolution),
        format!("--ratio={aspect_ratio}"),
        format!("--title={node_title}"),
        "--non-interactive".to_string(),
        "--format".to_string(),
        "json".to_string(),
    ];
    // 固定张数模型（MJ 8.2）不传 --count 会被直接拒，报价也就拿不到。
    if count > 1 {
        args.push(format!("--count={count}"));
    }
    if media_kind == "video" {
        args.push(format!("--duration={}", request.duration.unwrap_or(5)));
    }
    Some(args)
}

/// 从原始输出里挑出「带指定顶层键的那一行 JSON」。
///
/// 不能直接用 `parse_canvas_payload`：删除的第一次调用**故意是失败的**（CLI 要求先
/// `delete confirm`，单跑 `delete` 只回 `ok=false` + `deletionConfirmation`），而
/// `parse_canvas_payload` 见到 `ok=false` 会把整段正文换成一句错误文案，`updateId` 就丢了。
fn json_line_with_key<'a>(raw: &'a str, key: &str) -> Option<serde_json::Value> {
    raw.lines()
        .filter(|line| line.trim_start().starts_with('{'))
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find(|value| value.get(key).is_some())
}

/// 批量删除探针节点。
///
/// CLI 的删除要两步（`delete confirm` 签发短期凭证 → `delete --delete-token`），
/// `--yes` 单独不够。这里把失败吞掉：探针画布里的残留节点无害，不该让整次报价失败。
fn delete_probe_nodes(executable: &str, project_id: &str, node_ids: &[String]) {
    if node_ids.is_empty() {
        return;
    }
    let id_args: Vec<String> = node_ids
        .iter()
        .map(|node| format!("--node-id={node}"))
        .collect();

    let base = |extra: &[String]| {
        let mut args = vec![
            "node".to_string(),
            "delete".to_string(),
            format!("--project-id={project_id}"),
            "--non-interactive".to_string(),
            "--format".to_string(),
            "json".to_string(),
        ];
        args.extend(id_args.iter().cloned());
        args.extend(extra.iter().cloned());
        args
    };

    let Ok((_, raw)) = spawn_cli_capture(executable, &base(&[]), MODEL_LIST_TIMEOUT, &[]) else {
        return;
    };
    let Some(update_id) = json_line_with_key(&raw, "deletionConfirmation")
        .and_then(|value| value.pointer("/deletionConfirmation/updateId").cloned())
        .and_then(|value| value.as_str().map(str::to_string))
    else {
        return;
    };

    let mut confirm_args = vec![
        "node".to_string(),
        "delete".to_string(),
        "confirm".to_string(),
        format!("--project-id={project_id}"),
        format!("--update-id={update_id}"),
        "--non-interactive".to_string(),
        "--yes".to_string(),
        "--format".to_string(),
        "json".to_string(),
    ];
    confirm_args.extend(id_args.iter().cloned());
    let Ok(confirmed) = run_canvas_cli_with_timeout(executable, &confirm_args, MODEL_LIST_TIMEOUT)
    else {
        return;
    };
    let Some(token) = parse_canvas_payload(&confirmed)
        .ok()
        .and_then(|data| find_json_string_field(&data, "deleteConfirmationToken"))
    else {
        return;
    };

    let _ = run_canvas_cli_with_timeout(
        executable,
        &base(&[
            format!("--update-id={update_id}"),
            format!("--delete-token={token}"),
        ]),
        MODEL_LIST_TIMEOUT,
    );
}

fn probe_prices(
    executable: &str,
    requests: &[PriceProbeRequest],
    catalog: Option<&ModelCatalog>,
) -> Result<ModelPriceReport, String> {
    let project_id = ensure_probe_canvas(executable)?;
    let mut failures = Vec::new();
    let mut prepared: Vec<(usize, PriceProbeRequest, String)> = Vec::new();
    let mut created_nodes: Vec<String> = Vec::new();

    // 1) 逐个建节点（不 run，不扣分）
    for (index, request) in requests.iter().enumerate() {
        let entry = catalog.and_then(|catalog| catalog.find(&request.model));
        let aspect_ratio = entry
            .and_then(|entry| entry.aspect_ratios.first().cloned())
            .unwrap_or_else(|| "1:1".to_string());
        let count = entry.and_then(|entry| entry.fixed_count).unwrap_or(1);
        let title = format!(
            "{PROBE_TITLE_PREFIX} {} {}",
            request.model, request.resolution
        );
        let Some(args) = probe_create_args(request, &project_id, &aspect_ratio, &title, count) else {
            failures.push(format!(
                "{} @ {}：暂不支持该类型的自动报价",
                request.model, request.resolution
            ));
            continue;
        };
        // 失败原因要原样带出来：这一层最容易踩的是「该模型没有 t2i/t2v 模式」和
        // 「分辨率大小写与清单不一致」，笼统说一句「建节点失败」没法排查。
        match run_canvas_cli_with_timeout(executable, &args, MODEL_LIST_TIMEOUT) {
            Ok(output) => match parse_canvas_payload(&output)
                .ok()
                .and_then(|data| find_json_string_field(&data, "nodeId"))
            {
                Some(node_id) => {
                    created_nodes.push(node_id.clone());
                    prepared.push((index, request.clone(), node_id));
                }
                None => failures.push(format!(
                    "{} @ {}：建探针节点后未返回 nodeId",
                    request.model, request.resolution
                )),
            },
            Err(error) => failures.push(format!(
                "{} @ {}：{}",
                request.model, request.resolution, error
            )),
        }
    }

    // 2) 批量报价
    let mut credits_by_node: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for chunk in prepared.chunks(QUOTE_BATCH) {
        let mut args = vec![
            "node".to_string(),
            "quote".to_string(),
            format!("--project-id={project_id}"),
            "--non-interactive".to_string(),
            "--format".to_string(),
            "json".to_string(),
        ];
        for (_, _, node_id) in chunk {
            args.push(format!("--node-id={node_id}"));
        }
        let Ok(output) = run_canvas_cli_with_timeout(executable, &args, MODEL_LIST_TIMEOUT) else {
            for (_, request, _) in chunk {
                failures.push(format!(
                    "{} @ {}：报价请求失败",
                    request.model, request.resolution
                ));
            }
            continue;
        };
        let Ok(data) = parse_canvas_payload(&output) else {
            for (_, request, _) in chunk {
                failures.push(format!(
                    "{} @ {}：报价结果无法解析",
                    request.model, request.resolution
                ));
            }
            continue;
        };
        if let Some(items) = data.get("items").and_then(serde_json::Value::as_array) {
            for item in items {
                let Some(node_id) = find_json_string_field(item, "nodeId") else {
                    continue;
                };
                if let Some(credits) = find_json_number_field(item, &CANVAS_QUOTE_KEYS) {
                    credits_by_node.insert(node_id, credits);
                }
            }
        }
    }

    // 3) 立刻清理（成功失败都清）
    delete_probe_nodes(executable, &project_id, &created_nodes);

    // 4) 组装
    let mut quotes = Vec::new();
    for (_, request, node_id) in &prepared {
        let Some(credits) = credits_by_node.get(node_id).copied() else {
            failures.push(format!(
                "{} @ {}：未返回积分",
                request.model, request.resolution
            ));
            continue;
        };
        let units = if request.media_type == "video" {
            request.duration.unwrap_or(5).max(1)
        } else {
            catalog
                .and_then(|catalog| catalog.find(&request.model))
                .and_then(|entry| entry.fixed_count)
                .unwrap_or(1)
        };
        // 保留一位小数：视频按秒计价除下来常是 6.5 这种值，取整会报错价。
        let unit_credits = ((credits / units.max(1) as f64) * 10.0).round() / 10.0;
        quotes.push(ModelPriceQuote {
            model: request.model.clone(),
            media_type: request.media_type.clone(),
            resolution: request.resolution.clone(),
            duration: request.duration,
            credits,
            units,
            unit_credits,
        });
    }

    Ok(ModelPriceReport {
        quotes,
        failures,
        probed_at: now_secs(),
    })
}

fn read_cached_prices(app: &AppHandle) -> Option<ModelPriceReport> {
    let conn = database::open(app).ok()?;
    let raw = database::get_setting(&conn, PRICE_SETTING_KEY).ok()??;
    serde_json::from_str::<ModelPriceReport>(&raw).ok()
}

/// 批量报价。
///
/// 🔴 **有副作用**：会在「LenTalk-价格探针」画布里建一批节点、报价、立刻删除。
/// 不扣积分，但会推高草稿版本号。所以只由用户点按钮触发，且刷新前要先弹确认。
#[tauri::command]
pub async fn jimeng_canvas_probe_model_prices(
    app: AppHandle,
    executable: String,
    requests: Vec<PriceProbeRequest>,
) -> Result<ModelPriceReport, String> {
    if requests.is_empty() {
        return Err("没有需要报价的模型".to_string());
    }
    let executable = executable.trim().to_string();
    if executable.is_empty() {
        return Err("请先填写即梦画布 CLI 的可执行命令".to_string());
    }

    let catalog = read_cached_catalog(&app);
    let report = tokio::task::spawn_blocking(move || {
        probe_prices(&executable, &requests, catalog.as_ref())
    })
    .await
    .map_err(|error| format!("价格探测任务中断: {error}"))??;

    if report.quotes.is_empty() {
        return Err(if report.failures.is_empty() {
            "未取到任何积分价格".to_string()
        } else {
            format!("未取到任何积分价格：{}", report.failures.join("；"))
        });
    }

    let conn = database::open(&app)?;
    let serialized = serde_json::to_string(&report)
        .map_err(|error| format!("序列化价目失败: {error}"))?;
    database::put_setting(&conn, PRICE_SETTING_KEY, &serialized)?;
    Ok(report)
}

/// 读取已缓存的价目（不触发探测）。
#[tauri::command]
pub fn jimeng_canvas_cached_model_prices(app: AppHandle) -> Option<ModelPriceReport> {
    read_cached_prices(&app)
}

/// 给 Rust 侧校验用的价目快照。
pub fn load_cached_prices(app: &AppHandle) -> Option<ModelPriceReport> {
    read_cached_prices(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_model_list() -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": "1",
            "ok": true,
            "data": {
                "items": [
                    {
                        "type": "image",
                        "model": "seedream_5.5",
                        "displayName": "Seedream 5.5",
                        "aliases": ["5.5"],
                        "modes": [
                            {
                                "name": "i2i",
                                "flags": [
                                    {"flag": "--ratio", "values": ["1:1", "3:4"]},
                                    {"flag": "--resolution", "required": true, "values": ["1.5K", "2K"]},
                                    {"flag": "--count", "min": 1, "max": 8}
                                ],
                                "references": {"min": 1, "max": 10},
                                "vipRequired": false
                            },
                            {
                                "name": "t2i",
                                "flags": [
                                    {"flag": "--ratio", "values": ["1:1", "3:4"]},
                                    {"flag": "--resolution", "required": true, "values": ["1.5K", "2K"]},
                                    {"flag": "--count", "min": 1, "max": 8}
                                ],
                                "references": {"min": 0, "max": 14},
                                "vipRequired": false
                            }
                        ]
                    },
                    {
                        "type": "video",
                        "model": "seedance_2.5",
                        "displayName": "即梦 Seedance 2.5",
                        "modes": [
                            {
                                "name": "t2v",
                                "flags": [
                                    {"flag": "--ratio", "values": ["16:9", "9:16"]},
                                    {"flag": "--resolution", "required": true, "values": ["720p", "1080p", "480p"]},
                                    {"flag": "--duration", "min": 4, "max": 8, "step": 2},
                                    {"flag": "--count", "min": 1, "max": 4}
                                ],
                                "references": {"min": 0, "max": 0},
                                "vipRequired": true
                            }
                        ]
                    }
                ]
            }
        })
    }

    #[test]
    fn parses_image_entry_with_union_of_modes() {
        let value = sample_model_list();
        let entries = parse_catalog_items(&value["data"]);

        assert_eq!(entries.len(), 2);
        let image = &entries[0];
        assert_eq!(image.model, "seedream_5.5");
        assert_eq!(image.display_name, "Seedream 5.5");
        assert_eq!(image.media_type, "image");
        // 两个 mode 的 references.max 取并集
        assert_eq!(image.max_references, 14);
        assert_eq!(image.max_count, 8);
        assert_eq!(image.modes, vec!["i2i", "t2i"]);
        assert!(!image.supports_first_frame);
        assert!(image.durations.is_empty());
    }

    /// `seedance_2.5_flash` 的真实声明：总数 20，但视频只收 5 段、音频 5 段。
    ///
    /// 视频额度必须从 `references.types[mediaType=video]` 取 —— 只读 `references.max`
    /// 会让「只收图的 m2v」（vidu Q2：总数 7、视频 0）也显示成支持参考视频。
    #[test]
    fn parses_reference_quota_per_media_type() {
        let value = serde_json::json!({
            "items": [{
                "type": "video",
                "model": "seedance_2.5_flash",
                "displayName": "即梦 Seedance 2.5 Flash",
                "modes": [
                    {
                        "name": "first_last_frame",
                        "flags": [{"flag": "--duration", "min": 4, "max": 30, "step": 1}],
                        "references": {"min": 2, "max": 2, "types": [{"mediaType": "image", "min": 2, "max": 2}]}
                    },
                    {
                        "name": "m2v",
                        "flags": [{"flag": "--duration", "min": 4, "max": 30, "step": 1}],
                        "references": {
                            "min": 1,
                            "max": 20,
                            "types": [
                                {"mediaType": "image", "min": 0, "max": 10},
                                {"mediaType": "video", "min": 0, "max": 5},
                                {"mediaType": "audio", "min": 0, "max": 5}
                            ],
                            "requireAnyOfTypes": ["image", "video", "audio"]
                        }
                    }
                ]
            }]
        });
        let entries = parse_catalog_items(&value);
        let entry = &entries[0];

        assert_eq!(entry.max_references, 20);
        // 图片额度是 10，不是总数 20 —— 总数含视频与音频。
        assert_eq!(entry.max_image_references, 10);
        assert_eq!(entry.max_video_references, 5);
        assert_eq!(entry.max_audio_references, 5);
        // 首尾帧要 2 张、m2v 只要 1 个素材，取小才不会把单视频提交挡在本地。
        assert_eq!(entry.min_references, 1);
        assert!(entry.modes.iter().any(|mode| mode == "m2v"));
    }

    /// 只收图的 m2v（vidu Q2/Q3）：视频额度为 0，节点不能标「会提交视频」。
    #[test]
    fn image_only_m2v_has_no_video_quota() {
        let value = serde_json::json!({
            "items": [{
                "type": "video",
                "model": "dreamina_vidu_q3",
                "displayName": "Vidu Q3",
                "modes": [{
                    "name": "m2v",
                    "flags": [{"flag": "--duration", "min": 4, "max": 16, "step": 1}],
                    "references": {
                        "min": 1,
                        "max": 7,
                        "types": [{"mediaType": "image", "min": 0, "max": 7}],
                        "requireAnyOfTypes": ["image"]
                    }
                }]
            }]
        });
        let entries = parse_catalog_items(&value);
        assert_eq!(entries[0].max_references, 7);
        assert_eq!(entries[0].max_video_references, 0);
    }

    /// MJ 8.2 的真实声明（`model list --type=image` 原样）：
    /// `--count` required 且 min==max==4，`--prompt` maxLength 只有 1024。
    #[test]
    fn parses_fixed_count_and_prompt_limit() {
        let value = serde_json::json!({
            "items": [{
                "type": "image",
                "model": "jm_image_model_yc_mj82",
                "displayName": "图片美学模型 V8.2",
                "modes": [
                    {
                        "name": "i2i",
                        "flags": [
                            {"flag": "--prompt", "required": false, "maxLength": 1024},
                            {"flag": "--ratio", "required": true, "values": ["1:1", "16:9"]},
                            {"flag": "--resolution", "required": true, "values": ["1K", "2K"]},
                            {"flag": "--count", "required": true, "min": 4, "max": 4}
                        ],
                        "references": {"min": 1, "max": 20}
                    },
                    {
                        "name": "t2i",
                        "flags": [
                            {"flag": "--prompt", "required": true, "maxLength": 512},
                            {"flag": "--ratio", "required": true, "values": ["1:1", "16:9"]},
                            {"flag": "--resolution", "required": true, "values": ["1K", "2K"]},
                            {"flag": "--count", "required": true, "min": 4, "max": 4}
                        ],
                        "references": {"min": 0, "max": 0}
                    }
                ]
            }]
        });
        let entries = parse_catalog_items(&value);
        let entry = &entries[0];

        // 固定张数：required 且 min==max
        assert_eq!(entry.fixed_count, Some(4));
        // 下限跟着固定值走 —— 传 1 会被服务端拒，界面不该允许
        assert_eq!(entry.min_count, 4);
        assert_eq!(entry.max_count, 4);
        // 提示词上限取各 mode 的最小值（1024 与 512 → 512 才安全）
        assert_eq!(entry.max_prompt_length, 512);
        // 参考图下限取最小值：t2i 允许 0 张，不能让整个模型被逼着要图
        assert_eq!(entry.min_references, 0);
        assert_eq!(entry.max_references, 20);
    }

    #[test]
    fn sorts_resolutions_by_quality_not_server_order() {
        let value = sample_model_list();
        let entries = parse_catalog_items(&value["data"]);
        // 清单里是 720p/1080p/480p，必须排成 480p → 720p → 1080p
        assert_eq!(
            entries[1].resolutions,
            vec!["480p", "720p", "1080p"]
        );
    }

    #[test]
    fn expands_duration_range() {
        let value = sample_model_list();
        let entries = parse_catalog_items(&value["data"]);
        assert_eq!(entries[1].durations, vec![4, 6, 8]);
        assert!(entries[1].vip_required);
        assert_eq!(entries[1].media_type, "video");
    }

    #[test]
    fn resolution_sort_puts_p_before_k() {
        let mut values = vec!["4K", "1080p", "1K", "720p", "1.5K"];
        values.sort_by(|a, b| {
            resolution_sort_key(a)
                .partial_cmp(&resolution_sort_key(b))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        assert_eq!(values, vec!["720p", "1080p", "1K", "1.5K", "4K"]);
    }

    #[test]
    fn duration_expansion_is_bounded() {
        // 异常 max 不该炸出上千个按钮：条数上限 64 先生效
        let values = expand_durations(4, 3600, 1);
        assert_eq!(values.len(), 64);
        assert_eq!(values[0], 4);
        assert_eq!(*values.last().unwrap(), 67);
    }

    #[test]
    fn catalog_supports_matches_resolution_case_insensitively() {
        let catalog = ModelCatalog {
            schema_version: CATALOG_SCHEMA_VERSION,
            cli_version: "1.2.1".into(),
            fetched_at: 0,
            image: vec![ModelCatalogEntry {
                model: "seedream_5.5".into(),
                display_name: "Seedream 5.5".into(),
                aliases: vec![],
                media_type: "image".into(),
                modes: vec!["t2i".into()],
                resolutions: vec!["1.5K".into(), "2K".into()],
                aspect_ratios: vec!["1:1".into()],
                durations: vec![],
                max_count: 1,
                min_count: 1,
                fixed_count: None,
                max_references: 0,
                max_image_references: 0,
                max_video_references: 0,
                max_audio_references: 0,
                min_references: 0,
                max_prompt_length: 5000,
                supports_first_frame: false,
                vip_required: false,
            }],
            video: vec![],
            audio: vec![],
        };
        assert!(catalog_supports(&catalog, "seedream_5.5", None));
        assert!(catalog_supports(&catalog, "seedream_5.5", Some("2k")));
        assert!(!catalog_supports(&catalog, "seedream_5.5", Some("4K")));
        assert!(!catalog_supports(&catalog, "unknown_model", None));
    }

    /// 实机联调：真的问一次 CLI。`cargo test --lib -- --ignored live_`
    /// 需要本机已安装并登录 `dreamina-canvas`；无网络/未登录时跳过即可。
    #[test]
    #[ignore = "需要本机已登录即梦画布 CLI"]
    fn live_fetch_catalog() {
        let catalog = fetch_catalog("dreamina-canvas").expect("拉取模型目录失败");
        println!(
            "cli={} 图片={} 视频={} 音频={}",
            catalog.cli_version,
            catalog.image.len(),
            catalog.video.len(),
            catalog.audio.len()
        );
        for entry in catalog.image.iter().take(3) {
            println!(
                "  {} / {} / 档位={:?} / 画幅={} / 参考上限={}",
                entry.model,
                entry.display_name,
                entry.resolutions,
                entry.aspect_ratios.len(),
                entry.max_references
            );
        }
        assert!(
            catalog.image.iter().any(|entry| entry.model == "seedream_5.5"),
            "清单里应当有 seedream_5.5"
        );
    }

    /// 实机联调：真实建探针节点报价再删除。会推高「LenTalk-价格探针」草稿版本号，不扣积分。
    #[test]
    #[ignore = "会在即梦账号里建临时节点（报价免费），需要登录态"]
    fn live_probe_prices() {
        let requests = vec![
            PriceProbeRequest {
                model: "seedream_5.5".into(),
                media_type: "image".into(),
                resolution: "1.5K".into(),
                duration: None,
            },
            PriceProbeRequest {
                model: "seedance_2.5".into(),
                media_type: "video".into(),
                resolution: "720p".into(),
                duration: Some(4),
            },
        ];
        let report = probe_prices("dreamina-canvas", &requests, None).expect("报价失败");
        for quote in &report.quotes {
            println!(
                "{} @ {} → 总 {} / {} 单位 = 单位 {:.1}",
                quote.model, quote.resolution, quote.credits, quote.units, quote.unit_credits
            );
        }
        assert_eq!(report.quotes.len(), 2, "两条都应拿到价格: {:?}", report.failures);
        // 与人工实测表对齐：5.5@1.5K = 4 分/张，seedance2.5@720p = 20 分/秒
        let image = &report.quotes[0];
        assert_eq!(image.unit_credits, 4.0);
        let video = &report.quotes[1];
        assert!((video.unit_credits - 20.0).abs() < 0.5);
    }
}

// ── 旧 CLI（`dreamina`）的模型清单 ──────────────────────────────────────────
//
// `dreamina` 没有 `model list` 子命令，模型只写在各 generator 的 `-h` 说明里：
//
// ```text
// Supported combinations:
// - model_version: 3.0, 3.1, 4.0, 4.1, 4.5, 4.6, 4.7, 5.0, 5.0Pro
// - 3.0/3.1 -> resolution_type 1k or 2k
// - 4.0/4.1/4.5/4.6/4.7/5.0 -> resolution_type 2k or 4k
// - 5.0Pro -> resolution_type 1.5k, 2k, or 4k
// ```
//
// 这段文本是 CLI 对外的**公开支持集**，比我们手抄的表可靠 —— 它就是 `--model_version`
// 的校验来源。解析失败时前端回退内置表，所以这里宁可返回空也不要猜。
//
// 价格拿不到：旧 CLI 只有 `user_credit`（查余额），没有 `node quote` 那样的免费预估，
// 所以价目继续走人工实测表。

/// 旧 CLI 的一个可生成模型（带它自己声明的档位/时长）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyCliModel {
    pub version: String,
    pub resolutions: Vec<String>,
    pub min_duration: Option<u32>,
    pub max_duration: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyCliCatalog {
    pub cli_version: String,
    /// 抓取时间（秒）。老缓存没有这个字段，读出来是 0 → 视为已过期，重新抓一次。
    #[serde(default)]
    pub fetched_at: i64,
    pub image: Vec<LegacyCliModel>,
    pub video: Vec<LegacyCliModel>,
}

/// 取 `key:` 之后那一行的所有逗号分隔项（`- model_version: a, b, c`）。
fn models_after_label(text: &str, label: &str) -> Vec<String> {
    for line in text.lines() {
        let trimmed = line.trim_start_matches(['-', ' ']).trim();
        if let Some(rest) = trimmed.strip_prefix(label) {
            return rest
                .trim_start_matches(':')
                .split(',')
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect();
        }
    }
    Vec::new()
}

/// 从一行里挑出「数字 + 单位」的分辨率 token，如 `1k` / `1.5k` / `1080p` / `4k`。
///
/// 图片与视频的单位不统一：图片是 `1k/2k/4k`，视频主力是 `720p/1080p` 但 4K 档又写成
/// `4k`（不是 2160p）。所以这里不按单位过滤，只要求「数字 + p/k」并且去重保序。
/// 同时只取分号之前的片段：`... 1k or 2k; custom width/height requires resolution_type 2k`
/// 后半句是提示而不是档位，不截断会把 `2k` 收两遍。
fn resolution_tokens(text: &str) -> Vec<String> {
    let head = text.split(';').next().unwrap_or(text);
    let mut values: Vec<String> = Vec::new();
    for token in head.split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '.')) {
        let lower = token.to_ascii_lowercase();
        let Some(unit) = lower.chars().last() else {
            continue;
        };
        if unit != 'k' && unit != 'p' {
            continue;
        }
        let number = &lower[..lower.len() - 1];
        if number.is_empty()
            || !number
                .chars()
                .all(|ch| ch.is_ascii_digit() || ch == '.')
        {
            continue;
        }
        if !values.iter().any(|existing| existing == &lower) {
            values.push(lower);
        }
    }
    values
}

/// `duration 4-30s` → (4, 30)
fn duration_range(text: &str) -> (Option<u32>, Option<u32>) {
    let Some(index) = text.find("duration") else {
        return (None, None);
    };
    let tail: String = text[index + "duration".len()..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '-' || *ch == ' ' || *ch == 's')
        .collect();
    let mut parts = tail.trim().split('-');
    let min = parts.next().and_then(|value| value.trim().parse::<u32>().ok());
    let max = parts.next().and_then(|value| value.trim().trim_end_matches('s').parse::<u32>().ok());
    (min, max)
}

fn split_versions(left: &str) -> Vec<String> {
    left.trim_start_matches('-')
        .split(['/', ','])
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

/// 解析 `text2image -h`：版本列表 + 每个版本的档位。
fn parse_legacy_image_help(text: &str) -> Vec<LegacyCliModel> {
    let versions = models_after_label(text, "model_version");
    if versions.is_empty() {
        return Vec::new();
    }

    let mut assigned: Vec<(Vec<String>, Vec<String>)> = Vec::new();
    for line in text.lines() {
        let Some((left, right)) = line.split_once("->") else {
            continue;
        };
        if !right.contains("resolution_type") {
            continue;
        }
        let tiers = resolution_tokens(right);
        if tiers.is_empty() {
            continue;
        }
        let left_versions = split_versions(left);
        if !left_versions.is_empty() {
            assigned.push((left_versions, tiers));
        }
    }

    versions
        .into_iter()
        .map(|version| {
            let resolutions = assigned
                .iter()
                .find(|(group, _)| group.iter().any(|item| item == &version))
                .map(|(_, tiers)| tiers.clone())
                .unwrap_or_default();
            LegacyCliModel {
                version,
                resolutions,
                min_duration: None,
                max_duration: None,
            }
        })
        .collect()
}

/// 解析 `text2video -h`：版本列表 + 分辨率 + 时长区间。
///
/// 文本里有 `all other models -> ...` 这种兜底行，要留到最后填给没被单独列出的版本。
fn parse_legacy_video_help(text: &str) -> Vec<LegacyCliModel> {
    let versions = models_after_label(text, "model_version");
    if versions.is_empty() {
        return Vec::new();
    }

    let mut by_version: Vec<(Vec<String>, Vec<String>, Option<u32>, Option<u32>)> = Vec::new();
    let mut fallback: Option<(Vec<String>, Option<u32>, Option<u32>)> = None;

    for line in text.lines() {
        let Some((left, right)) = line.split_once("->") else {
            continue;
        };
        if !right.contains("video_resolution") {
            continue;
        }
        let resolutions = resolution_tokens(right);
        let (min, max) = duration_range(right);
        if left.contains("all other models") {
            fallback = Some((resolutions, min, max));
            continue;
        }
        let left_versions = split_versions(left);
        if !left_versions.is_empty() {
            by_version.push((left_versions, resolutions, min, max));
        }
    }

    versions
        .into_iter()
        .map(|version| {
            if let Some((_, resolutions, min, max)) = by_version
                .iter()
                .find(|(group, _, _, _)| group.iter().any(|item| item == &version))
            {
                return LegacyCliModel {
                    version,
                    resolutions: resolutions.clone(),
                    min_duration: *min,
                    max_duration: *max,
                };
            }
            let (resolutions, min, max) = fallback.clone().unwrap_or_default();
            LegacyCliModel {
                version,
                resolutions,
                min_duration: min,
                max_duration: max,
            }
        })
        .collect()
}

// ── 服务端权威型号清单（探针） ───────────────────────────────────────────────
//
// 旧 CLI 的 `-h` 文本是**编译期写死的**，服务端加型号时它不会跟着变：
// 实测 `dreamina 1.4.21` 的 `text2image -h` 只列到 `5.0Pro`，而服务端已经支持
// `4.8` / `5.0lite`；`text2video -h` 没有 `seedance2.5_flash`，服务端却认。
// 于是「解析 -h」这条路永远慢一拍，用户看到的就是「新模型都没有」。
//
// 好在服务端在**参数校验阶段**就把可用值原样回显：
//   invalid param:version, version should be in [3.0, 3.1, ..., 5.0lite]
// 这一句在计费之前返回（实测传不存在的型号不扣积分），所以「故意传一个不存在的
// 型号」就是最便宜的型号同步方式 —— 也顺带告诉我们哪些型号已经被服务端摘掉了。

/// 探测用的假型号 / 假档位。绝不可能是真实值，保证请求停在参数校验阶段。
const PROBE_SENTINEL: &str = "__lentalk_probe__";
/// 单次探测超时。CLI 启动时会做一次联网检查（本机实测无代理时 `version` / `-h`
/// 都要 18 秒才返回），所以这里必须比「本地命令」的直觉宽松很多。
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);
/// `version` / `-h` 这类元信息读取的超时，理由同上（曾经用 15 秒，在这台机器上
/// 每次都被判超时 → 旧 CLI 的型号解析长期静默失败，用户看到的就是「新模型都没有」）。
const LEGACY_META_TIMEOUT: Duration = Duration::from_secs(60);
/// 单次刷新最多为多少个「help 里没有、服务端有」的新型号补档位（每个 1~2 次调用）。
/// 型号一次最多新增两三个，留 6 个余量足够，也避免极端情况让刷新卡住。
const PROBE_EXTRA_LIMIT: usize = 6;

#[derive(Clone, Copy, PartialEq, Eq)]
enum LegacyMedia {
    Image,
    Video,
}

impl LegacyMedia {
    fn command(self) -> &'static str {
        match self {
            LegacyMedia::Image => "text2image",
            LegacyMedia::Video => "text2video",
        }
    }
}

fn run_legacy_probe(executable: &str, arguments: Vec<String>) -> Option<String> {
    let (_, raw) = try_spawn_cli_capture(executable, &arguments, PROBE_TIMEOUT, &[]).ok()?;
    Some(raw)
}

/// 取 `marker` 之后方括号里的列表：`... version should be in [a, b, c], logid=...`
fn bracketed_list(text: &str, marker: &str) -> Vec<String> {
    let Some(start) = text.find(marker) else {
        return Vec::new();
    };
    let tail = &text[start + marker.len()..];
    let body = tail.split(']').next().unwrap_or(tail);
    body.split(',')
        .map(|item| item.trim().trim_matches(['"', '\'']).trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

/// 服务端当前支持的型号清单；探测失败（没登录 / 断网 / CLI 太老）返回空。
fn probe_versions(executable: &str, media: LegacyMedia) -> Vec<String> {
    let mut arguments = vec![
        media.command().to_string(),
        "--prompt=__lentalk_probe__".to_string(),
        format!("--model_version={PROBE_SENTINEL}"),
    ];
    match media {
        LegacyMedia::Image => {
            arguments.push("--resolution_type=2k".to_string());
            arguments.push("--generate_num=1".to_string());
        }
        LegacyMedia::Video => {
            arguments.push("--video_resolution=720p".to_string());
            arguments.push("--duration=5".to_string());
        }
    }
    let Some(raw) = run_legacy_probe(executable, arguments) else {
        return Vec::new();
    };
    bracketed_list(&raw, "version should be in [")
}

/// 某个图片型号实际支持的档位（`resolution_type should be in [2k, 4k]`）。
fn probe_image_resolutions(executable: &str, version: &str) -> Vec<String> {
    let arguments = vec![
        "text2image".to_string(),
        "--prompt=__lentalk_probe__".to_string(),
        format!("--model_version={version}"),
        format!("--resolution_type={PROBE_SENTINEL}"),
        "--generate_num=1".to_string(),
    ];
    let Some(raw) = run_legacy_probe(executable, arguments) else {
        return Vec::new();
    };
    let tiers = bracketed_list(&raw, "resolution_type should be in [");
    if !tiers.is_empty() {
        return tiers;
    }
    resolution_tokens(&raw)
}

/// 某个视频型号实际支持的档位。CLI 自己会先拦（`video_resolution must be one of ...`），
/// 拦不住时由服务端回 `video_resolution should be in [...]`，两种都认。
fn probe_video_resolutions(executable: &str, version: &str) -> Vec<String> {
    let arguments = vec![
        "text2video".to_string(),
        "--prompt=__lentalk_probe__".to_string(),
        format!("--model_version={version}"),
        format!("--video_resolution={PROBE_SENTINEL}"),
        "--duration=5".to_string(),
    ];
    let Some(raw) = run_legacy_probe(executable, arguments) else {
        return Vec::new();
    };
    let tiers = bracketed_list(&raw, "video_resolution should be in [");
    if !tiers.is_empty() {
        return tiers;
    }
    // CLI 侧文案：`video_resolution must be one of 720p, 1080p, 4k`
    let Some(index) = raw.find("video_resolution must be one of") else {
        return Vec::new();
    };
    resolution_tokens(&raw[index..])
}

/// 从 `duration should >=4 && <=30` / `duration must be between 4 and 30` 里取上下限。
///
/// 只认 `duration` 之后的前两个数字：日志尾巴里的 logid、提交时间都是数字，
/// 不截断会把它们当成上限。
fn duration_bounds(text: &str) -> Option<(u32, u32)> {
    let start = text
        .find("duration should")
        .or_else(|| text.find("duration must"))?;
    let tail: String = text[start..].chars().take(80).collect();
    let numbers: Vec<u32> = tail
        .split(|ch: char| !ch.is_ascii_digit())
        .filter(|item| !item.is_empty())
        .filter_map(|item| item.parse::<u32>().ok())
        .collect();
    let min = *numbers.first()?;
    let max = *numbers.get(1)?;
    if min == 0 || max < min || max > 600 {
        return None;
    }
    Some((min, max))
}

/// 某个视频型号的时长区间。故意传 `--duration=1`（低于任何型号的下限）：
/// 万一服务端没校验，代价也只有 1 秒的积分，而不是 999 秒。
fn probe_video_duration(executable: &str, version: &str, resolution: &str) -> Option<(u32, u32)> {
    let arguments = vec![
        "text2video".to_string(),
        "--prompt=__lentalk_probe__".to_string(),
        format!("--model_version={version}"),
        format!("--video_resolution={resolution}"),
        "--duration=1".to_string(),
    ];
    let raw = run_legacy_probe(executable, arguments)?;
    duration_bounds(&raw)
}

/// 把 `-h` 解析出来的结果与服务端权威清单合并。
///
/// - 顺序按**服务端**清单 —— 它才是「现在能用什么」的答案；
/// - 档位/时长优先用 `-h` 已经写清楚的值（零成本），只有 help 里没有的新型号才探针补齐；
/// - 服务端有、help 没有 → 追加；help 有、服务端没有 → 丢掉（型号已下线）。
/// - 探测失败（空清单）时原样返回 help 结果，绝不因为一次网络抖动把型号列表清空。
fn merge_legacy_models(
    executable: &str,
    media: LegacyMedia,
    help_models: Vec<LegacyCliModel>,
) -> Vec<LegacyCliModel> {
    let probed = probe_versions(executable, media);
    if probed.is_empty() {
        return help_models;
    }

    let mut merged: Vec<LegacyCliModel> = Vec::with_capacity(probed.len());
    let mut probed_extras = 0usize;
    for version in probed {
        if let Some(existing) = help_models.iter().find(|item| item.version == version) {
            let mut model = existing.clone();
            if model.resolutions.is_empty() {
                model.resolutions = match media {
                    LegacyMedia::Image => probe_image_resolutions(executable, &version),
                    LegacyMedia::Video => probe_video_resolutions(executable, &version),
                };
            }
            merged.push(model);
            continue;
        }
        if probed_extras >= PROBE_EXTRA_LIMIT {
            continue;
        }
        probed_extras += 1;
        let resolutions = match media {
            LegacyMedia::Image => probe_image_resolutions(executable, &version),
            LegacyMedia::Video => probe_video_resolutions(executable, &version),
        };
        let (min_duration, max_duration) = if media == LegacyMedia::Video {
            match resolutions.first() {
                Some(resolution) => match probe_video_duration(executable, &version, resolution) {
                    Some((min, max)) => (Some(min), Some(max)),
                    None => (None, None),
                },
                None => (None, None),
            }
        } else {
            (None, None)
        };
        merged.push(LegacyCliModel {
            version,
            resolutions,
            min_duration,
            max_duration,
        });
    }

    // 服务端清单为空才保留的兜底已经在上面 return 掉了；到这里 help 里多出来的型号
    // 就是对端已经摘掉的旧型号，不再让它出现在下拉里。
    merged
}

/// 读一次 CLI 版本（`dreamina version` → 纯 JSON）。
///
/// 单独抽出来是因为它单独一次进程启动就要十几秒（CLI 启动时会联网检查更新，
/// 本机实测无代理 18 秒），所以只在**用户手动刷新**时重新读，自动同步沿用缓存值。
fn read_legacy_cli_version(executable: &str) -> String {
    let Ok((_, raw)) = try_spawn_cli_capture(
        executable,
        &["version".to_string()],
        LEGACY_META_TIMEOUT,
        &[],
    ) else {
        return String::new();
    };
    serde_json::from_str::<serde_json::Value>(raw.trim())
        .ok()
        .and_then(|value| {
            value
                .get("version")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
}

/// `cli_version_hint` 有值就跳过 `version` 调用 —— 每次调用都是十几秒的进程启动。
fn fetch_legacy_catalog(
    executable: &str,
    cli_version_hint: Option<&str>,
) -> Result<LegacyCliCatalog, String> {
    let cli_version = match cli_version_hint {
        Some(version) if !version.trim().is_empty() => version.trim().to_string(),
        _ => read_legacy_cli_version(executable),
    };

    let help = |command: &str| -> Result<String, String> {
        let (success, raw) = try_spawn_cli_capture(
            executable,
            &[command.to_string(), "-h".to_string()],
            LEGACY_META_TIMEOUT,
            &[],
        )?;
        // `-h` 正常退出码是 0；个别 CLI 版本会以 1 退出但仍打印全文，所以这里只要**有内容**就收。
        if raw.trim().is_empty() {
            return Err(format!("{command} -h 没有输出: {}", if success { "" } else { "命令失败" }));
        }
        Ok(raw)
    };

    // 顺序不能乱：`-h` 先给「已知档位」（零成本），探针再补「help 还没写」的型号。
    // 两次 merge 共用一个 CLI 进程锁，所以是一次一次跑的；因此下面刻意省掉了
    // 每次刷新都能省则省的调用（见 `cli_version_hint`）。
    let image = merge_legacy_models(
        executable,
        LegacyMedia::Image,
        parse_legacy_image_help(&help("text2image")?),
    );
    let video = merge_legacy_models(
        executable,
        LegacyMedia::Video,
        parse_legacy_video_help(&help("text2video")?),
    );

    Ok(LegacyCliCatalog {
        cli_version,
        fetched_at: now_secs(),
        image,
        video,
    })
}

fn read_cached_legacy(app: &AppHandle) -> Option<LegacyCliCatalog> {
    let conn = database::open(app).ok()?;
    let raw = database::get_setting(&conn, LEGACY_SETTING_KEY).ok()??;
    let catalog = serde_json::from_str::<LegacyCliCatalog>(&raw).ok()?;
    if catalog.image.is_empty() && catalog.video.is_empty() {
        return None;
    }
    remember_legacy_snapshot(&catalog);
    Some(catalog)
}

fn write_cached_legacy(app: &AppHandle, catalog: &LegacyCliCatalog) -> Result<(), String> {
    let conn = database::open(app)?;
    let serialized = serde_json::to_string(catalog)
        .map_err(|error| format!("序列化即梦 CLI 模型清单失败: {error}"))?;
    database::put_setting(&conn, LEGACY_SETTING_KEY, &serialized)
}

/// 进程内快照：生成链路（`jimeng_cli.rs` 的参数校验）要用它放行新型号，
/// 但那边拿不到 `AppHandle` 之外的上下文，所以这里留一份最近一次的结果。
fn legacy_snapshot_cell() -> &'static RwLock<Option<LegacyCliCatalog>> {
    static CELL: OnceLock<RwLock<Option<LegacyCliCatalog>>> = OnceLock::new();
    CELL.get_or_init(|| RwLock::new(None))
}

fn remember_legacy_snapshot(catalog: &LegacyCliCatalog) {
    if let Ok(mut guard) = legacy_snapshot_cell().write() {
        *guard = Some(catalog.clone());
    }
}

/// 按型号查进程内快照里的声明（大小写不敏感）。
pub(crate) fn legacy_snapshot_model(model: &str) -> Option<LegacyCliModel> {
    let guard = legacy_snapshot_cell().read().ok()?;
    let catalog = guard.as_ref()?;
    catalog
        .image
        .iter()
        .chain(catalog.video.iter())
        .find(|item| item.version.eq_ignore_ascii_case(model))
        .cloned()
}

/// 读取缓存里的旧 CLI 清单（不做网络探测，供生成链路校验用）。
pub fn load_cached_legacy_catalog(app: &AppHandle) -> Option<LegacyCliCatalog> {
    read_cached_legacy(app)
}

/// 读取旧 CLI（`dreamina`）的模型清单。
///
/// `-h` 文本只是起点，真正权威的是服务端回显的型号清单（见 {@link probe_versions}），
/// 合并后的结果缓存 24 小时 —— 每次刷新都会提交一两次**必然失败**的探测请求，
/// 虽然不扣积分，也没必要每次启动都跑。
#[tauri::command]
pub async fn jimeng_cli_model_catalog(
    app: AppHandle,
    executable: String,
    force_refresh: Option<bool>,
) -> Result<LegacyCliCatalog, String> {
    let executable = executable.trim().to_string();
    if executable.is_empty() {
        return Err("请先填写即梦 CLI 的可执行命令".to_string());
    }
    let force = force_refresh.unwrap_or(false);
    let cached = read_cached_legacy(&app);
    if !force {
        if let Some(fresh) = cached.as_ref().filter(|item| now_secs() - item.fetched_at < CATALOG_TTL_SECS) {
            return Ok(fresh.clone());
        }
    }
    // 自动同步沿用缓存里的 CLI 版本号：`version` 也是一次十几秒的进程启动，
    // 而版本号只用于界面展示。用户手动刷新时才重新读一次。
    let version_hint = if force {
        None
    } else {
        cached.as_ref().map(|item| item.cli_version.clone())
    };
    let app_for_task = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        fetch_legacy_catalog(&executable, version_hint.as_deref())
    })
    .await
    .map_err(|error| format!("即梦 CLI 模型清单任务中断: {error}"))?;
    match result {
        Ok(catalog) => {
            remember_legacy_snapshot(&catalog);
            // 缓存写失败不该挡住「已经拿到的清单」。
            let _ = write_cached_legacy(&app_for_task, &catalog);
            Ok(catalog)
        }
        Err(error) => read_cached_legacy(&app_for_task).ok_or(error),
    }
}

#[cfg(test)]
mod legacy_tests {
    use super::*;

    /// 真实输出（`dreamina 1.4.21 text2image -h`），只保留 Supported combinations 段。
    const IMAGE_HELP: &str = r#"Usage:
  dreamina text2image [flags]

Supported combinations:
- model_version: 3.0, 3.1, 4.0, 4.1, 4.5, 4.6, 4.7, 5.0, 5.0Pro
- ratio: 21:9, 16:9, 3:2, 4:3, 1:1, 3:4, 2:3, 9:16
- generate_num: 1-10
- 3.0/3.1 -> resolution_type 1k or 2k; custom width/height requires resolution_type 2k
- 4.0/4.1/4.5/4.6/4.7/5.0 -> resolution_type 2k or 4k
- 5.0Pro -> resolution_type 1.5k, 2k, or 4k
"#;

    /// 真实输出（`dreamina 1.4.21 text2video -h`）。
    const VIDEO_HELP: &str = r#"Usage:
  dreamina text2video [flags]

Supported combinations:
- model_version: seedance2.0, seedance2.0fast, seedance2.0_vip, seedance2.0fast_vip, seedance2.0mini, seedance2.5
- ratio: 1:1, 3:4, 16:9, 4:3, 9:16, 21:9
- seedance2.5 -> video_resolution 480p, 720p, or 1080p; duration 4-30s; VIP-only
- seedance2.0_vip -> video_resolution 720p, 1080p, or 4k; duration 4-15s
- all other models -> video_resolution 720p; duration 4-15s
"#;

    #[test]
    fn parses_legacy_image_versions_and_tiers() {
        let models = parse_legacy_image_help(IMAGE_HELP);
        assert_eq!(models.len(), 9);
        assert_eq!(
            models.iter().map(|item| item.version.as_str()).collect::<Vec<_>>(),
            vec!["3.0", "3.1", "4.0", "4.1", "4.5", "4.6", "4.7", "5.0", "5.0Pro"]
        );
        let tiers = |version: &str| {
            models
                .iter()
                .find(|item| item.version == version)
                .map(|item| item.resolutions.clone())
                .unwrap()
        };
        assert_eq!(tiers("3.0"), vec!["1k", "2k"]);
        assert_eq!(tiers("4.7"), vec!["2k", "4k"]);
        assert_eq!(tiers("5.0Pro"), vec!["1.5k", "2k", "4k"]);
    }

    #[test]
    fn parses_legacy_video_fallback_row() {
        let models = parse_legacy_video_help(VIDEO_HELP);
        assert_eq!(models.len(), 6);

        let seedance25 = models
            .iter()
            .find(|item| item.version == "seedance2.5")
            .expect("seedance2.5");
        assert_eq!(seedance25.resolutions, vec!["480p", "720p", "1080p"]);
        assert_eq!(seedance25.min_duration, Some(4));
        assert_eq!(seedance25.max_duration, Some(30));

        let vip = models
            .iter()
            .find(|item| item.version == "seedance2.0_vip")
            .expect("vip");
        assert_eq!(vip.resolutions, vec!["720p", "1080p", "4k"]);
        assert_eq!(vip.max_duration, Some(15));

        // 「all other models」必须兜到没被单独列出的版本上
        let fast = models
            .iter()
            .find(|item| item.version == "seedance2.0fast")
            .expect("fast");
        assert_eq!(fast.resolutions, vec!["720p"]);
        assert_eq!(fast.min_duration, Some(4));
        assert_eq!(fast.max_duration, Some(15));
    }

    #[test]
    fn unparsable_help_yields_empty_instead_of_garbage() {
        assert!(parse_legacy_image_help("完全无关的文本").is_empty());
        assert!(parse_legacy_video_help("").is_empty());
        // 有版本行但没有档位行：版本保留、档位为空（前端据此回退内置表）
        let models = parse_legacy_image_help("- model_version: 9.0, 9.1\n");
        assert_eq!(models.len(), 2);
        assert!(models[0].resolutions.is_empty());
    }

    /// 服务端回显（`dreamina 1.4.21` 实测，故意传 9.9 触发）—— 比 `-h` 多了 4.8 / 5.0lite。
    const SERVER_VERSION_ERROR: &str = r#"{
  "submit_id": "202cba61-2006-4d73-94f1-a1c9e66f69ac",
  "logid": "20261116110648192168003024387CDD1",
  "gen_status": "fail",
  "fail_reason": "api error: ret=10001, message=invalid param:version, version should be in [3.0, 3.1, 4.0, 4.1, 4.5, 4.6, 4.7, 4.8, 5.0, 5.0Pro, 5.0lite], logid=20261116110648192168003024387CDD1"
}"#;

    #[test]
    fn reads_server_version_whitelist() {
        assert_eq!(
            bracketed_list(SERVER_VERSION_ERROR, "version should be in ["),
            vec![
                "3.0", "3.1", "4.0", "4.1", "4.5", "4.6", "4.7", "4.8", "5.0", "5.0Pro",
                "5.0lite"
            ]
        );
        // 没有该标记（旧 CLI / 未登录 / 断网）→ 空, 调用方退回 `-h` 的结果
        assert!(bracketed_list("完全无关的文本", "version should be in [").is_empty());
        assert!(bracketed_list("{}", "version should be in [").is_empty());
    }

    #[test]
    fn reads_video_and_image_resolution_whitelists() {
        assert_eq!(
            bracketed_list(
                "invalid param:resolution_type, resolution_type should be in [2k, 4k], logid=1",
                "resolution_type should be in ["
            ),
            vec!["2k", "4k"]
        );
        // CLI 侧文案（`text2video` 会先在本地拦下）没有方括号
        assert_eq!(
            resolution_tokens("video_resolution must be one of 720p, 1080p, 4k"),
            vec!["720p", "1080p", "4k"]
        );
    }

    #[test]
    fn reads_duration_bounds_from_probe_errors() {
        // 服务端（seedance2.5_flash 实测）
        assert_eq!(
            duration_bounds(
                "api error: ret=10001, message=invalid param:duration, duration should >=4 && <=30, logid=202611161109271921680030244193FB7"
            ),
            Some((4, 30))
        );
        // CLI 侧另一种写法
        assert_eq!(
            duration_bounds("duration must be between 4 and 15 seconds for this model"),
            Some((4, 15))
        );
        // 别把 logid 里的数字当上限
        assert_eq!(duration_bounds("submit_id 1234 failed"), None);
        assert_eq!(duration_bounds("duration should >=4"), None);
    }

    #[test]
    fn merge_keeps_help_order_when_probe_fails() {
        // 探针失败（`executable` 不存在 → 空清单）时必须原样返回 help 结果,
        // 绝不能因为一次网络抖动把型号列表清空。
        let help = parse_legacy_image_help(IMAGE_HELP);
        let merged = merge_legacy_models("/nonexistent/lentalk-probe", LegacyMedia::Image, help.clone());
        assert_eq!(merged, help);
    }

    /// 真机自检：`-h` 文本落后于服务端时, 合并结果必须把新型号补进来。
    /// 需要本机已登录即梦 CLI（探测请求不扣积分）。
    #[test]
    #[ignore = "需要本机已登录即梦 CLI（探测请求不扣积分）"]
    fn live_legacy_catalog_includes_server_only_models() {
        let catalog = fetch_legacy_catalog("dreamina", None).expect("读取旧 CLI 清单");
        let versions: Vec<&str> = catalog.image.iter().map(|m| m.version.as_str()).collect();
        assert!(versions.contains(&"5.0lite"), "图片型号缺 5.0lite: {versions:?}");
        assert!(versions.contains(&"4.8"), "图片型号缺 4.8: {versions:?}");
        let lite = catalog.image.iter().find(|m| m.version == "5.0lite").unwrap();
        assert_eq!(lite.resolutions, vec!["2k", "4k"]);

        let video: Vec<&str> = catalog.video.iter().map(|m| m.version.as_str()).collect();
        assert!(
            video.contains(&"seedance2.5_flash"),
            "视频型号缺 seedance2.5_flash: {video:?}"
        );
        let flash = catalog
            .video
            .iter()
            .find(|m| m.version == "seedance2.5_flash")
            .unwrap();
        assert_eq!(flash.resolutions, vec!["720p", "1080p", "4k"]);
        assert_eq!(flash.max_duration, Some(30));
    }
}
