//! 浏览器扩展投递通道。
//!
//! 浏览器扩展运行在沙箱里：既不能调用 Tauri 的 IPC，也不能往任意目录写文件。
//! 所以由应用侧开一个**只绑本机回环地址**的极简 HTTP 服务，接收扩展抓到的媒体字节。
//!
//! 这里刻意不用 hyper / axum：需要处理的只有三个路由、没有 TLS、不需要长连接，
//! 手写解析的依赖面更小，而且大视频可以直接流式落盘，不必先读进内存。
//!
//! 安全边界（三层，缺一不可）：
//!   1. 只 bind `127.0.0.1` —— 非本机连接在 TCP 层就被拒，也不会触发系统防火墙弹窗
//!   2. 带 `Origin` 的请求必须来自浏览器扩展；网页发起的请求一律 403，且不回 CORS 头
//!   3. 只认三个固定路由，落盘文件名由服务端生成，绝不用请求里的字符串拼路径

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};
use uuid::Uuid;

use crate::commands::asset_library::{
    default_state, extract_video_thumbnail, normalize_state, safe_extension,
    AssetLibraryStateRecord, LibraryAssetRecord, ASSET_LIBRARY_SETTING_KEY,
};
use crate::commands::video_cfr::resolve_ffmpeg_path;
use crate::database;

/// 素材库被扩展投递进来后，前端监听这个事件把新记录合并进内存态。
pub const MEDIA_BRIDGE_EVENT: &str = "media-bridge://assets";

/// 端口扫描区间：默认端口被别的程序占用时依次向后试。
const PORT_SCAN_START: u16 = 17890;
const PORT_SCAN_END: u16 = 17899;

const HEADER_LIMIT_BYTES: usize = 16 * 1024;
/// 单个素材体积上限（4 GiB）。扩展侧已经会拦一次，这里是服务端兜底。
const BODY_LIMIT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(60);
const COPY_BUFFER_BYTES: usize = 64 * 1024;

/// HLS 下载的时限：超过就杀掉 ffmpeg，免得一个永不结束的流把线程一直占着。
const HLS_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// `POST /hls` 的请求体上限 —— 只是一段 JSON，用不着大。
const HLS_BODY_LIMIT_BYTES: u64 = 64 * 1024;
/// 拉流用的 UA：不少 CDN 会拒掉没有 UA 的请求。
const HLS_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

static ACTIVE_PORT: AtomicU16 = AtomicU16::new(0);

/// 当前实际监听的端口；0 表示没起来。
pub fn active_port() -> u16 {
    ACTIVE_PORT.load(Ordering::Relaxed)
}

/// 在回环地址上起服务，返回实际选中的端口。失败不阻塞应用启动，由调用方决定是否记日志。
pub fn start(app: AppHandle) -> Result<u16, String> {
    for port in PORT_SCAN_START..=PORT_SCAN_END {
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
        let Ok(listener) = TcpListener::bind(address) else {
            continue;
        };
        ACTIVE_PORT.store(port, Ordering::Relaxed);
        std::thread::Builder::new()
            .name("media-bridge".to_string())
            .spawn(move || serve(app, listener))
            .map_err(|error| format!("Failed to spawn media bridge thread: {error}"))?;
        return Ok(port);
    }
    Err(format!(
        "No free loopback port in {PORT_SCAN_START}-{PORT_SCAN_END} for the media bridge"
    ))
}

fn serve(app: AppHandle, listener: TcpListener) {
    for incoming in listener.incoming() {
        let Ok(stream) = incoming else {
            continue;
        };
        let app = app.clone();
        // 每个连接一个线程：上传大视频时不会被其它请求堵住。
        std::thread::spawn(move || {
            if let Err(error) = handle_connection(&app, stream) {
                warn!("[media-bridge] request failed: {error}");
            }
        });
    }
}

fn handle_connection(app: &AppHandle, stream: TcpStream) -> Result<(), String> {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));

    let mut writer = stream.try_clone().map_err(|error| format!("Clone stream failed: {error}"))?;
    let mut reader = BufReader::new(stream);

    let request_line = read_line(&mut reader)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_ascii_uppercase();
    let target = parts.next().unwrap_or_default().to_string();
    if method.is_empty() || target.is_empty() {
        return respond_json(&mut writer, 400, &error_body("请求格式无法识别"), None);
    }

    let mut header_bytes = request_line.len();
    let mut headers: Vec<String> = Vec::new();
    loop {
        let line = read_line(&mut reader)?;
        header_bytes += line.len();
        if header_bytes > HEADER_LIMIT_BYTES {
            return respond_json(&mut writer, 431, &error_body("请求头过大"), None);
        }
        if line.is_empty() {
            break;
        }
        headers.push(line);
    }

    let origin = header_value(&headers, "origin");
    // 浏览器一定会在跨域请求上带 Origin。带了就必须是扩展来源；
    // 不带 Origin 的是本机进程 / 命令行，属于本地信任范围。
    if let Some(value) = origin.as_deref() {
        if !is_extension_origin(value) {
            return respond_json(
                &mut writer,
                403,
                &error_body("只接受浏览器扩展发起的请求"),
                None,
            );
        }
    }
    let cors = origin.as_deref();

    if method == "OPTIONS" {
        return respond_empty(&mut writer, 204, cors);
    }

    let (path, query) = split_target(&target);
    match (method.as_str(), path.as_str()) {
        ("GET", "/ping") => respond_json(
            &mut writer,
            200,
            &json!({
                "ok": true,
                "app": "LenTalk",
                "version": env!("CARGO_PKG_VERSION"),
                "port": active_port(),
            }),
            cors,
        ),
        ("GET", "/library") => match library_snapshot(app) {
            Ok(body) => respond_json(&mut writer, 200, &body, cors),
            Err(error) => respond_json(&mut writer, 500, &error_body(&error), cors),
        },
        ("POST", "/assets") => {
            let content_length = header_value(&headers, "content-length")
                .and_then(|value| value.trim().parse::<u64>().ok());
            let chunked = header_value(&headers, "transfer-encoding")
                .map(|value| value.to_ascii_lowercase().contains("chunked"))
                .unwrap_or(false);

            // 扩展侧做流式转发时**设不了 Content-Length**（浏览器禁止前端写这个头），
            // 请求体只会是 chunked。两种长度信息都没有才是真的读不出来。
            let body = if let Some(length) = content_length {
                if length == 0 || length > BODY_LIMIT_BYTES {
                    return respond_json(
                        &mut writer,
                        413,
                        &error_body("素材体积超出允许范围"),
                        cors,
                    );
                }
                BodySpec::Exact(length)
            } else if chunked {
                BodySpec::Chunked
            } else {
                return respond_json(&mut writer, 411, &error_body("缺少 Content-Length"), cors);
            };

            let request = ImportRequest::from_query(&query);
            match import_asset(app, &request, &mut reader, body) {
                Ok(body) => respond_json(&mut writer, 200, &body, cors),
                Err(error) => respond_json(&mut writer, 400, &error_body(&error), cors),
            }
        }
        // HLS(m3u8) 不是单个文件，字节没法像上面那样直接传过来：
        // 这里只收一段 JSON（地址 + 页面地址），由随包 ffmpeg 去拉流、合并成 mp4 再入库。
        ("POST", "/hls") => {
            let content_length = header_value(&headers, "content-length")
                .and_then(|value| value.trim().parse::<u64>().ok());
            let length = match content_length {
                Some(value) => value,
                None => {
                    return respond_json(&mut writer, 411, &error_body("缺少 Content-Length"), cors)
                }
            };
            if length == 0 || length > HLS_BODY_LIMIT_BYTES {
                return respond_json(
                    &mut writer,
                    413,
                    &error_body("HLS 请求体超出允许范围"),
                    cors,
                );
            }
            let mut raw = vec![0u8; length as usize];
            if let Err(error) = reader.read_exact(&mut raw) {
                return respond_json(
                    &mut writer,
                    400,
                    &error_body(&format!("读取请求体失败: {error}")),
                    cors,
                );
            }
            match import_hls(app, &raw) {
                Ok(body) => respond_json(&mut writer, 200, &body, cors),
                Err(error) => {
                    // 扩展那边的失败气泡只闪几秒，用户回头只看得到一句「存不了」。
                    // 真正的现场（哪个地址、带没带 Referer、ffmpeg 说了什么）留在这儿。
                    log_hls_line(app, &format!("失败 | {error}"));
                    respond_json(&mut writer, 400, &error_body(&error), cors)
                }
            }
        }
        ("GET", _) | ("POST", _) => {
            respond_json(&mut writer, 404, &error_body("未知接口"), cors)
        }
        _ => respond_json(&mut writer, 405, &error_body("不支持的方法"), cors),
    }
}

/// 请求体的长度形态：扩展整块上传时给 Content-Length，流式转发时是 chunked。
#[derive(Debug, Clone, Copy)]
enum BodySpec {
    /// 固定长度，按 Content-Length 逐段读。
    Exact(u64),
    /// 分块传输编码，逐个 chunk 解析。
    Chunked,
}

/// `POST /assets` 的查询参数。
struct ImportRequest {
    category_id: Option<String>,
    name: String,
    media_type: String,
    file_name: String,
    extension: String,
}

impl ImportRequest {
    fn from_query(query: &str) -> Self {
        let media_type = query_value(query, "mediaType").unwrap_or_else(|| "image".to_string());
        let file_name = query_value(query, "fileName").unwrap_or_default();
        let extension = query_value(query, "extension")
            .filter(|value| !value.trim().is_empty())
            .or_else(|| extension_from_name(&file_name))
            .unwrap_or_else(|| default_extension(&media_type).to_string());
        let name = query_value(query, "name")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| strip_extension(&file_name));
        Self {
            category_id: query_value(query, "categoryId").filter(|value| !value.trim().is_empty()),
            name,
            media_type: normalize_media_type(&media_type),
            file_name,
            extension,
        }
    }
}

/// 把流式上传的字节写进素材库目录，再追加一条素材记录并通知前端。
fn import_asset(
    app: &AppHandle,
    request: &ImportRequest,
    reader: &mut impl BufRead,
    body: BodySpec,
) -> Result<Value, String> {
    let directory = database::app_data_dir(app)?.join("library-assets");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("创建素材目录失败: {error}"))?;
    // 文件名一律由服务端生成，不用请求里的任何字符串拼路径。
    let destination = directory.join(format!(
        "{}.{}",
        Uuid::new_v4(),
        safe_extension(&request.extension)
    ));

    let written = match stream_to_file(reader, &destination, body) {
        Ok(written) => written,
        Err(error) => {
            let _ = fs::remove_file(&destination);
            return Err(error);
        }
    };
    if written == 0 {
        let _ = fs::remove_file(&destination);
        return Err("收到的素材内容为空".to_string());
    }

    let source_path = destination.to_string_lossy().to_string();
    register_local_asset(
        app,
        LocalAsset {
            source_path,
            name: request.name.clone(),
            media_type: request.media_type.clone(),
            file_name: request.file_name.clone(),
            category_id: request.category_id.clone(),
            bytes: written,
        },
    )
}

/// 一条**已经落在磁盘上**的素材：上传落盘与 HLS 下载两条路都汇到这里登记。
struct LocalAsset {
    source_path: String,
    name: String,
    media_type: String,
    file_name: String,
    category_id: Option<String>,
    bytes: u64,
}

/// 把磁盘上的文件登记进素材库，并通知前端刷新。
fn register_local_asset(app: &AppHandle, asset: LocalAsset) -> Result<Value, String> {
    let LocalAsset {
        source_path,
        name,
        media_type,
        file_name,
        category_id,
        bytes,
    } = asset;
    let conn = database::open(app)?;
    // 解析失败时**不能**回退到默认状态写回，否则会把用户已有的素材库整个清空。
    let mut state = match database::get_setting(&conn, ASSET_LIBRARY_SETTING_KEY)? {
        Some(value) => serde_json::from_str::<AssetLibraryStateRecord>(&value).map_err(|error| {
            format!("素材库数据无法解析，已跳过本次入库以免覆盖: {error}")
        })?,
        None => default_state(),
    };

    let library_id = if state.libraries.iter().any(|library| library.id == state.active_library_id) {
        state.active_library_id.clone()
    } else {
        state
            .libraries
            .first()
            .map(|library| library.id.clone())
            .ok_or_else(|| "素材库里没有任何库".to_string())?
    };
    // 分类可能已经被用户在应用里删掉了，落库前再确认一次，避免挂到不存在的分类下。
    let category_id = category_id.filter(|id| {
        state
            .categories
            .iter()
            .any(|category| &category.id == id && category.library_id == library_id)
    });

    // 视频补一张首帧封面，否则素材库里只有一块空白。
    let preview_image_url = if media_type == "video" {
        extract_video_thumbnail(app.clone(), source_path.clone()).unwrap_or(None)
    } else {
        None
    };

    let record = LibraryAssetRecord {
        id: format!("asset-{}", Uuid::new_v4().simple()),
        library_id,
        category_id,
        name: if name.is_empty() {
            "未命名素材".to_string()
        } else {
            name.clone()
        },
        media_type: media_type.clone(),
        source_path,
        preview_image_url,
        aspect_ratio: None,
        source_file_name: if file_name.is_empty() {
            None
        } else {
            Some(file_name.clone())
        },
        tags: Vec::new(),
        created_at: now_ms(),
        cinematic_asset_id: None,
        cinematic_kind: None,
        cinematic_description: None,
        cinematic_description_zh: None,
        cinematic_notes: None,
    };

    state.assets.push(record.clone());
    let normalized = normalize_state(state);
    let payload = serde_json::to_string(&normalized)
        .map_err(|error| format!("序列化素材库失败: {error}"))?;
    database::put_setting(&conn, ASSET_LIBRARY_SETTING_KEY, &payload)?;

    // 应用可能没开着，也可能开着但还没 hydrate；emit 失败不影响已经落库的数据。
    if let Err(error) = app.emit(MEDIA_BRIDGE_EVENT, vec![record.clone()]) {
        warn!("[media-bridge] emit failed: {error}");
    }
    info!(
        "[media-bridge] imported {} ({} bytes) into library {}",
        record.name, bytes, record.library_id
    );

    Ok(json!({
        "ok": true,
        "assetId": record.id,
        "name": record.name,
        "mediaType": record.media_type,
        "bytes": bytes,
    }))
}

/// 把请求体流式落盘，返回实际写入字节数。两种长度形态都边读边写，不整块进内存。
fn stream_to_file(
    reader: &mut impl BufRead,
    destination: &std::path::Path,
    body: BodySpec,
) -> Result<u64, String> {
    let mut file = fs::File::create(destination)
        .map_err(|error| format!("创建素材文件失败: {error}"))?;
    let written = match body {
        BodySpec::Exact(length) => copy_exact(reader, &mut file, length)?,
        BodySpec::Chunked => copy_chunked(reader, &mut file)?,
    };
    file.flush()
        .map_err(|error| format!("刷新素材文件失败: {error}"))?;
    Ok(written)
}

/// 按 Content-Length 读满指定字节数。
fn copy_exact(
    reader: &mut impl Read,
    file: &mut fs::File,
    content_length: u64,
) -> Result<u64, String> {
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    let mut remaining = content_length;
    let mut written: u64 = 0;

    while remaining > 0 {
        let chunk = remaining.min(COPY_BUFFER_BYTES as u64) as usize;
        let read = reader
            .read(&mut buffer[..chunk])
            .map_err(|error| format!("读取上传内容失败: {error}"))?;
        if read == 0 {
            // 连接提前断开：视为上传失败，调用方会删掉半截文件。
            return Err(format!(
                "上传中断：声明 {content_length} 字节，实际只收到 {written} 字节"
            ));
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("写入素材文件失败: {error}"))?;
        remaining -= read as u64;
        written += read as u64;
    }

    Ok(written)
}

/// 解析 `Transfer-Encoding: chunked` 的请求体。
///
/// 每个分块是「十六进制长度行 + 数据 + CRLF」，长度为 0 的分块表示结束，
/// 其后可能还有 trailer 头，同样以空行收尾。上限依然由 BODY_LIMIT_BYTES 兜住，
/// 因为 chunked 事先不知道总长度，只能边读边累计。
fn copy_chunked(reader: &mut impl BufRead, file: &mut fs::File) -> Result<u64, String> {
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    let mut written: u64 = 0;

    loop {
        let header = read_line(reader)?;
        // 长度行允许带分块扩展（`1a;name=value`），只取分号前的十六进制部分。
        let size_text = header.split(';').next().unwrap_or("").trim();
        let size = u64::from_str_radix(size_text, 16)
            .map_err(|_| format!("分块长度无法解析: {header}"))?;

        if size == 0 {
            // 结束块之后是 trailer，读到空行为止。
            loop {
                if read_line(reader)?.is_empty() {
                    break;
                }
            }
            return Ok(written);
        }

        written = written
            .checked_add(size)
            .ok_or_else(|| "分块长度累加溢出".to_string())?;
        if written > BODY_LIMIT_BYTES {
            return Err(format!(
                "素材体积超出允许范围（上限 {BODY_LIMIT_BYTES} 字节）"
            ));
        }

        let mut remaining = size;
        while remaining > 0 {
            let chunk = remaining.min(COPY_BUFFER_BYTES as u64) as usize;
            let read = reader
                .read(&mut buffer[..chunk])
                .map_err(|error| format!("读取上传内容失败: {error}"))?;
            if read == 0 {
                return Err(format!(
                    "上传中断：分块声明 {size} 字节，实际只收到 {} 字节",
                    size - remaining
                ));
            }
            file.write_all(&buffer[..read])
                .map_err(|error| format!("写入素材文件失败: {error}"))?;
            remaining -= read as u64;
        }

        // 数据块之后必须紧跟 CRLF（read_line 会把它剥掉，这里只校验它存在）。
        if !read_line(reader)?.is_empty() {
            return Err("分块格式不正确：数据后缺少换行".to_string());
        }
    }
}

/// `GET /library`：给扩展的下拉框准备「库 + 分类」清单。
fn library_snapshot(app: &AppHandle) -> Result<Value, String> {
    let conn = database::open(app)?;
    let state = match database::get_setting(&conn, ASSET_LIBRARY_SETTING_KEY)? {
        Some(value) => serde_json::from_str::<AssetLibraryStateRecord>(&value)
            .map_err(|error| format!("素材库数据无法解析: {error}"))?,
        None => default_state(),
    };
    let state = normalize_state(state);
    Ok(json!({
        "ok": true,
        "activeLibraryId": state.active_library_id,
        "libraries": state.libraries,
        "categories": state.categories,
    }))
}

/// `POST /hls` 的请求体：扩展只递地址，字节由应用自己去取。
#[derive(Debug, Default, serde::Deserialize)]
struct HlsImportRequest {
    #[serde(default)]
    url: String,
    /// 页面地址。既当 Referer 又用来推 Origin —— 站点挡分片主要就靠这两个头。
    #[serde(default, rename = "pageUrl")]
    page_url: String,
    #[serde(default, rename = "categoryId")]
    category_id: Option<String>,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "fileName")]
    file_name: String,
}

/// HLS（m3u8）不是单个文件，而是一张清单加一堆分片：浏览器那边没法像普通素材那样
/// 把字节整块递过来。所以这里只收地址，由随包 ffmpeg 去拉流、合并成 mp4 再入库 ——
/// 全程流式不吃内存，也不受浏览器沙箱与 CORS 的限制。
fn import_hls(app: &AppHandle, body: &[u8]) -> Result<Value, String> {
    let request: HlsImportRequest =
        serde_json::from_slice(body).map_err(|error| format!("HLS 请求体无法解析: {error}"))?;
    let url = request.url.trim();
    if !is_http_url(url) {
        return Err("只接受 http/https 的 HLS 地址".to_string());
    }

    let ffmpeg =
        resolve_ffmpeg_path(app).ok_or_else(|| "没有找到 ffmpeg，无法下载 HLS 流".to_string())?;

    // 代理要在日志里留痕：「网页能播但存不下来」几乎都是这一项造成的。
    let proxy = hls_proxy_for(url);
    log_hls_line(
        app,
        &format!(
            "请求 | url={url} | referer={} | proxy={} | name={} | fileName={}",
            if request.page_url.trim().is_empty() {
                "(空)"
            } else {
                request.page_url.trim()
            },
            proxy.as_deref().unwrap_or("(直连)"),
            request.name,
            request.file_name
        ),
    );

    // 有些站的 HLS 是「整支视频切成几十段」：清单里每个分片都指向同一个文件，
    // 只靠 `#EXT-X-BYTERANGE` 的字节区间区分。ffmpeg 的 HLS demuxer 遇到这种流会
    // 复用同一条连接，读完第一段就报 EOF —— 实测 83 秒的视频只产出 2 秒，而 HTTP
    // 层其实已经把整份 28 MB 读完了。那种文件本身就是完整的分片式 MP4，绕过
    // demuxer 直接取它，时长才对得上。
    let single_file = hls_single_file_source(url, request.page_url.trim(), proxy.as_deref());
    let input = single_file.as_deref().unwrap_or(url);
    log_hls_line(
        app,
        &format!(
            "模式 | {} | input={input}",
            if single_file.is_some() {
                "单文件切片 → 直下"
            } else {
                "清单分片 → HLS 拉流"
            }
        ),
    );

    let directory = database::app_data_dir(app)?.join("library-assets");
    fs::create_dir_all(&directory).map_err(|error| format!("创建素材目录失败: {error}"))?;
    let destination = directory.join(format!("{}.mp4", Uuid::new_v4().simple()));
    let destination_text = destination.to_string_lossy().to_string();

    if let Err(error) = download_hls(
        &ffmpeg,
        input,
        request.page_url.trim(),
        &destination_text,
        proxy.as_deref(),
    ) {
        let _ = fs::remove_file(&destination);
        return Err(error);
    }

    let bytes = fs::metadata(&destination).map(|meta| meta.len()).unwrap_or(0);
    if bytes == 0 {
        let _ = fs::remove_file(&destination);
        return Err("ffmpeg 没有产出任何内容".to_string());
    }

    let body = register_local_asset(
        app,
        LocalAsset {
            source_path: destination_text,
            name: request.name,
            media_type: "video".to_string(),
            file_name: request.file_name,
            category_id: request.category_id,
            bytes,
        },
    )?;
    log_hls_line(app, &format!("成功 | {bytes} 字节 | url={url}"));
    Ok(body)
}

/// HLS 下载的诊断轨迹，追加进应用数据目录的 `hls-download.log`，同时打到控制台。
///
/// 为什么要落文件：失败提示在扩展那边只闪 7 秒，带回来的还只是 ffmpeg stderr 的最后
/// 3 行。用户报「HLS 存不了」时，得能回头查出**当时那个地址、带没带 Referer、ffmpeg
/// 到底说了什么** —— 否则只能靠猜。
fn log_hls_line(app: &AppHandle, line: &str) {
    use std::io::Write;

    let stamped = format!("[{}] {line}\n", timestamp_text());
    eprint!("{stamped}");

    let Ok(directory) = database::app_data_dir(app) else {
        return;
    };
    let path = directory.join("hls-download.log");
    // 只关心最近的事：超过 256 KB 就重开一份，免得它悄悄长成几十兆。
    if fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) > 256 * 1024 {
        let _ = fs::remove_file(&path);
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(stamped.as_bytes());
    }
}

/// 日志时间戳（UTC）。只需要看出先后顺序，不值得为它引入时区依赖。
fn timestamp_text() -> String {
    format_utc(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
    )
}

/// 秒数 → `YYYY-MM-DD HH:MM:SSZ`。拆出来是为了能用几个已知时间点钉住它 ——
/// 手写的历法换算最容易在闰年与月末悄悄算错。
fn format_utc(total: i64) -> String {
    let days = total.div_euclid(86_400);
    let seconds = total.rem_euclid(86_400);
    // 民用历换算（纯整数运算，不依赖任何日期库）。
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = if month_part < 10 { month_part + 3 } else { month_part - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}Z",
        seconds / 3_600,
        (seconds % 3_600) / 60,
        seconds % 60
    )
}

/// 拉流合并。先按「不重编码」走 —— 绝大多数 HLS 是 h264/aac，直接重封装是秒级的；
/// 少数流的音轨是 TS 里的裸 ADTS，直接塞进 mp4 会失败，这时退回只重编音频。
fn download_hls(
    ffmpeg: &Path,
    url: &str,
    referer: &str,
    destination: &str,
    proxy: Option<&str>,
) -> Result<(), String> {
    let first = run_ffmpeg(ffmpeg, &hls_ffmpeg_args(url, referer, destination, false, proxy));
    if first.is_ok() || !Path::new(destination).exists() {
        return first;
    }
    // 失败时可能留下半截文件，删掉重来，免得第二次续写出一个坏 mp4。
    let _ = fs::remove_file(destination);
    run_ffmpeg(ffmpeg, &hls_ffmpeg_args(url, referer, destination, true, proxy))
}

/// 清单里所有分片都指向同一个文件时，返回那个文件的绝对地址。
///
/// 为什么要单独认这一种：Pinterest 这类站点把整支视频编成一个 `.cmfv`
/// （分片式 MP4），再按 `#EXT-X-BYTERANGE` 切成几十段写进清单。ffmpeg 的 HLS
/// demuxer 处理「分片同地址」会复用连接，只消费第一段就 EOF —— 实测 83 秒的
/// 视频只出来 2 秒，而 HTTP 层其实已把整份 28 MB 读完。这种流不必过 demuxer。
///
/// 只在地址看起来是清单时才动手，免得把一个大直链整个读进内存；任何一步不顺就
/// 返回 `None` 退回原来的 HLS 路径 —— 这个优化不该让本来正常的流变差。
fn hls_single_file_source(
    playlist_url: &str,
    referer: &str,
    proxy: Option<&str>,
) -> Option<String> {
    if !playlist_url.to_ascii_lowercase().contains("m3u8") {
        return None;
    }
    let mut current = playlist_url.to_string();
    // master → media 通常一跳；留三跳容忍多级嵌套。
    for _ in 0..3 {
        let text = fetch_playlist_text(&current, referer, proxy)?;
        let (variant, segments) = parse_playlist(&current, &text);
        if let Some(variant) = variant {
            current = variant;
            continue;
        }
        let mut unique: Vec<&str> = segments.iter().map(String::as_str).collect();
        unique.sort_unstable();
        unique.dedup();
        return match unique.as_slice() {
            [only] => Some((*only).to_string()),
            _ => None,
        };
    }
    None
}

/// 取清单文本。清单只有几 KB，直接读进内存。
fn fetch_playlist_text(url: &str, referer: &str, proxy: Option<&str>) -> Option<String> {
    let client = playlist_client(referer, proxy)?;
    let response = client.get(url).send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.text().ok()
}

/// 抓清单用的客户端：请求头与 ffmpeg 那边保持一致，站点看到的才是同一个身份。
/// 代理显式指定（拿不到时明确关掉），免得 reqwest 自己又去读环境变量，和
/// `hls_proxy_for` 的判断打两套架。
fn playlist_client(referer: &str, proxy: Option<&str>) -> Option<reqwest::blocking::Client> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(HLS_USER_AGENT);
    builder = match proxy {
        Some(proxy) => builder.proxy(reqwest::Proxy::all(proxy).ok()?),
        None => builder.no_proxy(),
    };
    if !referer.is_empty() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::REFERER,
            reqwest::header::HeaderValue::from_str(referer).ok()?,
        );
        let origin = origin_of(referer);
        if !origin.is_empty() {
            if let Ok(value) = reqwest::header::HeaderValue::from_str(&origin) {
                headers.insert(reqwest::header::ORIGIN, value);
            }
        }
        builder = builder.default_headers(headers);
    }
    builder.build().ok()
}

/// 解析清单：返回（子清单地址, 分片地址表）。只认判断所需的两类标签，不做完整实现。
fn parse_playlist(base_url: &str, text: &str) -> (Option<String>, Vec<String>) {
    let mut variant: Option<String> = None;
    let mut segments: Vec<String> = Vec::new();
    let mut next_is_variant = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('#') {
            next_is_variant = line.starts_with("#EXT-X-STREAM-INF");
            continue;
        }
        let absolute = resolve_url(base_url, line);
        if next_is_variant {
            // 多码率清单：第一个变体就够用，反正后面只判断分片是不是同一个文件。
            if variant.is_none() {
                variant = Some(absolute);
            }
            next_is_variant = false;
        } else {
            segments.push(absolute);
        }
    }
    (variant, segments)
}

/// 清单里的分片基本都是相对路径，得先拼成绝对地址。
fn resolve_url(base_url: &str, target: &str) -> String {
    if is_http_url(target) {
        return target.to_string();
    }
    let origin = origin_of(base_url);
    if target.starts_with('/') {
        return format!("{origin}{target}");
    }
    let path = base_url.split(['?', '#']).next().unwrap_or(base_url);
    match path.rfind('/') {
        Some(index) => format!("{}{}", &path[..=index], target),
        None => format!("{origin}/{target}"),
    }
}

/// 一笔系统代理配置：代理地址 + 不该走代理的例外表。
struct SystemProxy {
    url: String,
    exceptions: Vec<String>,
}

/// 给这次拉流定一个上游 HTTP 代理。
///
/// 为什么必须有：ffmpeg 只认 `http_proxy` 环境变量，**完全不读系统的代理设置**；而
/// 浏览器读系统代理。于是出现最难查的一类现场 —— 用户网页里视频好好的（Chrome 走了
/// Clash/V2Ray），一保存就超时（ffmpeg 直连，撞上被污染的 DNS）。国内解析
/// `v1.pinimg.com` 这类域名拿到的是失效的老 IP，直连必然超时。
fn hls_proxy_for(url: &str) -> Option<String> {
    let host = host_of(url);
    if host.is_empty() || is_private_host(&host) {
        return None;
    }
    // ① 环境变量优先：用户显式设过的应当被尊重，ffmpeg 本来也只认小写那一个。
    for key in [
        "http_proxy",
        "HTTP_PROXY",
        "https_proxy",
        "HTTPS_PROXY",
        "all_proxy",
        "ALL_PROXY",
    ] {
        if let Ok(value) = std::env::var(key) {
            if let Some(proxy) = normalize_proxy_url(&value) {
                return Some(proxy);
            }
        }
    }
    // ② 退回系统代理：这才是 GUI 应用该走的那份配置。
    let config = system_proxy_config()?;
    if matches_proxy_exception(&host, &config.exceptions) {
        return None;
    }
    normalize_proxy_url(&config.url)
}

/// 读操作系统里的代理设置：macOS 用 `scutil --proxy`，Windows 读注册表。
fn system_proxy_config() -> Option<SystemProxy> {
    #[cfg(target_os = "macos")]
    {
        macos_proxy_config()
    }
    #[cfg(windows)]
    {
        windows_proxy_config()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
fn macos_proxy_config() -> Option<SystemProxy> {
    let output = Command::new("scutil").arg("--proxy").output().ok()?;
    parse_macos_proxy(&String::from_utf8_lossy(&output.stdout))
}

/// `scutil --proxy` 的输出长这样（key 与值的冒号两侧都有空格）：
///
/// ```text
///   HTTPEnable : 1
///   HTTPProxy : 127.0.0.1
///   HTTPPort : 7897
///   ExceptionsList : <array> {
///     0 : 127.0.0.1
///     1 : *.local
///   }
/// ```
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_macos_proxy(text: &str) -> Option<SystemProxy> {
    let mut http = (false, String::new(), String::new());
    let mut https = (false, String::new(), String::new());
    let mut exceptions: Vec<String> = Vec::new();
    let mut in_exceptions = false;

    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            // 例外表以单独一行 `}` 收尾 —— 没有冒号，正好用来切回来。
            in_exceptions = false;
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if key == "ExceptionsList" {
            in_exceptions = true;
            continue;
        }
        if in_exceptions {
            if key.chars().all(|character| character.is_ascii_digit()) && !value.is_empty() {
                exceptions.push(value.to_string());
            }
            continue;
        }
        match key {
            "HTTPEnable" => http.0 = value == "1",
            "HTTPProxy" => http.1 = value.to_string(),
            "HTTPPort" => http.2 = value.to_string(),
            "HTTPSEnable" => https.0 = value == "1",
            "HTTPSProxy" => https.1 = value.to_string(),
            "HTTPSPort" => https.2 = value.to_string(),
            _ => {}
        }
    }

    let pick = |entry: &(bool, String, String)| {
        (entry.0 && !entry.1.is_empty() && !entry.2.is_empty())
            .then(|| format!("http://{}:{}", entry.1, entry.2))
    };
    // 只开 HTTPS 也要用：Clash 这类工具的「混合端口」对 HTTP 与 HTTPS 是同一个。
    let url = pick(&http).or_else(|| pick(&https))?;
    Some(SystemProxy { url, exceptions })
}

#[cfg(windows)]
fn windows_proxy_config() -> Option<SystemProxy> {
    let output = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        ])
        .output()
        .ok()?;
    let config = parse_windows_registry(&String::from_utf8_lossy(&output.stdout))?;
    Some(SystemProxy {
        url: normalize_proxy_url(&config.server)?,
        exceptions: config.exceptions,
    })
}

#[cfg_attr(not(windows), allow(dead_code))]
struct WindowsProxy {
    server: String,
    exceptions: Vec<String>,
}

/// 解析 `reg query ...Internet Settings` 的输出：
///
/// ```text
///     ProxyEnable    REG_DWORD    0x1
///     ProxyServer    REG_SZ       127.0.0.1:7897
///     ProxyOverride  REG_SZ       <local>;*.corp.example
/// ```
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_windows_registry(text: &str) -> Option<WindowsProxy> {
    let mut enabled = false;
    let mut server = String::new();
    let mut exceptions: Vec<String> = Vec::new();

    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(name), Some(_kind)) = (parts.next(), parts.next()) else {
            continue;
        };
        let value = parts.collect::<Vec<_>>().join(" ");
        match name {
            "ProxyEnable" => enabled = value.trim().ends_with('1'),
            "ProxyServer" => server = value,
            "ProxyOverride" => {
                exceptions = value
                    .split(';')
                    .map(|entry| entry.trim().to_string())
                    .filter(|entry| !entry.is_empty())
                    .collect();
            }
            _ => {}
        }
    }

    (enabled && !server.trim().is_empty()).then_some(WindowsProxy { server, exceptions })
}

/// 目标主机名（去掉 scheme 与端口）。纯字符串切分，不引入 url 依赖。
fn host_of(url: &str) -> String {
    let origin = origin_of(url);
    let rest = match origin.find("://") {
        Some(index) => &origin[index + 3..],
        None => origin.as_str(),
    };
    let rest = rest.trim_end_matches('/');
    match rest.rsplit_once(':') {
        // 端口一定是纯数字；`[::1]` 这种 IPv6 字面量因此会原样保留。
        Some((host, port))
            if !port.is_empty() && port.chars().all(|character| character.is_ascii_digit()) =>
        {
            host.to_string()
        }
        _ => rest.to_string(),
    }
}

/// 本机与内网地址不该经过上游代理：本地素材服务、局域网媒体库转出去只会更慢或直接失败。
fn is_private_host(host: &str) -> bool {
    let host = host
        .trim_matches(|character| character == '[' || character == ']')
        .to_ascii_lowercase();
    if host == "localhost" || host == "::1" || host.ends_with(".local") {
        return true;
    }
    if host.starts_with("127.") || host.starts_with("10.") || host.starts_with("192.168.") {
        return true;
    }
    if let Some(rest) = host.strip_prefix("172.") {
        if let Some(second) = rest.split('.').next() {
            if let Ok(value) = second.parse::<u8>() {
                return (16..=31).contains(&value);
            }
        }
    }
    false
}

/// 代理例外表匹配：`127.0.0.1` 精确比对，`*.corp.example` 后缀比对 —— 系统里就这两种写法。
fn matches_proxy_exception(host: &str, exceptions: &[String]) -> bool {
    let host = host.to_ascii_lowercase();
    exceptions.iter().any(|entry| {
        let entry = entry.trim().to_ascii_lowercase();
        // `<local>` 代表「所有不含点的本地名」，由 is_private_host 负责，这里不重复判。
        if entry.is_empty() || entry == "<local>" {
            return false;
        }
        match entry.strip_prefix("*.") {
            Some(suffix) => host == suffix || host.ends_with(&format!(".{suffix}")),
            None => host == entry,
        }
    })
}

/// 把各家五花八门的代理写法收敛成 ffmpeg 能吃的一个 URL。
///
/// ffmpeg 的 `-http_proxy` **只支持 HTTP 代理**，SOCKS 一律不能用 —— 遇到就返回 `None`，
/// 交回直连，免得硬塞一个参数把请求彻底弄死。
fn normalize_proxy_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("socks") {
        return None;
    }
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Some(value.to_string());
    }
    if value.contains('=') {
        return pick_windows_proxy_entry(value);
    }
    Some(format!("http://{value}"))
}

/// Windows 的 `ProxyServer` 可能是裸 `127.0.0.1:7897`，也可能是 `http=a;https=b` 的分协议写法。
fn pick_windows_proxy_entry(value: &str) -> Option<String> {
    let mut https_entry: Option<String> = None;
    for part in value.split(';') {
        let Some((scheme, entry)) = part.split_once('=') else {
            continue;
        };
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let normalized = if entry.to_ascii_lowercase().starts_with("http") {
            entry.to_string()
        } else {
            format!("http://{entry}")
        };
        match scheme.trim().to_ascii_lowercase().as_str() {
            "http" => return Some(normalized),
            "https" => https_entry = Some(normalized),
            _ => {}
        }
    }
    https_entry
}

/// 跑一次 ffmpeg 并等它结束；超过 `HLS_TIMEOUT` 直接杀掉。
fn run_ffmpeg(ffmpeg: &Path, args: &[String]) -> Result<(), String> {
    use std::process::Stdio;

    let mut child = Command::new(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动 ffmpeg 失败: {error}"))?;

    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                let mut message = String::new();
                if let Some(mut stderr) = child.stderr.take() {
                    let _ = stderr.read_to_string(&mut message);
                }
                return Err(summarize_ffmpeg_error(&message));
            }
            Ok(None) => {
                if started.elapsed() >= HLS_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("下载超过 15 分钟仍没结束，已中断".to_string());
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(error) => return Err(format!("等待 ffmpeg 失败: {error}")),
        }
    }
}

/// ffmpeg 的 stderr 可能很长，只留最后几行：够定位问题，又不会把错误提示刷爆。
fn summarize_ffmpeg_error(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let picked: Vec<&str> = lines.iter().rev().take(3).rev().copied().collect();
    if picked.is_empty() {
        "ffmpeg 执行失败，但没有给出原因".to_string()
    } else {
        format!("下载 HLS 失败：{}", picked.join(" / "))
    }
}

/// 组 ffmpeg 参数。单独抽出来是为了能测 —— 这里每一处都是踩出来的。
///
/// `proxy` 为 `None` 表示直连（本机/内网地址，或系统本来就没配代理）。
fn hls_ffmpeg_args(
    url: &str,
    referer: &str,
    destination: &str,
    reencode_audio: bool,
    proxy: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
    ];
    // 站点挡 HLS 分片最常用的手段就是校验 Referer / Origin，而 ffmpeg 默认一个都不带。
    if !referer.is_empty() {
        let origin = origin_of(referer);
        let headers = if origin.is_empty() {
            format!("Referer: {referer}\r\n")
        } else {
            format!("Referer: {referer}\r\nOrigin: {origin}\r\n")
        };
        args.push("-headers".into());
        args.push(headers);
    }
    args.push("-user_agent".into());
    args.push(HLS_USER_AGENT.into());
    // ffmpeg 只认 `http_proxy` 环境变量，**不读系统代理设置**；而浏览器读系统代理。
    // 结果就是「网页能播、一存就超时」：同一台机器，浏览器走了代理，ffmpeg 直连。
    // 这里显式把代理塞进参数，走 CONNECT 隧道，证书与 SNI 仍按原域名校验。
    if let Some(proxy) = proxy {
        args.push("-http_proxy".into());
        args.push(proxy.into());
    }
    // 30 秒收不到任何数据就判失败，别把一个死流挂到总超时。
    args.push("-rw_timeout".into());
    args.push("30000000".into());
    args.push("-i".into());
    args.push(url.into());
    if reencode_audio {
        args.extend([
            "-c:v".into(),
            "copy".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
        ]);
    } else {
        args.extend(["-c".into(), "copy".into()]);
    }
    args.extend(["-movflags".into(), "+faststart".into()]);
    args.push(destination.into());
    args
}

/// 从 URL 取 `scheme://host[:port]`。只做字符串切分，不引入额外的 url 依赖。
fn origin_of(url: &str) -> String {
    let scheme_end = match url.find("://") {
        Some(index) => index,
        None => return String::new(),
    };
    let rest = &url[scheme_end + 3..];
    let end = rest
        .find(|character| character == '/' || character == '?' || character == '#')
        .unwrap_or(rest.len());
    format!("{}{}", &url[..scheme_end + 3], &rest[..end])
}

fn is_http_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.len() <= "https://".len() {
        return false;
    }
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn read_line(reader: &mut impl BufRead) -> Result<String, String> {
    let mut raw = Vec::new();
    let read = reader
        .read_until(b'\n', &mut raw)
        .map_err(|error| format!("读取请求失败: {error}"))?;
    if read == 0 {
        return Err("连接在请求结束前被关闭".to_string());
    }
    while matches!(raw.last(), Some(b'\n') | Some(b'\r')) {
        raw.pop();
    }
    Ok(String::from_utf8_lossy(&raw).to_string())
}

fn header_value(lines: &[String], name: &str) -> Option<String> {
    lines.iter().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim()
            .eq_ignore_ascii_case(name)
            .then(|| value.trim().to_string())
    })
}

fn split_target(target: &str) -> (String, String) {
    match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (target.to_string(), String::new()),
    }
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        name.eq_ignore_ascii_case(key)
            .then(|| percent_decode(value))
    })
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 3 <= bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or_default();
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            other => {
                out.push(other);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn is_extension_origin(origin: &str) -> bool {
    let lower = origin.trim().to_ascii_lowercase();
    lower.starts_with("chrome-extension://")
        || lower.starts_with("moz-extension://")
        || lower.starts_with("safari-web-extension://")
        || lower.starts_with("edge-extension://")
}

fn normalize_media_type(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "video" => "video".to_string(),
        "audio" => "audio".to_string(),
        _ => "image".to_string(),
    }
}

fn default_extension(media_type: &str) -> &'static str {
    match media_type {
        "video" => "mp4",
        "audio" => "mp3",
        _ => "png",
    }
}

fn extension_from_name(file_name: &str) -> Option<String> {
    let (_, extension) = file_name.rsplit_once('.')?;
    let trimmed = extension.trim();
    (!trimmed.is_empty() && trimmed.len() <= 12 && trimmed.chars().all(|c| c.is_ascii_alphanumeric()))
        .then(|| trimmed.to_string())
}

fn strip_extension(file_name: &str) -> String {
    match file_name.rsplit_once('.') {
        Some((stem, _)) if !stem.trim().is_empty() => stem.trim().to_string(),
        _ => file_name.trim().to_string(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn error_body(message: &str) -> Value {
    json!({ "ok": false, "error": message })
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        _ => "Internal Server Error",
    }
}

fn respond_empty(
    writer: &mut TcpStream,
    status: u16,
    origin: Option<&str>,
) -> Result<(), String> {
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Length: 0\r\nConnection: close\r\n",
        reason_phrase(status)
    );
    if let Some(origin) = origin {
        head.push_str(&format!(
            "Access-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Max-Age: 600\r\n"
        ));
    }
    head.push_str("\r\n");
    writer
        .write_all(head.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| format!("写响应失败: {error}"))
}

fn respond_json(
    writer: &mut TcpStream,
    status: u16,
    body: &Value,
    origin: Option<&str>,
) -> Result<(), String> {
    let payload = serde_json::to_string(body).unwrap_or_else(|_| "{\"ok\":false}".to_string());
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n",
        reason_phrase(status),
        payload.len()
    );
    // 只有合法来源才回 CORS 头：非法 Origin 连响应都读不到。
    if let Some(origin) = origin {
        head.push_str(&format!("Access-Control-Allow-Origin: {origin}\r\n"));
    }
    head.push_str("\r\n");
    writer
        .write_all(head.as_bytes())
        .and_then(|_| writer.write_all(payload.as_bytes()))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("写响应失败: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_query_values_with_url_decoding() {
        let query = "categoryId=category-scenes&name=%E7%81%AB%E8%BD%A6%E7%AB%99&mediaType=image";
        assert_eq!(
            query_value(query, "categoryid").as_deref(),
            Some("category-scenes")
        );
        assert_eq!(query_value(query, "name").as_deref(), Some("火车站"));
        assert_eq!(query_value(query, "mediaType").as_deref(), Some("image"));
        assert_eq!(query_value(query, "missing"), None);
    }

    #[test]
    fn decodes_plus_as_space_and_keeps_broken_escapes() {
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn accepts_only_extension_origins() {
        assert!(is_extension_origin("chrome-extension://abcdefghijklmnop"));
        assert!(is_extension_origin("moz-extension://abcdef"));
        assert!(!is_extension_origin("https://example.com"));
        assert!(!is_extension_origin("http://127.0.0.1:5173"));
    }

    #[test]
    fn derives_extension_and_name_from_file_name() {
        let request = ImportRequest::from_query(
            "fileName=%E9%A3%8E%E6%99%AF.jpg&mediaType=image",
        );
        assert_eq!(request.extension, "jpg");
        assert_eq!(request.name, "风景");
        assert_eq!(request.file_name, "风景.jpg");
        assert_eq!(request.media_type, "image");
        assert_eq!(request.category_id, None);
    }

    #[test]
    fn falls_back_to_media_type_defaults() {
        let request = ImportRequest::from_query("mediaType=video&name=clip");
        assert_eq!(request.extension, "mp4");
        assert_eq!(request.name, "clip");
        assert_eq!(request.file_name, "");
    }

    #[test]
    fn normalizes_unknown_media_types_to_image() {
        assert_eq!(normalize_media_type("IMAGE"), "image");
        assert_eq!(normalize_media_type("video"), "video");
        assert_eq!(normalize_media_type("whatever"), "image");
    }

    #[test]
    fn splits_target_into_path_and_query() {
        assert_eq!(
            split_target("/assets?a=1"),
            ("/assets".to_string(), "a=1".to_string())
        );
        assert_eq!(
            split_target("/ping"),
            ("/ping".to_string(), String::new())
        );
    }

    /// 落盘用临时文件，测完自己删掉，不污染任何目录。
    fn temp_target() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("media-bridge-test-{}.bin", Uuid::new_v4()))
    }

    fn read_body(payload: &[u8], spec: BodySpec) -> Result<(u64, Vec<u8>), String> {
        let mut reader = BufReader::new(std::io::Cursor::new(payload.to_vec()));
        let target = temp_target();
        let outcome = stream_to_file(&mut reader, &target, spec);
        let bytes = fs::read(&target).unwrap_or_default();
        let _ = fs::remove_file(&target);
        outcome.map(|written| (written, bytes))
    }

    #[test]
    fn reads_fixed_length_body_in_full() {
        let (written, bytes) = read_body(b"abcdefghij", BodySpec::Exact(10)).unwrap();
        assert_eq!(written, 10);
        assert_eq!(bytes, b"abcdefghij".to_vec());
    }

    #[test]
    fn merges_chunked_body_into_one_file() {
        let (written, bytes) =
            read_body(b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n", BodySpec::Chunked).unwrap();
        assert_eq!(written, 11);
        assert_eq!(bytes, b"hello world".to_vec());
    }

    #[test]
    fn accepts_chunk_extension_and_trailers() {
        let (written, bytes) = read_body(
            b"5;note=ignored\r\nhello\r\n0\r\nX-Checksum: abc\r\n\r\n",
            BodySpec::Chunked,
        )
        .unwrap();
        assert_eq!(written, 5);
        assert_eq!(bytes, b"hello".to_vec());
    }

    #[test]
    fn rejects_chunk_with_unparsable_length() {
        let error = read_body(b"zz\r\nhello\r\n0\r\n\r\n", BodySpec::Chunked).unwrap_err();
        assert!(error.contains("分块长度无法解析"), "unexpected: {error}");
    }

    #[test]
    fn rejects_truncated_chunk_body() {
        let error = read_body(b"10\r\nabc", BodySpec::Chunked).unwrap_err();
        assert!(error.contains("上传中断"), "unexpected: {error}");
    }

    #[test]
    fn rejects_short_fixed_length_body() {
        let error = read_body(b"abc", BodySpec::Exact(10)).unwrap_err();
        assert!(error.contains("上传中断"), "unexpected: {error}");
    }

    #[test]
    fn parses_hls_request_with_camel_case_keys() {
        // 用普通 raw string：raw **byte** string 里不能有非 ASCII 字符。
        let body = r#"{"url":"https://cdn.example/a.m3u8","pageUrl":"https://site.example/watch","categoryId":"category-1","name":"片子","fileName":"a.mp4"}"#;
        let request: HlsImportRequest = serde_json::from_slice(body.as_bytes()).unwrap();
        assert_eq!(request.url, "https://cdn.example/a.m3u8");
        assert_eq!(request.page_url, "https://site.example/watch");
        assert_eq!(request.category_id.as_deref(), Some("category-1"));
        assert_eq!(request.name, "片子");
        assert_eq!(request.file_name, "a.mp4");
    }

    #[test]
    fn hls_request_fields_all_optional() {
        let request: HlsImportRequest = serde_json::from_slice(b"{}").unwrap();
        assert!(request.url.is_empty());
        assert!(request.page_url.is_empty());
        assert_eq!(request.category_id, None);
        assert!(request.file_name.is_empty());
    }

    #[test]
    fn accepts_only_http_urls() {
        assert!(is_http_url("https://cdn.example/a.m3u8"));
        assert!(is_http_url("http://127.0.0.1:8000/a.m3u8"));
        assert!(!is_http_url("file:///etc/passwd"));
        assert!(!is_http_url("chrome-extension://abcdef/a"));
        assert!(!is_http_url("https://"));
    }

    #[test]
    fn derives_origin_from_page_url() {
        assert_eq!(
            origin_of("https://site.example/watch/1?x=2"),
            "https://site.example"
        );
        assert_eq!(origin_of("http://127.0.0.1:8000/a"), "http://127.0.0.1:8000");
        assert_eq!(origin_of("nonsense"), "");
    }

    /// 这两个头是防盗链能不能过的关键，必须有，且必须挂在 `-i` 之前。
    #[test]
    fn hls_args_carry_referer_and_origin_before_input() {
        let args = hls_ffmpeg_args(
            "https://cdn.example/a.m3u8",
            "https://site.example/watch/1",
            "/tmp/out.mp4",
            false,
            None,
        );
        let headers = args
            .iter()
            .position(|value| value == "-headers")
            .expect("缺少 -headers");
        assert_eq!(
            args[headers + 1],
            "Referer: https://site.example/watch/1\r\nOrigin: https://site.example\r\n"
        );
        let input = args
            .iter()
            .position(|value| value == "-i")
            .expect("缺少 -i");
        assert!(
            headers < input,
            "-headers 必须在 -i 之前，否则不生效：{args:?}"
        );
        assert_eq!(args[input + 1], "https://cdn.example/a.m3u8");
        assert_eq!(args.last().unwrap(), "/tmp/out.mp4");
        assert!(args.iter().any(|value| value == "+faststart"));
    }

    #[test]
    fn hls_args_fall_back_to_aac_when_copy_fails() {
        let args = hls_ffmpeg_args("https://cdn.example/a.m3u8", "", "/tmp/out.mp4", true, None);
        assert!(!args.iter().any(|value| value == "-headers"));
        assert!(args.iter().any(|value| value == "aac"));
        assert!(args.iter().any(|value| value == "copy"));
    }

    /// `-http_proxy` 是**输入选项**：必须挂在 `-i` 之前才会作用于这次拉流。
    /// 「网页能播、一存就超时」修的就是这里，位置错了等于没修。
    #[test]
    fn hls_args_pass_proxy_before_input() {
        let args = hls_ffmpeg_args(
            "https://cdn.example/a.m3u8",
            "https://site.example/watch/1",
            "/tmp/out.mp4",
            false,
            Some("http://127.0.0.1:7897"),
        );
        assert!(args.iter().any(|value| value == "-http_proxy"));

        let proxy = args
            .iter()
            .position(|value| value == "-http_proxy")
            .expect("缺少 -http_proxy");
        assert_eq!(args[proxy + 1], "http://127.0.0.1:7897");

        let input = args.iter().position(|value| value == "-i").expect("缺少 -i");
        assert!(proxy < input, "-http_proxy 必须在 -i 之前：{args:?}");
        assert_eq!(args[input + 1], "https://cdn.example/a.m3u8");

        // 直连时不能凭空塞一个代理参数。
        let direct = hls_ffmpeg_args("https://cdn.example/a.m3u8", "", "/tmp/out.mp4", false, None);
        assert!(!direct.iter().any(|value| value == "-http_proxy"));
    }

    /// 现场抄回来的那种「单文件切片」清单：41 个分片全指向同一个 `.cmfv`，
    /// 只靠 BYTERANGE 区分。判断错一次就退化成「只有 2 秒」，所以钉住真实片段。
    #[test]
    fn detects_single_file_playlist() {
        let text = "\
#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-VERSION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI=\"clip_720w.cmfv\",BYTERANGE=\"1097@0\"
#EXTINF:2
#EXT-X-BYTERANGE:942175@1641
clip_720w.cmfv
#EXTINF:2
#EXT-X-BYTERANGE:1026189@943816
clip_720w.cmfv
#EXTINF:4
#EXT-X-BYTERANGE:1538050@3760843
clip_720w.cmfv
#EXT-X-ENDLIST
";
        let (variant, segments) =
            parse_playlist("https://cdn.example/videos/a/clip_720w.m3u8", text);
        assert!(variant.is_none(), "这不是多码率清单");
        // `#EXT-X-MAP` 是注释行，不能被算成第 4 个分片。
        assert_eq!(segments.len(), 3, "{segments:?}");

        let mut unique: Vec<&str> = segments.iter().map(String::as_str).collect();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(
            unique,
            vec!["https://cdn.example/videos/a/clip_720w.cmfv"],
            "相对路径应被拼成同一个绝对地址"
        );
    }

    /// 常规 HLS：一段一个文件。这种必须继续走原来的拉流路径，不能误判成单文件。
    #[test]
    fn keeps_normal_multi_file_playlist() {
        let text = "\
#EXTM3U
#EXTINF:10,
seg_000.ts
#EXTINF:10,
seg_001.ts
#EXT-X-ENDLIST
";
        let (_, segments) = parse_playlist("https://cdn.example/live/index.m3u8", text);
        assert_eq!(
            segments,
            vec![
                "https://cdn.example/live/seg_000.ts",
                "https://cdn.example/live/seg_001.ts"
            ]
        );
    }

    /// 多码率清单要先跳到变体，别把变体地址当成分片地址。
    #[test]
    fn follows_master_playlist_variant() {
        let text = "\
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360/index.m3u8
";
        let (variant, segments) = parse_playlist("https://cdn.example/hls/master.m3u8", text);
        assert_eq!(
            variant.as_deref(),
            Some("https://cdn.example/hls/720/index.m3u8")
        );
        assert!(segments.is_empty(), "{segments:?}");
    }

    /// 相对路径的三种写法都要拼对，清单里这三种都常见。
    #[test]
    fn resolves_playlist_urls() {
        let base = "https://cdn.example/videos/47/ef/clip.m3u8?token=abc";
        assert_eq!(
            resolve_url(base, "seg.ts"),
            "https://cdn.example/videos/47/ef/seg.ts"
        );
        assert_eq!(
            resolve_url(base, "/root/seg.ts"),
            "https://cdn.example/root/seg.ts"
        );
        assert_eq!(
            resolve_url(base, "https://other.example/abs.ts"),
            "https://other.example/abs.ts"
        );
    }

    /// 不是清单的地址不该被当成清单去读 —— 否则一个大直链会被整个读进内存。
    #[test]
    fn ignores_non_playlist_urls() {
        assert!(hls_single_file_source("https://cdn.example/movie.mp4", "", None).is_none());
        assert!(hls_single_file_source("", "", None).is_none());
    }

    /// 现场原样抄回来的 `scutil --proxy`，含 `<local>` 之类的非数字条目要能跳过。
    #[cfg(target_os = "macos")]
    #[test]
    fn reads_macos_system_proxy() {
        let text = "\
<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : <local>
    3 : *.local
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7897
}
";
        let config = parse_macos_proxy(text).expect("应当解析出代理");
        assert_eq!(config.url, "http://127.0.0.1:7897");
        assert_eq!(config.exceptions.len(), 4);

        // 关了代理就必须直连，否则会把用户的网络彻底带偏。
        let disabled = text.replace("HTTPEnable : 1", "HTTPEnable : 0")
            .replace("HTTPSEnable : 1", "HTTPSEnable : 0");
        assert!(parse_macos_proxy(&disabled).is_none());
    }

    #[test]
    fn reads_windows_registry_proxy() {
        let text = "\
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       http=127.0.0.1:7897;https=127.0.0.1:7897
    ProxyOverride  REG_SZ       <local>;*.corp.example
";
        let proxy = parse_windows_registry(text).expect("应当解析出代理");
        assert_eq!(normalize_proxy_url(&proxy.server).unwrap(), "http://127.0.0.1:7897");
        assert_eq!(proxy.exceptions.len(), 2);

        let off = text.replace("0x1", "0x0");
        assert!(parse_windows_registry(&off).is_none());
    }

    /// SOCKS 不能塞给 `-http_proxy` —— 硬塞会让请求直接死掉，宁可退回直连。
    #[test]
    fn normalizes_proxy_values_and_rejects_socks() {
        assert_eq!(
            normalize_proxy_url("127.0.0.1:7897").unwrap(),
            "http://127.0.0.1:7897"
        );
        assert_eq!(
            normalize_proxy_url(" http://127.0.0.1:7890 ").unwrap(),
            "http://127.0.0.1:7890"
        );
        assert_eq!(
            normalize_proxy_url("http=proxy.example:8080;https=other:8080").unwrap(),
            "http://proxy.example:8080"
        );
        assert_eq!(normalize_proxy_url("socks5://127.0.0.1:7890"), None);
        assert_eq!(normalize_proxy_url("   "), None);
    }

    /// 本机与内网地址必须绕开代理：本地 fixture、局域网素材服务都不能被转发出去。
    #[test]
    fn local_hosts_bypass_proxy() {
        assert_eq!(host_of("http://127.0.0.1:8899/hls/index.m3u8"), "127.0.0.1");
        assert_eq!(
            host_of("https://v1.pinimg.com/videos/a/b/index.m3u8"),
            "v1.pinimg.com"
        );
        assert_eq!(host_of("nonsense"), "");

        for host in [
            "127.0.0.1",
            "localhost",
            "10.0.0.9",
            "192.168.1.20",
            "172.16.4.4",
            "172.31.255.1",
            "nas.local",
        ] {
            assert!(is_private_host(host), "{host} 应当被判为本机/内网");
        }
        for host in ["172.32.0.1", "8.8.8.8", "v1.pinimg.com", "cdn.example"] {
            assert!(!is_private_host(host), "{host} 不该被判为本机");
        }

        let exceptions = vec!["*.corp.example".to_string(), "media.internal".to_string()];
        assert!(matches_proxy_exception("a.corp.example", &exceptions));
        assert!(matches_proxy_exception("corp.example", &exceptions));
        assert!(matches_proxy_exception("media.internal", &exceptions));
        assert!(!matches_proxy_exception("v1.pinimg.com", &exceptions));
        // `<local>` 不是主机名，不能被当成规则误命中。
        assert!(!matches_proxy_exception("local", &["<local>".to_string()]));
    }

    /// 诊断日志的时间戳：手写换算最容易在闰日与月末算错，用已知锚点钉住。
    #[test]
    fn utc_format_matches_known_timestamps() {
        assert_eq!(format_utc(0), "1970-01-01 00:00:00Z");
        assert_eq!(format_utc(1_700_000_000), "2023-11-14 22:13:20Z");
        // 2000-02-29：闰日 + 世纪闰年的边界。
        assert_eq!(format_utc(951_782_400), "2000-02-29 00:00:00Z");
        // 闰年末的最后一秒，跨年最容易差一天。
        assert_eq!(format_utc(1_735_689_599), "2024-12-31 23:59:59Z");
        assert_eq!(timestamp_text().len(), 20, "{}", timestamp_text());
    }

    #[test]
    fn summarizes_ffmpeg_error_tail() {
        let message = summarize_ffmpeg_error("line1\n\nline2\nline3\nline4\n");
        assert!(message.contains("line4"), "unexpected: {message}");
        assert!(message.contains("line2"), "unexpected: {message}");
        assert!(!message.contains("line1"), "unexpected: {message}");
        assert!(summarize_ffmpeg_error("").contains("没有给出原因"));
    }
}
