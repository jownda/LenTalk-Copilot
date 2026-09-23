#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
扒剧本 CLI —— 把短剧视频扒成标准拉片剧本
零第三方依赖：只用 Python 标准库 + 系统 ffmpeg。

用法：
  python3 pajuben.py 视频.mp4                # 用 config.json 里的配置，自动从文件名取集号
  python3 pajuben.py 视频.mp4 --ep 5         # 指定集号
  python3 pajuben.py 视频.mp4 --fps 1 --res low --max-frames 120
  python3 pajuben.py 视频.mp4 --provider zhipu --key sk-xxx --model glm-4.6v-flash
  python3 pajuben.py 视频.mp4 --base https://中转地址/v1   # 自定义/中转 base_url

输出：视频同目录下  剧本/第N集.txt
"""

import argparse, base64, json, math, os, re, subprocess, sys, tempfile, shutil, threading, time
import urllib.request, urllib.error, urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    from face_identity import identify_frames
except ImportError:
    identify_frames = None

HERE = os.path.dirname(os.path.abspath(__file__))

# 各渠道的 OpenAI 兼容端点（都走 /chat/completions）
PROVIDERS = {
    "volcano": "https://ark.cn-beijing.volces.com/api/v3",
    "zhipu":   "https://open.bigmodel.cn/api/paas/v4",
    "gemini":  "https://generativelanguage.googleapis.com/v1beta/openai",
    "openai":  "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "gemini_native": "https://generativelanguage.googleapis.com/v1beta",
}

# low/high 大致对应的抽帧长边像素（控制 token 消耗）
RES_LONGEDGE = {"low": 512, "medium": 768, "high": 1024}
SUBTITLE_EXTENSIONS = (".srt", ".vtt", ".ass", ".ssa")
SUBTITLE_TIME_RE = re.compile(
    r"(?P<start>(?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*"
    r"(?P<end>(?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3})"
)
MAX_SUBTITLE_CHARS_PER_SEGMENT = 24_000


def log(msg):
    print(msg, flush=True)


def progress(done, total):
    """机器可读进度行，桌面版解析后驱动进度条；命令行下也能看个大概。"""
    print(f"##PROGRESS {done}/{total}", flush=True)


def ep_progress(ep, pct, text):
    """单集内部进度（0-100 与当前阶段），桌面版用来画每集的小进度条。"""
    print(f"##EP {ep} {int(pct)} {text}", flush=True)


def ep_done(ep):
    print(f"##EPDONE {ep}", flush=True)


def ep_failed(ep, reason):
    clean = re.sub(r"\s+", " ", str(reason)).strip()[:160]
    print(f"##EPFAIL {ep} {clean}", flush=True)


def load_config():
    path = os.path.join(HERE, "config.json")
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        # 去掉以 _ 开头的说明键不影响使用
        data = json.load(f)
    # API Key 优先从环境变量读取，避免把密钥长期明文保存在项目中。
    env_key = os.environ.get("PAJUBEN_API_KEY", "").strip()
    if env_key:
        data["api_key"] = env_key
    return data


def load_prompt():
    path = os.path.join(HERE, "prompt.txt")
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def guess_ep(video_path):
    """从文件名猜集号。认不出来一律返回 1，绝不从乱码里抠数字。

    旧实现兜底是「取名字里第一段 1~3 位数字」，于是 `node-16e678df-...mp4`
    这种 uuid 命名会凭空变成「第16集」，输出文件名与界面上的集号对不上。
    现在只在下面这些明确写法里取集号：
      第16集 / 16集 / S01E16 / E16 / EP16 / 纯数字名(01、16、[16])
    以及**不含拉丁字母**的名字（日期、序号命名，如 `9月19日.mp4`）才退一步取首段数字。
    ⚠ 前端 src/features/pajuben/pajubenEpisode.ts 是同一套规则的镜像，改这里要同步改那边。
    """
    # 只检查不含扩展名的文件名，避免把 .mp4 误识别成第 4 集。
    name = os.path.splitext(os.path.basename(video_path))[0]
    m = re.search(r"第\s*(\d+)\s*集", name)
    if m:
        return int(m.group(1))
    m = re.search(r"(\d+)\s*集", name)
    if m:
        return int(m.group(1))
    # S01E16 / s1e16
    m = re.search(r"[Ss]\d{1,3}\s*[Ee]\s*(\d{1,4})(?![0-9])", name)
    if m:
        return int(m.group(1))
    # E16 / EP16 / -e16（前面必须是非字母数字，避免 uuid 里的 e6 被当集号）
    m = re.search(r"(?:^|[^A-Za-z0-9])[Ee][Pp]?[-_. ]?(\d{1,4})(?![0-9])", name)
    if m:
        return int(m.group(1))
    # 纯数字名：01 / 16 / [16] / （16）
    m = re.fullmatch(r"[\s\[\(（【]*(\d{1,4})[\s\]\)）】]*", name)
    if m:
        return int(m.group(1))
    # 不含拉丁字母的名字（`9月19日.mp4`）才允许取首段数字；
    # uuid / C6218 / IMG_20260207 这类含字母的名字一律不猜。
    if not re.search(r"[A-Za-z]", name):
        m = re.search(r"(\d{1,3})", name)
        if m:
            return int(m.group(1))
    return 1


_DURATION_PATTERN = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")


def duration_from_ffmpeg(video_path):
    """ffprobe 缺失时的兜底：解析 ffmpeg -i 写到 stderr 的时长行。"""
    try:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-i", video_path],
                             capture_output=True, text=True).stderr or ""
    except Exception:
        return 0.0
    match = _DURATION_PATTERN.search(out)
    if not match:
        return 0.0
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def probe_duration(video_path):
    # 有些发行版只随包 ffmpeg(没有 ffprobe)：这时回退到解析 ffmpeg 输出，
    # 否则时长恒为 0 会让分段策略退化成单段、每段抽帧密度算错。
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", video_path],
            capture_output=True, text=True, check=True).stdout.strip()
        return float(out)
    except FileNotFoundError:
        return duration_from_ffmpeg(video_path)
    except Exception:
        return 0.0


def plan_segments(duration, fps, max_frames, max_segments):
    """把一集划成若干段：返回 [(起点秒, 段长秒, 段内有效fps), ...]。
    帧数装得下就单段（段长 0 表示整片，维持旧行为）；装不下按 max_frames 切段，
    长视频自动增加分段；max_segments 仅兼容旧配置，不再限制长视频。"""
    if duration <= 0 or not max_frames or fps * duration <= max_frames:
        return [(0.0, 0.0, fps)]
    n = math.ceil(fps * duration / max_frames)
    # 约75秒一段，避免十几分钟视频被压成仅4段；短视频逻辑不变。
    n = max(n, math.ceil(duration / 75.0))
    capped = False
    seg_dur = duration / n
    eff_fps = fps
    return [(i * seg_dur, seg_dur, eff_fps) for i in range(n)]


def extract_frames(video_path, fps, longedge, max_frames, workdir, start=0.0, seg_dur=0.0):
    """按帧率抽帧并缩放，可只抽 [start, start+seg_dur) 一段。
    返回 [(jpg路径, 全片绝对时间秒), ...]。seg_dur 为 0 表示抽到片尾。"""
    if fps <= 0:
        raise ValueError("fps 必须大于 0")
    if max_frames is not None and max_frames <= 0:
        raise ValueError("max_frames 必须大于 0")
    eff_fps = fps
    if not seg_dur:
        # 整片模式：时长已知且装不下时降帧率兜底（分段规划失效时的保险）
        duration = probe_duration(video_path)
        if duration and max_frames and fps * duration > max_frames:
            eff_fps = max_frames / duration
            log(f"  时长 {duration:.0f}s，按上限 {max_frames} 帧自动降到 {eff_fps:.3f} fps")
    out_pat = os.path.join(workdir, "f_%05d.jpg")
    vf = f"fps={eff_fps},scale='if(gt(iw,ih),{longedge},-2)':'if(gt(iw,ih),-2,{longedge})'"
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", video_path]
    if seg_dur:
        cmd += ["-t", f"{seg_dur:.3f}"]
    cmd += ["-vf", vf, "-q:v", "3", out_pat]
    subprocess.run(cmd, check=True)
    files = sorted(
        os.path.join(workdir, f) for f in os.listdir(workdir) if f.endswith(".jpg")
    )
    if not files:
        raise RuntimeError("没抽到帧，检查视频路径/格式是否正确")
    if max_frames and len(files) > max_frames:
        files = files[:max_frames]
    return [(fp, start + i / eff_fps) for i, fp in enumerate(files)]


def extract_audio(video_path, workdir, start=0.0, seg_dur=0.0):
    """抽出音频轨 → 单声道 16k mp3（够听清台词、体积小），可只裁一段。无音轨返回 None。"""
    out = os.path.join(workdir, "audio.mp3")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", video_path]
    if seg_dur:
        cmd += ["-t", f"{seg_dur:.3f}"]
    cmd += ["-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", out]
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError:
        return None
    return out if os.path.exists(out) and os.path.getsize(out) > 0 else None


def subtitle_timestamp(value):
    """SRT/VTT/ASS 时间戳转秒；解析失败时返回 None。"""
    match = re.match(r"^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[,.](\d+))?$", value.strip())
    if not match:
        return None
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2))
    seconds = int(match.group(3))
    fraction_text = match.group(4) or "0"
    fraction = int(fraction_text) / (10 ** len(fraction_text))
    return hours * 3600 + minutes * 60 + seconds + fraction


def clean_subtitle_text(text):
    """去除 VTT/ASS 样式标签，保留可作为台词证据的正文。"""
    cleaned = text.replace("\\N", " ").replace("\\n", " ")
    cleaned = re.sub(r"\{\\[^}]*\}", "", cleaned)
    cleaned = re.sub(r"<[^>]+>", "", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def parse_text_subtitles(text, extension):
    """解析常见文本字幕，统一成 (开始秒, 结束秒, 正文) 列表。"""
    if extension.lower() in (".ass", ".ssa"):
        cues = []
        for line in text.splitlines():
            if not line.lstrip().lower().startswith("dialogue:"):
                continue
            fields = line.split(":", 1)[1].split(",", 9)
            if len(fields) < 10:
                continue
            start, end = subtitle_timestamp(fields[1]), subtitle_timestamp(fields[2])
            body = clean_subtitle_text(fields[9])
            if start is not None and end is not None and end >= start and body:
                cues.append((start, end, body))
        return cues

    cues, start, end, lines = [], None, None, []

    def flush():
        nonlocal start, end, lines
        body = clean_subtitle_text(" ".join(lines))
        if start is not None and end is not None and end >= start and body:
            cues.append((start, end, body))
        start, end, lines = None, None, []

    for raw_line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n") + [""]:
        line = raw_line.strip().lstrip("\ufeff")
        match = SUBTITLE_TIME_RE.search(line)
        if match:
            flush()
            start = subtitle_timestamp(match.group("start"))
            end = subtitle_timestamp(match.group("end"))
        elif start is not None:
            if line:
                lines.append(line)
            else:
                flush()
    return cues


def sidecar_subtitle_paths(video_path):
    """找到与视频同名（或同名前缀）的外挂文本字幕。"""
    directory = os.path.dirname(os.path.abspath(video_path))
    stem = os.path.splitext(os.path.basename(video_path))[0].lower()
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return []
    result = []
    for name in names:
        candidate_stem, extension = os.path.splitext(name)
        if extension.lower() not in SUBTITLE_EXTENSIONS:
            continue
        if candidate_stem.lower() == stem or candidate_stem.lower().startswith(stem + "."):
            result.append(os.path.join(directory, name))
    return result


def load_video_subtitles(video_path):
    """优先外挂字幕，随后尝试导出视频第一条内嵌文本字幕。"""
    for path in sidecar_subtitle_paths(video_path):
        try:
            with open(path, encoding="utf-8-sig", errors="replace") as source:
                cues = parse_text_subtitles(source.read(), os.path.splitext(path)[1])
            if cues:
                return cues, path
        except OSError:
            continue

    workdir = tempfile.mkdtemp(prefix="pajuben_subtitle_")
    output = os.path.join(workdir, "embedded.srt")
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", video_path,
             "-map", "0:s:0", "-c:s", "srt", output],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0 or not os.path.exists(output):
            return [], None
        with open(output, encoding="utf-8-sig", errors="replace") as source:
            cues = parse_text_subtitles(source.read(), ".srt")
        return (cues, "内嵌字幕") if cues else ([], None)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def subtitles_for_segment(cues, start, seg_dur, duration):
    """只给当前视频分段带入对应字幕，防止长视频把整集字幕重复塞进每次请求。"""
    if not cues:
        return ""
    end = start + seg_dur if seg_dur else duration
    lines, size = [], 0
    for cue_start, cue_end, text in cues:
        if cue_end < start or cue_start > end:
            continue
        line = f"【{fmt_ts(cue_start)}-{fmt_ts(cue_end)}】{text}"
        if lines and size + len(line) + 1 > MAX_SUBTITLE_CHARS_PER_SEGMENT:
            lines.append("【字幕过长，以下内容省略】")
            break
        lines.append(line)
        size += len(line) + 1
    return "\n".join(lines)


def b64_file(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


def normalize_chat_base(base_url):
    """OpenAI 兼容根地址：缺版本段时补 /v1。

    LenTalk 设置里各家 baseUrl 带不带 /v1 并不统一（知鸟 cuai.token6688.com、
    炳火 api.7tai.cc、FHL www.fhl.mom 不带；ModelScope、字号动画带）。直接
    在后面拼 /chat/completions 会打到网关的兜底路由上，返回 HTML/空体，
    报出来是 `Expecting value: line 1 column 1 (char 0)` 这种看不出原因的错误。
    """
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return base
    if base.endswith("/chat/completions"):
        return base
    # 已带版本路径（/v1、/v3、/v1beta…）就不要再追加 /v1，避免出现 /v1/v1。
    if re.search(r"/v\d+(?:\.\d+)?(?:beta)?$", base, flags=re.I):
        return base
    return base + "/v1"


def chat_completions_url(base_url):
    normalized = normalize_chat_base(base_url)
    return normalized if normalized.endswith("/chat/completions") else (
        normalized + "/chat/completions")


def is_gemini_native_base(base_url):
    normalized = base_url.rstrip("/").lower()
    return ("/antigravity" in normalized or
            ("/v1beta" in normalized and "/v1beta/openai" not in normalized))


def gemini_native_url(base_url, model):
    normalized = base_url.rstrip("/")
    if normalized.endswith("/antigravity"):
        normalized += "/v1beta"
    if "/models/" in normalized and normalized.endswith(":generateContent"):
        return normalized
    native_model = model.split("/", 1)[-1] if model.startswith("google/") else model
    native_model = urllib.parse.quote(native_model, safe="-._")
    return f"{normalized}/models/{native_model}:generateContent"


def gemini_native_request(messages):
    """把应用内部的 OpenAI 多模态消息转换为 Gemini generateContent 格式。"""
    contents = []
    system_parts = []
    for message in messages:
        role = message.get("role", "user")
        raw_content = message.get("content", "")
        source_parts = ([{"type": "text", "text": raw_content}]
                        if isinstance(raw_content, str) else raw_content)
        parts = []
        for item in source_parts or []:
            kind = item.get("type")
            if kind == "text":
                parts.append({"text": str(item.get("text", ""))})
            elif kind == "image_url":
                url = item.get("image_url", {}).get("url", "")
                match = re.match(r"^data:([^;]+);base64,(.+)$", url, flags=re.S)
                if match:
                    parts.append({"inlineData": {
                        "mimeType": match.group(1), "data": match.group(2)}})
            elif kind == "input_audio":
                audio = item.get("input_audio", {})
                fmt = str(audio.get("format", "mp3")).lower()
                mime = "audio/mpeg" if fmt in ("mp3", "mpeg") else f"audio/{fmt}"
                parts.append({"inlineData": {
                    "mimeType": mime, "data": audio.get("data", "")}})
        if role == "system":
            system_parts.extend(parts)
        elif parts:
            contents.append({"role": "model" if role == "assistant" else "user",
                             "parts": parts})
    body = {
        "contents": contents,
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 32000},
    }
    if system_parts:
        body["systemInstruction"] = {"parts": system_parts}
    return body


def segment_frame_settings(max_frames, segment_count, covered_duration, requested_fps):
    """限制单次最多60帧，并让抽帧均匀覆盖整段而非只截取开头。"""
    # 分段后每次独立请求可使用完整的单请求预算，不能再除以总段数。
    limit = max(1, min(60, int(max_frames or 60)))
    fps = min(requested_fps, limit / covered_duration) if covered_duration else requested_fps
    return limit, fps


def build_messages(prompt_text, ep_num, known_roles, frames, detail, audio_path=None,
                   face_hints=None, anime_mode=False, subtitle_text=""):
    prompt_filled = prompt_text.replace("{ep_num}", str(ep_num)).replace(
        "{known_roles}", known_roles or ""
    )
    tip = ("\n\n下面按时间顺序给出该集的关键帧，每帧前标了时间戳（分:秒）。"
           "请顺着时间线推进，画面没实质变化就不要重复输出同一句台词或△。\n")
    if anime_mode:
        tip += ("这是3D AI动漫画面：不要使用真人人脸相似度判断角色。综合发型、发色、眼睛、"
                "脸型、配饰、体型、服装、出场轨迹、台词称呼和前后剧情。先跨连续画面跟踪同一角色，"
                "再与权威角色表核对；轻微建模漂移、表情变化、镜头光照或换装不能自动新建角色。"
                "同一画面同时出现的两个人绝不能判成同一人。无台词、无单独动作、未推动剧情且只在"
                "人群中短暂出现的模型人物不要写入角色表；证据不足时使用稳定关系称谓并保持一致。\n")
    if audio_path:
        tip += ("另外附上本集完整音频，台词、旁白(VO)、内心独白请以音频为准，"
                "画面用来判断场景、动作和人物。\n")
    elif subtitle_text:
        tip += ("当前模型未接收视频音频。以下是视频字幕，请以字幕内容和时间戳为台词、"
                "旁白及内心独白依据；字幕没有覆盖的声音不要编造。\n")
    else:
        tip += ("当前模型未接收视频音频，且没有可读取的字幕。只记录画面；不要编造台词、"
                "旁白或内心独白。\n")
    if subtitle_text:
        tip += f"\n【本段视频字幕】\n{subtitle_text}\n"
    content = [{"type": "text", "text": prompt_filled + tip}]
    if audio_path:
        content.append({
            "type": "input_audio",
            "input_audio": {"data": b64_file(audio_path), "format": "mp3"},
        })
    for fp, t in frames:
        mm, ss = int(t) // 60, int(t) % 60
        names = (face_hints or {}).get(fp, [])
        identity = f"，本地人物库匹配：{'、'.join(names)}" if names else ""
        content.append({"type": "text", "text": f"【{mm:02d}:{ss:02d}{identity}】"})
        content.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:image/jpeg;base64,{b64_file(fp)}",
                "detail": detail,
            },
        })
    return [{"role": "user", "content": content}]


def curl_post_json(url, api_key, body, proxy, timeout):
    """用系统 curl 发送大体积多模态 JSON。

    macOS Python urllib 在连续上传数 MB base64 时容易 SSL EOF；curl 的 TLS
    实现更稳定。Key 通过 curl 配置 stdin 传入，不出现在进程参数中。
    """
    fd, body_path = tempfile.mkstemp(prefix="pajuben_request_", suffix=".json")
    try:
        os.chmod(body_path, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(body)
        marker = "\n__PAJUBEN_HTTP_STATUS__"
        cmd = [
            "curl", "--silent", "--show-error", "--http1.1",
            "--connect-timeout", "20", "--max-time", str(int(timeout)),
            "--request", "POST", "--header", "Content-Type: application/json",
            "--header", "Expect:", "--data-binary", f"@{body_path}",
            "--write-out", marker + "%{http_code}", "--config", "-", url,
        ]
        if proxy:
            cmd[1:1] = ["--proxy", proxy]
        config = f'header = "Authorization: Bearer {api_key}"\n'
        proc = subprocess.run(
            cmd, input=config, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout + 15)
        if proc.returncode:
            raise urllib.error.URLError(
                proc.stderr.strip() or f"curl 退出码 {proc.returncode}")
        payload, found, status_text = proc.stdout.rpartition(marker)
        if not found:
            raise urllib.error.URLError("接口响应缺少 HTTP 状态")
        try:
            status = int(status_text.strip())
        except ValueError as e:
            raise urllib.error.URLError("接口响应状态无效") from e
        return status, payload
    finally:
        try:
            os.unlink(body_path)
        except OSError:
            pass


def call_api(base_url, api_key, model, messages, proxy, timeout=420, attempts=3,
             max_output_tokens=32000):
    native_gemini = is_gemini_native_base(base_url)
    if native_gemini:
        url = gemini_native_url(base_url, model)
        native_body = gemini_native_request(messages)
        native_body["generationConfig"]["maxOutputTokens"] = max_output_tokens
        body = json.dumps(native_body).encode("utf-8")
    else:
        # 同时兼容用户填写 base（.../api/v1）或完整 endpoint
        #（.../api/v1/chat/completions），避免重复拼接。
        url = chat_completions_url(base_url)
        body = json.dumps({
            "model": model,
            "messages": messages,
            "temperature": 0.3,
            # 该模型强制思考且思考质量对"听音频、守角色表"很关键，所以不砍思考，
            # 而是把总预算给足，让思考+正文都装得下、不被截断
            "max_tokens": max_output_tokens,
            "frequency_penalty": 0.6,
            "presence_penalty": 0.3,
        }).encode("utf-8")

    last_err = None
    # 单次请求最多等 7 分钟、最多尝试 3 次。旧版 900 秒 × 4 次在半断网
    # 状态下会让一集看起来卡住数小时。
    timeout = min(timeout, 420)
    attempts = max(1, int(attempts))
    log(f"  接口：{url}｜模型：{model or '(未指定)'}")
    for attempt in range(attempts):
        waiting = threading.Event()
        def report_waiting():
            elapsed = 0
            while not waiting.wait(60):
                elapsed += 60
                log(f"  模型仍在处理（本次请求已等待 {elapsed // 60} 分钟）…")
        reporter = threading.Thread(target=report_waiting, daemon=True)
        reporter.start()
        try:
            status, payload = curl_post_json(url, api_key, body, proxy, timeout)
            if status >= 400:
                detail = payload.strip()[:2000]
                if status != 429 and status < 500:
                    raise RuntimeError(f"HTTP {status}: {detail or '请求失败'}")
                last_err = RuntimeError(f"HTTP {status}: {detail or '服务暂时不可用'}")
                if attempt < attempts - 1:
                    wait = min(40, 5 * (2 ** attempt))
                    log(f"  服务端限流/繁忙（HTTP {status}），{wait}s 后重试…")
                    time.sleep(wait)
                continue
            if 300 <= status < 400:
                # 网关把路径重写走了（如 307 → /zh-CN/chat/completions）。
                # 重试没有意义，直接把真实地址和重定向目标报出来。
                raise RuntimeError(
                    f"HTTP {status} 重定向：{(payload or '').strip()[:200] or '(无响应体)'}\n"
                    f"    请求地址：{url}\n"
                    f"    说明请求路径不对（base 地址可能缺版本段，如 /v1）")
            data = json.loads(payload)
            if native_gemini:
                candidates = data.get("candidates", [])
                if not candidates:
                    raise RuntimeError("Gemini 没有返回候选内容")
                choice = candidates[0]
                content = "".join(
                    part.get("text", "")
                    for part in choice.get("content", {}).get("parts", [])
                    if isinstance(part, dict))
                if choice.get("finishReason") == "MAX_TOKENS":
                    log("  ⚠ 输出被长度截断（maxOutputTokens 不够），本集可能不完整")
            else:
                choice = data["choices"][0]
                content = choice["message"].get("content")
                if choice.get("finish_reason") == "length":
                    log("  ⚠ 输出被长度截断（max_tokens 不够），本集可能不完整")
            if not isinstance(content, str) or not content.strip():
                raise RuntimeError("模型返回了空内容，请检查模型是否支持图像/音频输入")
            return content
        except json.JSONDecodeError as e:
            # 网关/网页兜底路由回的不是 JSON（最常见：base 少了 /v1、渠道不支持
            # 该模型、或模型名写错）。原样抛 `Expecting value: line 1 column 1`
            # 用户完全看不出问题在哪，这里把状态码、真实地址、响应开头一起报出来。
            head = (payload or "").strip()[:200]
            last_err = RuntimeError(
                f"HTTP {status} 但响应不是 JSON\n"
                f"    请求地址：{url}\n"
                f"    响应开头：{head or '(空响应)'}\n"
                f"    该渠道可能不支持 {model or '这个模型'}，或 base 地址与模型不匹配"
                f"（语言模型需 OpenAI 兼容的 /v1/chat/completions）")
            if attempt < attempts - 1:
                log(f"  响应不是 JSON（HTTP {status}），5s 后重试…")
                time.sleep(5)
        except (urllib.error.URLError, TimeoutError, ConnectionError,
                BrokenPipeError, OSError) as e:
            last_err = e  # Broken pipe / SSL EOF / 超时等网络抖动，重试
            if attempt < attempts - 1:
                log(f"  响应中断，{2*(attempt+1)}s 后重试（{type(e).__name__}）…")
                time.sleep(2 * (attempt + 1))
        finally:
            waiting.set()
    raise last_err


def call_text(base_url, api_key, model, prompt, proxy, timeout=180, attempts=3,
              max_output_tokens=32000):
    """纯文本调用（别名核验用）。"""
    return call_api(base_url, api_key, model,
                    [{"role": "user", "content": prompt}], proxy, timeout,
                    attempts=attempts, max_output_tokens=max_output_tokens)


def preflight_api(S):
    """批量开始前验证真实生成接口，避免错误配置连续毁掉几十集。"""
    log("正在预检当前 API 的鉴权、模型和生成端点…")
    try:
        result = call_text(
            S["base_url"], S["key"], S["model"],
            "这是连通性测试，只回复 OK。", S["proxy"], timeout=45,
            attempts=2, max_output_tokens=16)
    except Exception as error:
        raise RuntimeError(
            f"API 预检失败，已停止整批任务：{error}") from error
    if not result.strip():
        raise RuntimeError("API 预检失败：模型返回空内容")
    log("API 预检通过，开始处理视频。")


# ---------------- 角色表解析/合并 ----------------

VIDEO_EXTS = (".mp4", ".mkv", ".mov", ".avi", ".flv", ".ts", ".m4v", ".wmv")


def parse_roles(script_text):
    """从一集剧本结尾的「角色表」里解析出 {角色名: 身份}。兼容多种排版。"""
    lines = script_text.splitlines()
    # 找最后一个「角色表」标题行
    start = -1
    for i, ln in enumerate(lines):
        if re.sub(r"[#\s\-*]", "", ln).strip() == "角色表":
            start = i
    roles = {}
    if start < 0:
        return roles
    for ln in lines[start + 1:]:
        s = ln.strip().lstrip("-*# ").strip()
        s = s.replace("**", "")
        if not s:
            continue
        m = re.match(r"^(.+?)\s*[:：]\s*(.*)$", s)
        if not m:
            continue
        name = m.group(1).strip()
        ident = m.group(2).strip()
        if not name or name in ("角色名", "角色A", "角色B"):
            continue
        if name not in roles:
            roles[name] = ident
    return roles


def load_master(path):
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return parse_roles("角色表\n" + f.read())


def save_master(path, master):
    with open(path, "w", encoding="utf-8") as f:
        for name, ident in master.items():
            f.write(f"{name}：{ident}\n")


def merge_master(master, new_roles):
    for name, ident in new_roles.items():
        if name not in master:
            master[name] = ident
        elif not master[name] and ident:
            master[name] = ident
    return master


def load_canonical_roles(output_dir):
    """读取用户确认过的人物库；这些姓名是全剧不可改写的角色主键。"""
    path = os.path.join(output_dir, "_人物识别库", "人物库.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    roles = {}
    for role in data.get("roles", []):
        name = str(role.get("name", "")).strip()
        if name:
            roles[name] = str(role.get("identity", "")).strip()
    return roles


def normalize_script(script_text, ep, canonical_names=()):
    """统一模型常见排版差异，并纠正与确认姓名仅一字之差的别名。"""
    text = script_text.replace("**", "")
    # 模型偶尔把输出模板中的占位状态原样带出；占位词没有信息，直接去掉括号。
    text = re.sub(r"[（(](?:状态|说话时可见状态|人物状态|角色状态)[）)](?=\s*[：:])", "", text)
    text = re.sub(r"(?m)^\s*#{0,3}\s*角色表\s*$", "## 角色表", text)
    canonical = tuple(dict.fromkeys(n for n in canonical_names if n))
    if canonical:
        candidates = set(parse_roles(text))
        candidates.update(re.findall(r"(?m)^人物[：:]\s*([^\n]+)$", text))
        candidates.update(re.findall(r"(?m)^([^#△\s][^：:\n]{1,8})[：:]", text))
        expanded = set()
        for candidate in candidates:
            expanded.update(x.strip() for x in re.split(r"[、,，/]", candidate))
        aliases = {}
        for alias in expanded:
            alias = re.sub(r"（.*?）|\(.*?\)", "", alias).strip()
            if alias in canonical or len(alias) < 2:
                continue
            matches = [name for name in canonical
                       if len(name) == len(alias)
                       and sum(a != b for a, b in zip(name, alias)) == 1]
            if len(matches) == 1:
                aliases[alias] = matches[0]
        for alias, name in sorted(aliases.items(), key=lambda x: -len(x[0])):
            text = text.replace(alias, name)
    return text.strip() + "\n"


def apply_verified_aliases(cleaned, out_dir, canonical_roles):
    """把核验表中的别名映射真正回写到逐集剧本，而不只生成一份参考表。"""
    canonical = set(canonical_roles or {})
    mapping = {}
    for line in cleaned.splitlines():
        head = re.split(r"[:：]", line, maxsplit=1)[0].strip().lstrip("-* ")
        m = re.match(r"^(.+?)[（(]=(.+?)[）)]$", head)
        if not m:
            continue
        primary = m.group(1).strip()
        aliases = [x.strip() for x in re.split(r"[,，、]", m.group(2)) if x.strip()]
        target = next((x for x in [primary, *aliases] if x in canonical), primary)
        for alias in [primary, *aliases]:
            if alias and alias != target:
                mapping[alias] = target
    if not mapping:
        return 0
    changed = 0
    for name in os.listdir(out_dir):
        m = re.match(r"^第(\d+)集\.txt$", name)
        if not m:
            continue
        path = os.path.join(out_dir, name)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        updated = text
        for alias, target in sorted(mapping.items(), key=lambda x: -len(x[0])):
            updated = updated.replace(alias, target)
        updated = normalize_script(updated, int(m.group(1)), canonical)
        if updated != text:
            with open(path, "w", encoding="utf-8") as f:
                f.write(updated)
            changed += 1
    return changed


def master_to_known(master):
    if not master:
        return ""
    body = "\n".join(f"{n}：{i}" for n, i in master.items())
    return (
        "\n【权威角色主键】下列姓名是用户确认过的全剧统一名称。"
        "画面时间戳若标注了其中姓名，正文说话人、人物行和结尾角色表都必须使用该姓名；"
        "即使音频里出现昵称、错字或其他称呼，也不得另建同一人物。"
        "只有确定是新人物时才能补充新名字：\n" + body + "\n")


def is_complete(script_text):
    """结尾有角色表才算扒完整。"""
    return bool(parse_roles(script_text))


def output_ok(out_path, overwrite):
    if overwrite or not os.path.exists(out_path):
        return False
    try:
        with open(out_path, "r", encoding="utf-8") as f:
            return is_complete(f.read())
    except Exception:
        return False


# ---------------- 单集处理（供单集/批量共用） ----------------

SCENE_RE = re.compile(r"^\s*(\d+)\s*-\s*(\d+)\s*场", re.M)


def last_scene_no(text):
    """返回文本中最后出现的场号（{ep}-{n}场 里的 n），没有则返回 0。"""
    ms = SCENE_RE.findall(text)
    return int(ms[-1][1]) if ms else 0


def fmt_ts(t):
    return f"{int(t) // 60:02d}:{int(t) % 60:02d}"


def segment_tip(ep, k, m, start, end, prev_text=""):
    """多段扒取时追加在提示词后面的分段说明。单段返回空串。"""
    if m <= 1:
        return ""
    tip = (f"\n\n【分段说明】本集较长，分{m}段扒取。当前是第{k}/{m}段"
           f"（{fmt_ts(start)}–{fmt_ts(end)}），只扒这一段范围内的画面和声音。\n")
    if k < m:
        tip += "这一段不是本集结尾：写到本段最后一个画面即止，结尾不要输出角色表。\n"
    else:
        tip += "这是本集最后一段：结尾按要求输出角色表（含本集所有段落出现过的角色）。\n"
    if k > 1 and prev_text:
        prev_scene = last_scene_no(prev_text)
        tail = "\n".join(prev_text.rstrip().splitlines()[-15:])
        tip += (f"前面段落已扒到第{ep}-{prev_scene}场，结尾摘录如下"
                "（仅供衔接参考，禁止重复输出其中内容）：\n"
                f"----\n{tail}\n----\n"
                f"衔接规则：不要再输出「# 第{ep}集」标题。若本段开头画面仍在上一场同一地点，"
                f"直接接着写台词和△（不写场次标题行）；若切到新地点，"
                f"新开第{ep}-{prev_scene + 1}场，编号从此顺延。\n")
    return tip


def stitch_segments(parts, ep):
    """把各段输出按顺序拼成整集剧本，去掉非首段重复的大标题。"""
    if len(parts) == 1:
        return parts[0]
    out = [parts[0].rstrip()]
    for p in parts[1:]:
        p = re.sub(rf"^\s*#\s*第\s*{ep}\s*集\s*\n+", "", p.strip())
        out.append(p)
    return "\n\n".join(out) + "\n"


def process_video(S, video, ep, known_roles):
    """扒一集，返回剧本文本。S 是配置字典。长视频自动分段扒取再拼接。"""
    duration = probe_duration(video)
    segments = plan_segments(duration, S["fps"], S["max_frames"], S["max_segments"])
    m = len(segments)
    if m > 1:
        log(f"  第{ep}集 时长 {duration:.0f}s，分 {m} 段扒取"
            f"（段内 {segments[0][2]:.3g} fps）")
    known = ""
    if known_roles:
        known = known_roles if known_roles.startswith("\n") else (
            f"\n已知角色表（角色名必须用这里的名字）：\n{known_roles}\n")
    subtitle_cues, subtitle_source = load_video_subtitles(video)
    if subtitle_source:
        log(f"  第{ep}集 已读取字幕：{subtitle_source}")
    elif not S["want_audio"]:
        log(f"  第{ep}集 未找到外挂或内嵌字幕，将只根据画面记录")
    parts = []
    for k, (start, seg_dur, eff_fps) in enumerate(segments, 1):
        base = 90.0 * (k - 1) / m
        seg_tag = f"段{k}/{m} " if m > 1 else ""
        ep_progress(ep, 5 + base, seg_tag + "抽帧中…")
        workdir = tempfile.mkdtemp(prefix="pajuben_")
        try:
            # max_frames 是整集预算，不应在每一段重复使用。旧版两段视频会
            # 实际发送最多 240 帧，导致请求巨大、网络超时。
            covered_duration = seg_dur or duration
            segment_frame_limit, eff_fps = segment_frame_settings(
                S["max_frames"], m, covered_duration, eff_fps)
            frames = extract_frames(video, eff_fps, S["longedge"], segment_frame_limit,
                                    workdir, start, seg_dur)
            face_hints = {}
            if identify_frames and S.get("output_dir") and S.get("want_face", True):
                try:
                    face_hints = identify_frames(
                        frames, S["output_dir"], workdir,
                        anime_mode=S.get("anime_mode", False))
                    matched = sorted({n for names in face_hints.values() for n in names})
                    if matched:
                        log(f"  第{ep}集 本地人物识别：{'、'.join(matched)}")
                except Exception as e:
                    log(f"  ⚠ 第{ep}集 人物识别跳过：{e}")
            audio_path = (extract_audio(video, workdir, start, seg_dur)
                          if S["want_audio"] else None)
            end = start + seg_dur if seg_dur else duration
            subtitle_text = subtitles_for_segment(subtitle_cues, start, seg_dur, duration)
            prompt = S["prompt_text"] + segment_tip(ep, k, m, start, end,
                                                    parts[-1] if parts else "")
            messages = build_messages(prompt, ep, known, frames, S["res"], audio_path,
                                      face_hints, S.get("anime_mode", False), subtitle_text)
            if m > 1:
                log(f"  第{ep}集 段 {k}/{m}（{fmt_ts(start)}–{fmt_ts(end)}）调用模型…")
            ep_progress(ep, 15 + base, seg_tag + "调用模型…")
            part = call_api(
                S["base_url"], S["key"], S["model"], messages, S["proxy"],
                timeout=S["request_timeout"], attempts=S["request_attempts"])
            # 一些中转渠道无视 max_tokens 并在很短的输出上限处截断。保留
            # 原始多模态上下文，让模型从截断处续写，比整集重新抽帧更可靠。
            part = continue_truncated_script(S, messages, part, ep, seg_tag)
            parts.append(part)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
    ep_progress(ep, 98, "整理输出…")
    return stitch_segments(parts, ep)


MAX_SCRIPT_CONTINUATIONS = 3


def continue_truncated_script(S, source_messages, script_text, ep, segment_label=""):
    """遇到渠道输出上限时，带着同一份视频上下文续写到角色表为止。

    `max_tokens` 在 OpenAI 兼容中转上并不总会生效；此前单集任务会把“留”
    这种半句话直接写成最终剧本。续写使用 assistant 历史消息，因此模型既看得到
    已输出的内容，也仍能访问原始音频和关键帧。
    """
    result = script_text.strip()
    for index in range(MAX_SCRIPT_CONTINUATIONS):
        if is_complete(result):
            return result
        log(f"  ⚠ 第{ep}集 {segment_label}输出被截断，正在续写（{index + 1}/{MAX_SCRIPT_CONTINUATIONS}）…")
        continuation = list(source_messages)
        continuation.append({"role": "assistant", "content": result})
        continuation.append({
            "role": "user",
            "content": (
                "上一段剧本因输出长度限制在中途截断。请从最后一个未完成的句子接着写，"
                "不要重复已经输出的内容；继续按原格式覆盖后续时间线，最后必须输出完整“角色表”。"
            ),
        })
        addition = call_api(
            S["base_url"], S["key"], S["model"], continuation, S["proxy"],
            timeout=S["request_timeout"], attempts=S["request_attempts"])
        addition = addition.strip()
        if not addition:
            break
        result = f"{result}\n{addition}"
    return result


def process_video_checked(S, video, ep, known_roles):
    """扒一集并校验完整性（结尾必须有角色表）。"""
    result = process_video(S, video, ep, known_roles)
    if is_complete(result):
        return result
    raise RuntimeError("剧本输出被截断：已自动续写和重试，仍缺少结尾角色表。请更换支持更长输出的模型或渠道后重试。")


FALLBACK_ERROR_MARKERS = (
    "timed out", "timeout", "urlerror", "remotedisconnected",
    "connectionreset", "broken pipe", "http 400", "parsing request",
)


def should_use_dual_fallback(error):
    """只对媒体解析、超时和连接异常降级；鉴权/余额等错误直接上报。"""
    text = f"{type(error).__name__}: {error}".lower()
    audio_markers = (
        "未收到音频", "没有音频", "未提供音频", "请补充音频",
        "无法生成完整台词", "input_audio", "audio input", "audio modality",
        "does not support audio", "unsupported audio",
    )
    return any(marker in text for marker in FALLBACK_ERROR_MARKERS) or any(
        marker.lower() in text for marker in audio_markers
    )


def run_dual_fallback(S, video, ep, out_dir, roles_file):
    """调用可断点续跑的双模型脚本，返回最终剧本文本。"""
    script = os.path.join(HERE, "dual_model_test.py")
    if not os.path.exists(script):
        raise RuntimeError("找不到双模型降级脚本 dual_model_test.py")
    cache_dir = os.path.join(out_dir, "_双模型中间文件", f"第{ep}集")
    os.makedirs(cache_dir, exist_ok=True)
    native_gemini = is_gemini_native_base(S["base_url"])
    # 原生 Gemini 单模型可以同时听声和看图；快速入口的 --dual-only 则明确
    # 使用前端挑出的同渠道音频模型和视觉模型，不能再被当前选中模型覆盖。
    use_single_native_model = native_gemini and not S.get("force_dual", False)
    audio_model = S["model"] if use_single_native_model else S["dual_audio_model"]
    vision_model = S["model"] if use_single_native_model else S["dual_vision_model"]
    if not audio_model or not vision_model:
        raise RuntimeError(
            "当前模型不支持音频输入，且当前渠道没有配置可用的音频模型（例如 Gemini）。"
            "请在同一渠道加入 Gemini 或支持音频输入的模型后重试"
        )
    cmd = [sys.executable, "-u", script, video, "--ep", str(ep),
           "--base", S["base_url"],
           "--audio-model", audio_model,
           "--vision-model", vision_model,
           "--output-dir", cache_dir]
    if roles_file:
        cmd += ["--roles-file", roles_file]
    env = os.environ.copy()
    env["PAJUBEN_API_KEY"] = S["key"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1, env=env)
    # 整集双模型最多运行45分钟。到时终止该集，批处理会记录失败并继续，
    # 下次运行可复用已经落盘的听写/画面批次，从断点接着做。
    expired = threading.Event()
    def stop_stalled_worker():
        if proc.poll() is None:
            expired.set()
            proc.terminate()
    watchdog = threading.Timer(45 * 60, stop_stalled_worker)
    watchdog.daemon = True
    watchdog.start()
    try:
        for line in proc.stdout:
            log(f"  [双模型] {line.rstrip()}")
        code = proc.wait()
    finally:
        watchdog.cancel()
    if expired.is_set():
        raise RuntimeError("双模型整集处理超过45分钟，已停止；下次将从缓存断点续跑")
    final_path = os.path.join(cache_dir, f"第{ep}集_双模型.txt")
    if code != 0 or not os.path.exists(final_path):
        raise RuntimeError(f"双模型降级失败（退出码 {code}）")
    with open(final_path, "r", encoding="utf-8") as f:
        result = f.read()
    if not result.strip():
        raise RuntimeError("双模型降级返回空结果")
    return result


def collect_episodes(folder):
    """返回 [(ep号, 视频路径), ...]，按集号排序、去重（同集号优先非"压缩"版）。"""
    by_ep = {}
    for name in os.listdir(folder):
        if not name.lower().endswith(VIDEO_EXTS):
            continue
        path = os.path.join(folder, name)
        ep = guess_ep(path)
        # 同一集号取更"正规"的文件名（不含压缩/副本、名字更短）
        if ep not in by_ep:
            by_ep[ep] = (name, path)
        else:
            old_name = by_ep[ep][0]
            def score(n):
                return ("压缩" in n) * 100 + ("副本" in n) * 100 + len(n)
            if score(name) < score(old_name):
                by_ep[ep] = (name, path)
    eps = [(ep, p) for ep, (n, p) in by_ep.items()]
    eps.sort(key=lambda x: x[0])
    return eps


def run_batch(S, folder, seed_n, overwrite, do_verify, ep_from=None, ep_to=None,
              limit=None, output_dir=None):
    out_dir = (os.path.abspath(output_dir) if output_dir else
               os.path.join(os.path.abspath(folder), "剧本"))
    os.makedirs(out_dir, exist_ok=True)
    S["output_dir"] = out_dir
    master_path = os.path.join(out_dir, "_主角色表.txt")

    episodes = collect_episodes(folder)
    if ep_from is not None:
        episodes = [e for e in episodes if e[0] >= ep_from]
    if ep_to is not None:
        episodes = [e for e in episodes if e[0] <= ep_to]
    if limit:
        episodes = episodes[:limit]
    if not episodes:
        sys.exit(f"错误：{folder} 里没找到（符合范围的）视频文件")
    log(f"本次处理 {len(episodes)} 集：{', '.join(str(e) for e, _ in episodes)}")
    preflight_api(S)

    # 只有成功和已存在的完整结果才计入完成进度；失败会单独标红。
    total = len(episodes)
    done_n = [0]
    prog_lock = threading.Lock()

    def bump():
        with prog_lock:
            done_n[0] += 1
            progress(done_n[0], total)

    progress(0, total)

    master = load_master(master_path)
    canonical_roles = load_canonical_roles(out_dir)
    if canonical_roles:
        # 人工确认库优先级高于模型历史输出。
        for name, identity in canonical_roles.items():
            master[name] = identity or master.get(name, "")
        save_master(master_path, master)
        log(f"已载入人工确认角色主键 {len(canonical_roles)} 人")
    if master:
        log(f"已载入主角色表 {len(master)} 人")
    master_lock = threading.Lock()
    failed_episodes = []

    def out_path_for(ep):
        return os.path.join(out_dir, f"第{ep}集.txt")

    def normalize_existing(ep):
        path = out_path_for(ep)
        with open(path, encoding="utf-8") as f:
            old = f.read()
        updated = normalize_script(old, ep, canonical_roles)
        if updated != old:
            with open(path, "w", encoding="utf-8") as f:
                f.write(updated)
        return updated

    def do_one(ep, video, tag, known):
        t0 = time.time()
        log(f"  [{tag}] 第{ep}集 扒取中…")
        try:
            result = process_video_checked(S, video, ep, known)
        except Exception as e:
            if not S["dual_fallback"] or not should_use_dual_fallback(e):
                raise
            log(f"  ⚠ 第{ep}集 单模型失败：{e}")
            log(f"  ↳ 自动切换双模型：音频听写 + 24帧分批视觉 + 时间戳合并")
            ep_progress(ep, 5, "单模型失败，切换双模型…")
            result = run_dual_fallback(S, video, ep, out_dir, master_path)
            ep_progress(ep, 98, "双模型完成，保存输出…")
        result = normalize_script(result, ep, canonical_roles)
        if not is_complete(result):
            raise RuntimeError("输出结构不完整：缺少可解析的角色表")
        with open(out_path_for(ep), "w", encoding="utf-8") as f:
            f.write(result)
        with master_lock:
            merge_master(master, parse_roles(result))
            save_master(master_path, master)
            count = len(master)
        log(f"  [{tag}] 第{ep}集 完成 {time.time()-t0:.0f}s，主角色表累计 {count} 人")

    # 阶段一：种子集，顺序跑，边跑边建主角色表
    seeds = episodes[:seed_n]
    log(f"\n=== 阶段一：种子集建主角色表（前 {len(seeds)} 集）===")
    for ep, video in seeds:
        if output_ok(out_path_for(ep), overwrite):
            merge_master(master, parse_roles(normalize_existing(ep)))
            save_master(master_path, master)
            log(f"  第{ep}集 已扒过，跳过（角色并入主表，累计 {len(master)} 人）")
            bump()
            continue
        try:
            do_one(ep, video, "种子", master_to_known(master))
        except Exception as e:
            log(f"  ⚠ 第{ep}集 失败：{e}")
            failed_episodes.append(ep)
            ep_failed(ep, e)
        else:
            ep_done(ep)
            bump()

    # 阶段二：其余集，全部套用主角色表，多线程并发
    rest = episodes[seed_n:]
    workers = max(1, S["workers"])
    log(f"\n=== 阶段二：批量扒取其余 {len(rest)} 集"
        f"（套用统一角色名，最多 {workers} 路并发）===")
    todo = []
    for ep, video in rest:
        if output_ok(out_path_for(ep), overwrite):
            normalize_existing(ep)
            log(f"  第{ep}集 已扒过，跳过")
            bump()
        else:
            todo.append((ep, video))
    known_snapshot = master_to_known(master)
    if todo:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(do_one, ep, video, "批量", known_snapshot): ep
                    for ep, video in todo}
            try:
                for fut in as_completed(futs):
                    ep = futs[fut]
                    try:
                        fut.result()
                    except Exception as e:
                        log(f"  ⚠ 第{ep}集 失败：{e}")
                        failed_episodes.append(ep)
                        ep_failed(ep, e)
                    else:
                        ep_done(ep)
                        bump()
            except KeyboardInterrupt:
                log("\n收到中止，等待进行中的集收尾（未开始的已取消）…")
                pool.shutdown(cancel_futures=True)
                raise

    # 阶段三：别名核验 + 合并全集
    if do_verify and master:
        log("\n=== 阶段三：别名核验 ===")
        try:
            verify_aliases(S, master, master_path, out_dir, canonical_roles)
            audit_script_consistency(S, out_dir, canonical_roles or {})
        except Exception as e:
            log(f"  ⚠ 别名核验失败：{e}")

    merged = merge_all_scripts(out_dir, folder)
    if failed_episodes:
        failed_text = "、".join(str(ep) for ep in sorted(set(failed_episodes)))
        log(f"\n⚠ 批量未完成，失败 {len(set(failed_episodes))} 集：{failed_text}")
        raise RuntimeError(f"仍有失败集：{failed_text}")
    log(f"\n✅ 批量完成。主角色表：{master_path}")
    if merged:
        log(f"   全集剧本：{merged}")


def verify_aliases(S, master, master_path, out_dir, canonical_roles=None):
    body = "\n".join(f"{n}：{i}" for n, i in master.items())
    canonical_tip = ""
    if canonical_roles:
        canonical_tip = (
            "\n下面是用户人工确认的角色主键。若别名与其中人物是同一个人，"
            "必须以这里的姓名作为主名，把其他称呼放在（=别名）里：\n" +
            "\n".join(f"{n}：{i}" for n, i in canonical_roles.items()) + "\n")
    prompt = (
        "下面是同一部短剧逐集扒出来的角色表，可能同一个人被记成了不同名字"
        "（比如「黄明秀」和「卢庆林妻子」其实是一个人）。请你归并同一人，"
        "输出一份干净的最终角色表，每行「角色名：身份」，"
        "并在能确定的别名后用（=别名1,别名2）标注。只输出角色表，别的都不要。\n\n"
        f"{canonical_tip}\n待核验角色表：\n{body}"
    )
    cleaned = call_text(S["base_url"], S["key"], S["model"], prompt, S["proxy"])
    vp = os.path.join(out_dir, "角色表_核验.txt")
    with open(vp, "w", encoding="utf-8") as f:
        f.write(cleaned)
    log(f"  已输出核验角色表：{vp}")
    changed = apply_verified_aliases(cleaned, out_dir, canonical_roles or {})
    if changed:
        log(f"  已按核验别名统一回写 {changed} 集剧本")
        rebuilt = dict(canonical_roles or {})
        for name in os.listdir(out_dir):
            if re.match(r"^第\d+集\.txt$", name):
                with open(os.path.join(out_dir, name), encoding="utf-8") as f:
                    merge_master(rebuilt, parse_roles(f.read()))
        master.clear()
        master.update(rebuilt)
        save_master(master_path, master)


def audit_script_consistency(S, out_dir, canonical_roles):
    """完成全剧后做一次保守的逻辑审校；原稿备份，只有明确建议才写修正版。"""
    files = sorted((int(m.group(1)), os.path.join(out_dir, n))
                   for n in os.listdir(out_dir)
                   if (m := re.match(r"^第(\d+)集\.txt$", n)))
    if not files:
        return
    role_text = []
    for ep, path in files:
        with open(path, encoding="utf-8") as stream:
            text = stream.read()
        role_text.append(f"第{ep}集角色表：\n{text.split('## 角色表', 1)[-1][:1800]}")
    prompt = (
        "你是短剧剧本一致性审校员。下面是同一部剧的逐集角色表。只找扒取错误："
        "同一个明确人物被写成多个名字、角色身份明显前后矛盾、对白说话人标签明显错位。"
        "剧情中的化名、假身份、反转和故意隐瞒不是错误。证据不足就不要修正。"
        "只返回JSON数组，每项：{\"from\":\"错误写法\",\"to\":\"明确写法\","
        "\"reason\":\"跨集证据\",\"episodes\":[1,2],\"confidence\":0.0}。"
        "confidence必须>=0.97才允许自动修正，且from/to不能相同。\n"
        + "\n\n".join(role_text))
    result = call_text(S["base_url"], S["key"], S["model"], prompt, S["proxy"])
    try:
        start, end = result.find("["), result.rfind("]")
        fixes = json.loads(result[start:end + 1]) if start >= 0 and end > start else []
    except (ValueError, json.JSONDecodeError):
        fixes = []
    fixes = [x for x in fixes if isinstance(x, dict) and float(x.get("confidence", 0) or 0) >= 0.97
             and x.get("from") and x.get("to") and x["from"] != x["to"]]
    report = os.path.join(out_dir, "全剧逻辑审校报告.json")
    with open(report, "w", encoding="utf-8") as stream:
        json.dump({"fixes": fixes, "episodes": [ep for ep, _ in files]},
                  stream, ensure_ascii=False, indent=2)
    if not fixes:
        log("  全剧逻辑审校：未发现有足够证据的错误")
        return
    backup_dir = os.path.join(out_dir, "原稿备份_逻辑审校")
    os.makedirs(backup_dir, exist_ok=True)
    changed = 0
    for ep, path in files:
        with open(path, encoding="utf-8") as stream:
            text = stream.read()
        updated = text
        for fix in fixes:
            if not fix.get("episodes") or ep in fix["episodes"]:
                updated = updated.replace(str(fix["from"]), str(fix["to"]))
        if updated != text:
            shutil.copy2(path, os.path.join(backup_dir, os.path.basename(path)))
            with open(path, "w", encoding="utf-8") as stream:
                stream.write(updated)
            changed += 1
    log(f"  全剧逻辑审校：{len(fixes)} 条高置信修正，已更新 {changed} 集；原稿保存在 {backup_dir}")


def merge_all_scripts(out_dir, folder):
    files = []
    for name in os.listdir(out_dir):
        m = re.match(r"^第(\d+)集\.txt$", name)
        if m:
            files.append((int(m.group(1)), os.path.join(out_dir, name)))
    if not files:
        return None
    files.sort()
    title = os.path.basename(os.path.abspath(folder))
    merged_path = os.path.join(out_dir, f"{title}全集剧本.txt")
    with open(merged_path, "w", encoding="utf-8") as out:
        for ep, path in files:
            with open(path, "r", encoding="utf-8") as f:
                out.write(f.read().rstrip() + "\n\n")
    return merged_path


def build_settings(args, cfg):
    same_provider_fallback = args.provider != "volcano"
    return {
        "base_url": args.base or PROVIDERS[args.provider],
        "key": args.key.strip(),
        "model": args.model,
        "proxy": args.proxy,
        "fps": args.fps,
        "res": args.res,
        "longedge": RES_LONGEDGE[args.res],
        "max_frames": args.max_frames,
        "max_segments": args.max_segments,
        "workers": args.workers,
        "request_timeout": args.request_timeout,
        "request_attempts": args.request_attempts,
        "want_audio": args.audio or (cfg.get("send_audio", True) and not args.no_audio),
        "dual_fallback": not args.no_dual_fallback,
        # 普通工作台任务保持历史行为：同渠道默认沿用当前模型。
        # 画布快速模式传 --dual-only 时，必须保留前端传入的音频/视觉模型，
        # 否则 gpt-6-astra 这类普通模型会再次被当成音频模型调用。
        "dual_audio_model": (
            args.dual_audio_model
            if args.dual_only and args.dual_audio_model
            else args.model if same_provider_fallback else args.dual_audio_model
        ),
        "dual_vision_model": (
            args.dual_vision_model
            if args.dual_only and args.dual_vision_model
            else args.model if same_provider_fallback else args.dual_vision_model
        ),
        "force_dual": bool(args.dual_only),
        "anime_mode": bool(args.anime_mode),
        "want_face": not args.no_face,
        "prompt_text": load_prompt() + (
            "\n\n【3D AI动漫识别模式】请按多帧角色轨迹、稳定造型特征、对白称呼与剧情上下文"
            "统一人物，不依赖真人人脸相似度；过滤无台词且不影响剧情的背景模型。"
            if args.anime_mode else ""),
    }


def main():
    cfg = load_config()
    ap = argparse.ArgumentParser(description="扒剧本 CLI")
    ap.add_argument("target", help="视频文件路径，或（配 --batch）视频文件夹路径")
    ap.add_argument("--batch", action="store_true", help="批量：target 当文件夹，整部剧一起扒")
    ap.add_argument("--seed", type=int, default=cfg.get("seed", 3),
                    help="种子集数：先顺序跑前 N 集建统一主角色表（默认3）")
    ap.add_argument("--overwrite", action="store_true", help="覆盖已扒过的集")
    ap.add_argument("--no-verify", action="store_true", help="批量结尾跳过别名核验")
    ap.add_argument("--from", dest="ep_from", type=int, help="批量：只扒从第几集起")
    ap.add_argument("--to", dest="ep_to", type=int, help="批量：只扒到第几集止")
    ap.add_argument("--limit", type=int, help="批量：最多扒几集（先小范围试跑用）")
    ap.add_argument("--output-dir", help="输出目录（默认是视频旁的“剧本”文件夹）")
    ap.add_argument("--ep", type=int, help="集号（单集用，默认从文件名猜）")
    ap.add_argument("--provider", default=cfg.get("provider", "zhipu"),
                    choices=list(PROVIDERS.keys()))
    # 密钥优先用命令行，其次环境变量：桌面端用环境变量传递，
    # 避免密钥出现在进程参数列表里被同机其他进程读到。
    ap.add_argument("--key",
                    default=cfg.get("api_key", "") or os.environ.get("PAJUBEN_API_KEY", ""),
                    help="API 密钥（也可用 PAJUBEN_API_KEY 环境变量传入）")
    ap.add_argument("--model", default=cfg.get("model", ""))
    ap.add_argument("--base", default=cfg.get("base_url", ""),
                    help="自定义/中转 base_url（覆盖 provider 默认）")
    ap.add_argument("--proxy", default=cfg.get("proxy", ""))
    ap.add_argument("--fps", type=float, default=cfg.get("fps", 1))
    ap.add_argument("--res", default=cfg.get("resolution", "low"),
                    choices=list(RES_LONGEDGE.keys()))
    ap.add_argument("--max-frames", type=int, default=cfg.get("max_frames", 120))
    ap.add_argument("--max-segments", type=int, default=cfg.get("max_segments", 4),
                    help="长视频最多分几段扒取（默认4；超出后段内降帧率）")
    ap.add_argument("--workers", type=int, default=cfg.get("workers", 3),
                    help="批量阶段二并发数（默认3）")
    ap.add_argument("--request-timeout", type=int,
                    default=cfg.get("request_timeout", 420),
                    help="单次模型请求最长等待秒数（默认420）")
    ap.add_argument("--request-attempts", type=int,
                    default=cfg.get("request_attempts", 3),
                    help="单次模型请求最多尝试次数（默认3）")
    ap.add_argument("--roles", default="", help="已知角色表文本（单集用，填入 {known_roles}）")
    ap.add_argument("--no-audio", action="store_true",
                    help="不送音频（默认送；仅对能听声的模型有意义）")
    ap.add_argument("--anime-mode", action="store_true",
                    default=cfg.get("anime_mode", False),
                    help="3D AI动漫人物识别：使用造型、轨迹和剧情上下文")
    ap.add_argument("--no-face", action="store_true",
                    help="关闭本地人物识别（仅按画面、台词与剧情判断角色）")
    ap.add_argument("--audio", action="store_true",
                    help="强制发送音频（覆盖 config.json 中关闭音频的设置）")
    ap.add_argument("--no-dual-fallback", action="store_true",
                    help="单模型超时/解析失败时不自动切换双模型")
    ap.add_argument("--dual-only", action="store_true",
                    help="跳过单模型音频请求，直接使用音频模型听写 + 视觉模型合并")
    ap.add_argument("--dual-audio-model",
                    default=cfg.get("dual_audio_model", "doubao-seed-2-0-lite-260428"),
                    help="自动降级时使用的音频模型")
    ap.add_argument("--dual-vision-model",
                    default=cfg.get("dual_vision_model", "doubao-seed-2-1-pro-260628"),
                    help="自动降级时使用的视觉及合并模型")
    args = ap.parse_args()

    if not shutil.which("ffmpeg"):
        sys.exit("错误：找不到 ffmpeg，请先安装（brew install ffmpeg）")
    if not os.path.exists(args.target):
        sys.exit(f"错误：路径不存在：{args.target}")
    if not args.key or args.key == "在这里填你的APIKEY":
        sys.exit("错误：没有 API key。请设置 PAJUBEN_API_KEY，或用 --key 临时传入")
    if not args.model:
        sys.exit("错误：没有 model。改 config.json 或用 --model 传入")

    S = build_settings(args, cfg)
    # base_url 被显式覆盖时 provider 只是占位（桌面端总是传自定义 base），
    # 直接标「自定义」，避免出现与实际不符的「渠道 zhipu」这类提示。
    provider_label = (args.provider
                      if S["base_url"] == PROVIDERS.get(args.provider) else "自定义")
    log(f"渠道 {provider_label} | 模型 {args.model} | fps {args.fps} | {args.res} | "
        f"听声 {'开' if S['want_audio'] else '关'}")
    log(f"人物模式 {'3D AI动漫' if S['anime_mode'] else '真人'}")
    log(f"base_url {S['base_url']}")

    # 批量模式
    if args.batch or os.path.isdir(args.target):
        if not os.path.isdir(args.target):
            sys.exit("错误：--batch 需要传文件夹路径")
        try:
            run_batch(S, args.target, args.seed, args.overwrite, not args.no_verify,
                      args.ep_from, args.ep_to, args.limit, args.output_dir)
        except KeyboardInterrupt:
            sys.exit("\n已取消。已完成的剧本会保留，下次运行将自动跳过。")
        return

    # 单集模式
    ep = args.ep if args.ep else guess_ep(args.target)
    t0 = time.time()
    log(f"集号 {ep}")
    progress(0, 1)
    out_dir = (os.path.abspath(args.output_dir) if args.output_dir else
               os.path.join(os.path.dirname(os.path.abspath(args.target)), "剧本"))
    os.makedirs(out_dir, exist_ok=True)
    S["output_dir"] = out_dir
    try:
        log("处理中（抽帧+听声+调模型）…")
        if S["force_dual"]:
            log(f"直接使用双模型：音频 {S['dual_audio_model']}｜画面与合并 {S['dual_vision_model']}")
            result = run_dual_fallback(S, args.target, ep, out_dir, "")
        else:
            result = process_video_checked(S, args.target, ep, args.roles)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")
        sys.exit(f"\n❌ API 报错 HTTP {e.code}：{detail[:500]}")
    except subprocess.CalledProcessError:
        sys.exit("\n❌ ffmpeg 处理失败，检查视频文件")
    except KeyboardInterrupt:
        sys.exit("\n已取消")
    except Exception as e:
        if S["dual_fallback"] and should_use_dual_fallback(e):
            log(f"\n⚠ 单模型失败：{e}")
            log("↳ 自动切换双模型…")
            try:
                result = run_dual_fallback(S, args.target, ep, out_dir, "")
            except Exception as dual_error:
                sys.exit(f"\n❌ 单模型与双模型均失败：{dual_error}")
        else:
            sys.exit(f"\n❌ 处理失败：{e}")

    out_path = os.path.join(out_dir, f"第{ep}集.txt")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(result)
    ep_done(ep)
    progress(1, 1)

    log(f"\n✅ 完成，用时 {time.time()-t0:.0f}s")
    log(f"   已保存：{out_path}")
    log("\n---- 预览 ----")
    log(result[:800] + ("\n…（更多见文件）" if len(result) > 800 else ""))


if __name__ == "__main__":
    main()
