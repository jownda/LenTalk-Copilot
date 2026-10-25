#!/usr/bin/env python3
"""单集两步扒片：画面识别 + 音频识别 → 合并成剧情剧本。

为什么拆成两步：
- 只有原生 Gemini 这类「一个请求里同时吃图 + 吃音频」的模型能一次做完，
  其它普通多模态模型收到 input_audio 会直接报错或返回一段「请提供音频」；
- 拆开之后，画面交给任意能看图的视觉模型，台词与音效交给任意能听声的音频
  模型，两个模型还可以来自不同渠道（各自的 base_url / key）。

两段互不依赖，所以**并行跑**（画面批次再并发 2 路），最后一步合并才汇合；
任何一段失败会立刻掐断另一段在途的请求，不必等对方超时。

每段失败都带上「是哪个阶段、哪个模型、什么原因」，避免用户只看到一句
「双模型失败（退出码 1）」。
"""

import argparse
import base64
import os
import re
import shutil
import sys
import tempfile
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor

# 随包运行时是 Python embeddable 版（同目录带 python312._pth）：sys.path 完全由
# _pth 决定，**不含脚本所在目录**（隔离模式下 PYTHONPATH 也无效）。于是这里
# `import pajuben` 直接 ModuleNotFoundError，进程以退出码 1 结束、一行 ❌ 都不打印，
# 父层只能报「双模型引擎异常退出（退出码 1）」。
# 入口脚本 pajuben.py 不受影响（它自己就是脚本路径），所以症状是：工作台单模型
# 能跑，画布「扒视频」强制走双模型则必失败。
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import pajuben  # noqa: E402  —— 必须在 sys.path 补好之后

# 单集最多送多少帧给视觉模型。帧越多越完整，但请求体积、耗时和费用同步上升；
# 120 帧 = 5 个批次（每批 24 帧），够覆盖 1–3 分钟的短剧，也不会让一集跑上半小时。
# 画质档位只能在这个上限内调密度：快速档 fps=1 大约 90 帧，标准/精细档到此为止。
FRAME_BUDGET_CAP = 120
FRAME_BATCH = 24

STAGE_LABEL = {
    "audio": "音频识别",
    "vision": "画面识别",
    "merge": "剧情合并",
}


class StageFailure(RuntimeError):
    """某个阶段失败：带上阶段名、模型名和可执行的原因说明。"""

    def __init__(self, stage, model, reason):
        self.stage = stage
        self.model = model
        self.reason = reason
        super().__init__(
            f"{STAGE_LABEL.get(stage, stage)}失败（模型 {model or '(未指定)'}）：{reason}"
        )


def save(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def load(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


# ---------------------------------------------------------------------------
# 失败原因诊断：把各家网关五花八门的报错翻译成「该换哪个模型 / 该改哪里」。
# ---------------------------------------------------------------------------
AUDIO_UNSUPPORTED_MARKERS = (
    "input_audio", "audio modality", "does not support audio",
    "unsupported audio", "audio is not supported", "audio input is not supported",
    "unknown variant `input_audio`", "invalid content type", "no audio support",
    "audio_url", "不支持音频", "音频输入",
)
VISION_UNSUPPORTED_MARKERS = (
    "image_url", "image input", "does not support image", "unsupported image",
    "image is not supported", "text-only", "not a vision", "不支持图片", "不支持图像",
)
MODEL_MISSING_MARKERS = (
    "model not found", "model_not_found", "does not exist", "no such model",
    "invalid model", "unknown model", "模型不存在", "模型未找到", "无此模型",
)
AUTH_MARKERS = ("401", "invalid api key", "unauthorized", "authentication",
                "invalid token", "密钥无效", "鉴权")
QUOTA_MARKERS = ("insufficient", "quota", "balance", "402", "欠费", "余额")
RATE_MARKERS = ("429", "rate limit", "too many requests", "限流")


def diagnose(stage, model, message):
    """按报错文本给出「为什么失败 + 怎么办」。"""
    text = f"{message}".lower()
    if stage == "audio" and any(marker in text for marker in AUDIO_UNSUPPORTED_MARKERS):
        return (
            f"该渠道/模型没有接收音频（OpenAI input_audio）。{model} 不支持音频输入，"
            "请把「音频模型」改成支持听声的模型，例如 Gemini 系列、Qwen-Omni、"
            "GPT-4o-Audio、豆包 Seed 音频版等"
        )
    if stage == "vision" and any(marker in text for marker in VISION_UNSUPPORTED_MARKERS):
        return (
            f"该模型不能读图（OpenAI image_url）。{model} 不是多模态视觉模型，"
            "请把「视觉模型」换成能看图的模型，例如 Gemini、GPT-4o/5、Qwen-VL、豆包视觉版"
        )
    if any(marker in text for marker in MODEL_MISSING_MARKERS):
        return (
            f"这个渠道里没有 {model} 这个模型。请确认模型名拼写，"
            "或改选与所选渠道匹配的模型（跨渠道选模型会打不通）"
        )
    if any(marker in text for marker in AUTH_MARKERS):
        return "密钥无效或没有该模型的权限，请到「设置 → 密钥」重新填写这个渠道的密钥"
    if any(marker in text for marker in QUOTA_MARKERS):
        return "渠道余额/额度不足，请充值或改用其它渠道"
    if any(marker in text for marker in RATE_MARKERS):
        return "渠道限流，稍后重试，或换一个渠道"
    return ""


def compact_error(detail, limit=300):
    """把网关那坨嵌套 JSON 压成一句人能读的话。

    中转渠道会把上游报错原样再包一层（`{\\"error\\":{\\"message\\":\\"{\\\\\\"message\\\\\\":…\\"}}`），
    几百个转义字符糊在界面上，用户只看到一堆反斜杠。这里抽出最里层、最长的
    那句 message，保留 HTTP 状态码，再截断。
    """
    text = (detail or "").strip()
    status = ""
    matched = re.match(r"^(HTTP\s*\d{3})\s*:?\s*", text)
    if matched:
        status = matched.group(1) + "："
        text = text[matched.end():]
    inner = ""
    for match in re.finditer(r'message\\{0,2}"\s*:\s*\\{0,2}"([^"\\]{3,400})', text):
        candidate = match.group(1).strip()
        if len(candidate) > len(inner):
            inner = candidate
    if inner:
        text = inner
    text = text.replace("\\n", " ").replace("\\", "").strip()
    if len(text) > limit:
        text = text[:limit].rstrip() + "…"
    return f"{status}{text}".strip()


def call_stage(stage, base, key, model, messages, timeout=420):
    """调一次模型；失败时抛 StageFailure，把阶段和诊断一起带出去。"""
    if not base:
        raise StageFailure(stage, model, "没有取到这个模型所属渠道的 base_url")
    if not key:
        raise StageFailure(stage, model, "没有取到这个模型所属渠道的 API Key")
    try:
        return pajuben.call_api(base, key, model, messages, "", timeout=timeout)
    except Exception as error:  # noqa: BLE001 —— 统一转成带阶段信息的错误
        detail = str(error).strip() or type(error).__name__
        hint = diagnose(stage, model, detail)
        shown = compact_error(detail)
        raise StageFailure(stage, model, f"{shown}\n    说明：{hint}" if hint else shown) from error


def audio_messages(audio_path, ep):
    data = base64.b64encode(open(audio_path, "rb").read()).decode()
    prompt = f"""你是专业影视听写员。完整听写短剧第{ep}集音频。
要求：
1. 按时间顺序输出，约每5至10秒标一次【分:秒】时间戳。
2. 完整保留所有人物台词、旁白、内心独白，不得总结或改写。
3. 单独记录有意义的声音效果，格式写在该时间戳所在行的末尾，用「音效：」开头，
   例如「音效：关门声、急促脚步、手机铃声、雨声、打斗撞击、背景音乐转紧张」；
   音乐只描述情绪与起落，不要抄歌词之外的旋律描述。
4. 能判断说话人就写姓名，不能确定写“未知角色”，不要猜姓名。
5. 听不清处写【听不清】，不要编造。
6. 只输出带时间戳的听写稿。"""
    return [{"role": "user", "content": [
        {"type": "text", "text": prompt},
        {"type": "input_audio", "input_audio": {"data": data, "format": "mp3"}},
    ]}]


def vision_messages(frames, ep, known_roles, batch_no=1, batch_total=1):
    prompt = f"""你是专业短剧拉片师。下面是第{ep}集按时间顺序抽取的{len(frames)}帧画面。
当前是画面批次 {batch_no}/{batch_total}。只分析本批画面，不猜台词。按两段输出：

【第一段：人物形象】集中写一次，不要在每个镜头里重复。本批画面里出现的每个角色一段：
“角色名：发型与发色、服装款式与颜色、配饰、随身物品、明显体貌特征（胡须/疤痕/眼镜等）”。
只写画面能看清的，看不清就不写；同一角色在本批内换装、服装破损/沾血/淋湿时，
另起一行标时间点，写“角色名（约【分:秒】起换装）：只写变化的部分”。
只闻其声、本批没出现在画面里的角色不要写。若本批没有新角色也没有换装，写“人物形象：本批无新增”。

【第二段：逐镜头记录】每条△=一个镜头，格式为“△【分:秒】切镜方式，景别：X｜动作和表情”，
只写：场景、动作链、表情神态、站位与走位。具体：
1. 场景：内外景、日夜、具体地点、可见陈设与光线；同一地点连续戏不拆场。
2. 动作链：谁对谁做了什么、起势→过程→结果，以及对方的反应镜头。
3. 表情神态：眉头、眼神视线、嘴角、手部小动作，只写看得见的证据，不写心理活动。
4. 站位与走位：人物在画面左/中/右、前/中/后景，坐/站、朝向、与门/桌/床等参照物的关系；
   换位、进出、靠近/拉开或转身必须另起一条。
△行里不写发型、不写衣着、不写配饰（这些只属于上面的“人物形象”）——唯一例外是某一处衣着
此刻正在发生变化或成为剧情证据（如“外套被雨水浸透”“他扯下领带缠住伤口”），只写这一处变化。
切镜方式紧跟在时间码之后，取 起镜（只用于每场第一条）/切镜（硬切）/叠化/淡入/淡出/白闪/划像/甩镜，
按画面实际过渡选，看不到过渡就写“切镜”，不许凭空编转场；时间只标该镜头开始的那一秒，
景别从远景/全景/中景/近景/特写/大特写中选；同一镜头内的连续动作、反应和情绪加深合并进同一条，
只有切镜（景别、机位或角度跳变，切入反应镜头或空镜）才另起一条。严禁按秒逐帧铺画面，
不得把几十秒内容概括成一句。若某场全程无切镜，须在场景标题下写“一镜到底”，该场△省略切镜方式。
已知角色表如下，能确认时必须使用其中姓名：
{known_roles or '暂无'}
只输出上述两段内容。"""
    content = [{"type": "text", "text": prompt}]
    for fp, t in frames:
        mm, ss = int(t) // 60, int(t) % 60
        content.append({"type": "text", "text": f"【{mm:02d}:{ss:02d}】"})
        content.append({"type": "image_url", "image_url": {
            "url": f"data:image/jpeg;base64,{pajuben.b64_file(fp)}", "detail": "low"}})
    return [{"role": "user", "content": content}]


def merge_prompt(ep, transcript, vision, known_roles, has_audio=True):
    # 无音轨的片子（AI 生成素材、渲染动画、纯画面录屏）没有可对齐的听写稿，
    # 只剩画面一条证据链。提示词必须换一套规矩，否则模型会照着示例硬编台词 ——
    # 那比「没有台词」更糟：观众会以为是原片对白。
    if has_audio:
        intro = "你是短剧剧本整理师。把同一集的音频听写和画面拉片按时间戳严格对齐，整理为标准拉片剧本。"
        rule_lines = """- 台词、旁白和内心独白以音频听写为准，不能删减或改写含义。
- 场景、动作、表情和人物反应以画面拉片为准，不能脑补。
- 响度明显或推动剧情的音效（关门、脚步、打斗、雨声、电话铃声、音乐起落）写进对应△的
  “音效：”后缀里；没有就省略，不要凭空添加。"""
        sources_block = f"""【音频听写】
{transcript}

【画面拉片】
{vision}"""
        sample_lines = """△【00:00】起镜，景别：全景｜动作、表情和反应。音效：关门声
角色名：台词
△【00:07】切镜，景别：中景｜动作、表情和反应。
角色名：台词
角色名（VO）：旁白
角色名（OS）：内心独白"""
        sample_tail = "角色名：台词"
        voice_note = "只闻其声、从未出镜的角色（画外音/旁白）\n  不写进「人物形象」，只在台词处标 VO/OS。"
    else:
        intro = ("你是短剧剧本整理师。这一集只有画面拉片、没有任何声音素材，"
                 "请依据画面整理为标准拉片剧本（无对白版）。")
        rule_lines = """- 本片没有音轨，听不到任何台词、旁白与音效：**不得编造台词**，不得写“音效：”后缀，
  不得使用（VO）旁白或（OS）内心独白 —— 这些都属于声音信息，画面里没有证据。
- 只有画面里确实出现可见字幕、对白气泡或屏幕文字时才写台词行，格式
  “角色名（字幕）：原文”，原文照抄，不润色、不改写、不补全。
- 场景、动作、表情和人物反应仍以画面拉片为准，不能脑补；某场若没有任何可见文字，
  该场就只写△动作行，不要用“（无对白）”之类的占位行。"""
        sources_block = f"""【画面拉片】
{vision}"""
        sample_lines = """△【00:00】起镜，景别：全景｜动作、表情和反应。
△【00:07】切镜，景别：中景｜动作、表情和反应。
角色名（字幕）：画面里出现的字幕原文（这一场没有可见文字就不写这一行）"""
        sample_tail = "角色名（字幕）：可见字幕原文"
        voice_note = "本片没有声音，不写 VO/OS。"
    return f"""{intro}

硬性要求：
{rule_lines}
- 不得只写剧情摘要；完整保留动作链、神态、视线和反应镜头。
- 【人物形象单开一段】紧跟“# 第{ep}集”标题之后、第一场之前，先输出一段「人物形象」：
  本集画面里出现过的每个角色独占一行，格式“角色名：发型与发色、服装款式与颜色、配饰、
  随身物品、明显体貌特征”。只写有辨识度且画面能看清的；看不清就不写。
  同一角色全程同一套装扮只写一行；出现换装、破损、沾血、淋湿、乔装时另起一行，写成
  “角色名（{ep}-3场起换装）：……”，只写变化的部分。{voice_note}
- 【人物形象是全文唯一写外貌的地方】发型、衣着、配饰、随身物品只允许出现在「人物形象」段：
  △行、场面调度、人物状态、人物行里一律不再重复描述服装与长相。唯一例外：某一处衣着此刻正在
  发生变化或本身成为剧情证据时（如“外套已被雨水浸透”“他脱下外套裹住她”），才在△里写这一处
  变化，且只写变化的部分。拉片里同一角色被重复描述过的穿着必须合并去重，只留一条。
- 每场开头必须输出“场面调度：”，这一行写**场景本身 + 人物位置**，分两截：
  先说场景（内外景、日夜、具体地点、可见陈设与家具、光源与空间关系、出入口），
  再说人物站位（画面左/中/右、前/中/后景、坐/站、面对或背对谁、与门/桌/床等参照物的关系）。
  这一行不写长相、发型、衣着、配饰，也不写表情情绪；站位变化、进出、靠近/分开或转身
  必须在对应△中记录。
- 每场可见状态有明确证据时，必须输出“人物状态：角色：状态（表情/动作证据）”；情绪只能根据
  可见证据归纳，不能编造心理活动。人物状态只写当前情绪与可见证据，不写衣着。
- 每条△=一个镜头，格式为“△【分:秒】切镜方式，景别：X｜动作与表情”：切镜方式取
  起镜/切镜/叠化/淡入/淡出/白闪/划像/甩镜（起镜只用于每场第一条△），时间只标该镜头开始的秒数、
  景别必填；同一镜头内的连续内容合并为一条，只有切镜才另起一条。动作按“起势→过程→结果/对方
  反应”写清主体、对象和方向，严禁按秒逐帧铺画面；△里不写衣着。
- 一镜到底的场次：场景标题下单独一行写“一镜到底”，该场每条△省略切镜方式（写成
  “△【分:秒】景别：X｜动作与表情”）；画面里只要出现过一次真正的切换就不能算一镜到底。
- 同一地点连续戏不拆场；地点或日夜/内外改变才开新场。
- 场号严格为 {ep}-1、{ep}-2……
- 每个场景标题下一行必须输出该场总时长，格式严格为“总时长：N秒”（只写这一场持续多少秒，
  禁止写起止时间码、禁止写“约”）。
- 使用已知角色姓名；无法确认时保留“未知角色”，不要强猜。
- 结尾输出完整角色表（角色名：身份），角色表只写身份，不写外貌。

已知角色表：
{known_roles or '暂无'}

{sources_block}

输出格式：
# 第{ep}集
人物形象
角色名：发型发色，服装款式与颜色，配饰，随身物品，明显体貌
角色名（{ep}-3场起换装）：只写变化的部分

{ep}-1场 日/夜 内/外 地点
总时长：30秒
人物：……
场面调度：内/外景与陈设、光源、空间关系；角色A在画面左侧门边站着，角色B坐在右侧沙发上仰头看他
人物状态：角色：状态（可见证据）
{sample_lines}

{ep}-2场 日/夜 内/外 地点
总时长：20秒
一镜到底
人物：……
△【00:28】景别：近景｜动作、表情和反应。
{sample_tail}

角色表
角色名：身份
"""


# 模型收不到音频时会回一段「我无法听到音频/请提供音频」的客气话，进程却正常
# 退出。这种文本当成听写稿写进剧本就是灾难，必须在音频阶段直接判失败。
# 实测话术很杂（「请上传第1集音频文件」「当前对话中未包含音频」「无法进行听写」），
# 所以用正则而不是整句匹配。
AUDIO_REFUSAL_PATTERNS = (
    r"(?:未|没有|没|无|缺少|缺失)[^。！？\n]{0,10}音频",
    r"请(?:上传|提供|补充|发送)[^。！？\n]{0,10}音频",
    r"音频[^。！？\n]{0,8}(?:缺失|未提供|不可用|不存在)",
    r"(?:未|没有|没)[^。！？\n]{0,10}(?:接收到|收到|包含)[^。！？\n]{0,6}(?:音频|声音)",
    r"(?:无法|不能|没办法)[^。！？\n]{0,10}(?:听写|转写|识别|处理|访问|读取)[^。！？\n]{0,6}(?:音频|声音)?",
    r"cannot\s+(?:hear|access|process|transcribe)[^.\n]{0,30}audio",
    r"no\s+audio",
    r"without\s+audio",
)
VISION_REFUSAL_PATTERNS = (
    r"(?:未|没有|没|无|缺少|缺失)[^。！？\n]{0,10}(?:图片|图像|画面|截图)",
    r"请(?:上传|提供|补充|发送)[^。！？\n]{0,10}(?:图片|图像|截图)",
    r"(?:无法|不能|没办法)[^。！？\n]{0,10}(?:查看|看到|查看图片|识别图片|处理图片|访问图片)",
    r"cannot\s+(?:see|view|access|process)[^.\n]{0,30}(?:image|picture|frame)",
    r"no\s+(?:image|picture|frames)",
)


def looks_like_refusal(text, patterns, max_len=600):
    """短文本 + 命中拒绝话术 → 判定模型其实没拿到音频/图片。

    真实听写稿/拉片记录都在几百字以上，所以「短」本身就是一条证据：
    短回复再命中「没有音频/无法查看」这类话术，基本可以确定是能力不匹配。
    """
    body = re.sub(r"\s+", "", text or "")
    if not body:
        return True
    if len(body) > max_len:
        return False
    return any(re.search(pattern, body, flags=re.I) for pattern in patterns)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--ep", type=int, default=1)
    ap.add_argument("--base", default="https://ark.cn-beijing.volces.com/api/v3")
    ap.add_argument("--key", default=os.environ.get("PAJUBEN_API_KEY", ""))
    ap.add_argument("--audio-model", default="doubao-seed-2-0-lite-260428")
    ap.add_argument("--vision-model", default="doubao-seed-2-1-pro-260628")
    # 两个模型可以分属两个渠道：各自一套 base_url / key，留空则沿用 --base/--key。
    ap.add_argument("--audio-base", default="")
    ap.add_argument("--vision-base", default="")
    ap.add_argument("--audio-key", default=os.environ.get("PAJUBEN_DUAL_AUDIO_KEY", ""))
    ap.add_argument("--vision-key", default=os.environ.get("PAJUBEN_DUAL_VISION_KEY", ""))
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--roles-file", default="")
    # 画质档位：fps 决定抽帧密度，longedge 决定画面长边像素，max-frames 是单集上限。
    ap.add_argument("--fps", type=float, default=2)
    ap.add_argument("--longedge", type=int, default=768)
    ap.add_argument("--max-frames", type=int, default=240)
    args = ap.parse_args()

    if not args.key:
        raise SystemExit("❌ 缺少 API Key：请先到「设置 → 密钥」为该渠道填写密钥")

    audio_base = args.audio_base or args.base
    vision_base = args.vision_base or args.base
    audio_key = args.audio_key or args.key
    vision_key = args.vision_key or args.key

    known = load(args.roles_file) if args.roles_file and os.path.exists(args.roles_file) else ""
    os.makedirs(args.output_dir, exist_ok=True)
    audio_out = os.path.join(args.output_dir, f"第{args.ep}集_音频听写.txt")
    vision_out = os.path.join(args.output_dir, f"第{args.ep}集_画面拉片.txt")
    final_out = os.path.join(args.output_dir, f"第{args.ep}集_双模型.txt")
    if os.path.exists(final_out) and os.path.getsize(final_out) > 100:
        print(f"[合并] 复用已完成双模型结果：{final_out}", flush=True)
        return

    # 先探一次音轨：无声视频（AI 生成素材、渲染动画、纯画面录屏）本来就没东西可听，
    # 旧版让音频阶段直接抛「无法识别台词与音效」，整条链路白跑一趟。
    # 现在改走视觉单模型：只用用户选的视觉模型拉片，合并时也不许编台词。
    has_audio = pajuben.has_audio_stream(args.video)
    if not has_audio:
        args.audio_model = ""
        print("⚠ 这个视频没有音轨：跳过音频听写，只用视觉模型"
              f"「{args.vision_model}」扒画面", flush=True)

    workdir = tempfile.mkdtemp(prefix="dual_pajuben_")
    # 音频听写与画面识别互不依赖，串着跑等于把两段耗时相加，一集多等好几分钟。
    # 这里两段同时起跑，合并阶段再汇合。
    cancel = threading.Event()
    # 单集内同时飞到渠道的画面批次路数。给到 3 及以上容易撞中转的并发限流
    # （429 会退避重试，反而更慢），2 路配合「音频那一路」正好 3 个在飞请求。
    # 渠道扛得住可以用 PAJUBEN_VISION_CONCURRENCY 调（上限 4）。
    try:
        VISION_BATCH_WORKERS = max(
            1, min(4, int(os.environ.get("PAJUBEN_VISION_CONCURRENCY") or 2)))
    except ValueError:
        VISION_BATCH_WORKERS = 2
    result = {"transcript": None, "vision": None}
    failure = {"error": None}
    guard = threading.Lock()

    def mark_failure(error):
        """记下第一个失败，并立刻掐掉另一阶段在途的请求，别让用户干等超时。"""
        with guard:
            first = failure["error"] is None
            if first:
                failure["error"] = error
        cancel.set()
        if first:
            pajuben.abort_active_requests()

    def audio_stage():
        try:
            if not has_audio:
                # 没有音轨就没有听写稿，这里直接收工；合并阶段会自动切到无对白版提示词。
                result["transcript"] = None
                return
            if os.path.exists(audio_out) and os.path.getsize(audio_out) > 100:
                result["transcript"] = load(audio_out)
                print(f"[音频] 复用已完成听写：{audio_out}", flush=True)
                return
            print(f"[音频] 提取音频并用「{args.audio_model}」听写台词与音效…", flush=True)
            audio = pajuben.extract_audio(args.video, workdir)
            if not audio:
                raise SystemExit("❌ 这个视频没有可用音轨，无法识别台词与音效")
            if cancel.is_set():
                return
            transcript = call_stage(
                "audio", audio_base, audio_key, args.audio_model,
                audio_messages(audio, args.ep))
            if looks_like_refusal(transcript, AUDIO_REFUSAL_PATTERNS):
                raise StageFailure(
                    "audio", args.audio_model,
                    "模型没有真正接收到音频（返回的是「听不到音频」之类的说明）。"
                    "这个模型不支持音频输入，请改选 Gemini / Qwen-Omni / GPT-4o-Audio 等能听声的模型")
            save(audio_out, transcript)
            result["transcript"] = transcript
            print(f"[音频] 已保存：{audio_out}", flush=True)
        except BaseException as error:  # noqa: BLE001 —— SystemExit 也要带回主线程
            mark_failure(error)

    def vision_stage():
        try:
            print(f"[画面] 抽帧并用「{args.vision_model}」识别画面…", flush=True)
            frame_dir = os.path.join(workdir, "frames")
            os.makedirs(frame_dir, exist_ok=True)
            duration = pajuben.probe_duration(args.video)
            # 帧数按 fps 推（画质档位的真实含义），再受单集上限与硬上限收敛。
            budget = int(duration * args.fps) if duration else args.max_frames
            budget = max(FRAME_BATCH, min(budget, args.max_frames, FRAME_BUDGET_CAP))
            fps = budget / duration if duration and duration > budget else args.fps
            print(f"[画面] 本集抽取 {budget} 帧（{fps:.2f} fps，长边 {args.longedge}px）", flush=True)
            frames = pajuben.extract_frames(args.video, fps, args.longedge, budget, frame_dir)
            batches = [frames[i:i + FRAME_BATCH] for i in range(0, len(frames), FRAME_BATCH)]
            total = len(batches)
            parts = [None] * total

            def run_batch(index, batch):
                if cancel.is_set():
                    return
                part_out = os.path.join(args.output_dir,
                                        f"第{args.ep}集_画面拉片_{index}-{total}.txt")
                if os.path.exists(part_out) and os.path.getsize(part_out) > 100:
                    part = load(part_out)
                    print(f"[画面] 复用批次 {index}/{total}", flush=True)
                else:
                    print(f"[画面] 分析批次 {index}/{total}（{len(batch)}帧）…", flush=True)
                    part = call_stage(
                        "vision", vision_base, vision_key, args.vision_model,
                        vision_messages(batch, args.ep, known, index, total))
                    if looks_like_refusal(part, VISION_REFUSAL_PATTERNS):
                        raise StageFailure(
                            "vision", args.vision_model,
                            "模型没有真正接收到画面（返回的是「看不到图片」之类的说明）。"
                            "这个模型不是多模态视觉模型，请改选能看图的模型")
                    save(part_out, part)
                    print(f"[画面] 批次 {index}/{total} 完成", flush=True)
                parts[index - 1] = part

            # 批次并行，但写盘与报错顺序按批次号固定：parts 按 index 回填，
            # 拼接时不依赖线程完成顺序。
            pool = ThreadPoolExecutor(max_workers=VISION_BATCH_WORKERS)
            try:
                futures = [pool.submit(run_batch, i, b)
                           for i, b in enumerate(batches, 1)]
                for future in futures:
                    future.result()
            except BaseException:  # noqa: BLE001
                cancel.set()
                pajuben.abort_active_requests()
                raise
            finally:
                pool.shutdown(wait=True, cancel_futures=True)
            missing = [i for i, part in enumerate(parts, 1) if part is None]
            if missing:
                raise SystemExit(f"❌ 画面识别被中断（缺少批次 {missing}）")
            vision = "\n\n".join(parts)
            save(vision_out, vision)
            result["vision"] = vision
            print(f"[画面] 已保存：{vision_out}", flush=True)
        except BaseException as error:  # noqa: BLE001
            mark_failure(error)

    try:
        if has_audio:
            print(f"↻ 音频听写与画面识别同时开始（画面批次并发 {VISION_BATCH_WORKERS} 路）…",
                  flush=True)
            workers = [
                threading.Thread(target=audio_stage, name="pajuben-audio", daemon=True),
                threading.Thread(target=vision_stage, name="pajuben-vision", daemon=True),
            ]
        else:
            # 没音轨就别起音频线程，省一路请求也省一次必然失败的报错。
            print(f"↻ 只跑画面识别（画面批次并发 {VISION_BATCH_WORKERS} 路）…", flush=True)
            workers = [
                threading.Thread(target=vision_stage, name="pajuben-vision", daemon=True),
            ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        if failure["error"] is not None:
            raise failure["error"]
        transcript, vision = result["transcript"], result["vision"]
        if vision is None:
            raise SystemExit("❌ 画面阶段没有产出结果，请重试")
        if has_audio and transcript is None:
            raise SystemExit("❌ 音频阶段没有产出结果，请重试")

        # ---- 最后一步：按时间戳合并成剧情剧本 ----
        print(f"[合并] {'按时间戳' if has_audio else '按画面时间码'}合并剧本"
              f"（复用视觉模型「{args.vision_model}」）…", flush=True)
        final = call_stage(
            "merge", vision_base, vision_key, args.vision_model,
            [{"role": "user", "content": merge_prompt(
                args.ep, transcript, vision, known, has_audio=has_audio)}])
        save(final_out, final)
        print(f"[合并] 完成：{final_out}", flush=True)
    except StageFailure as error:
        raise SystemExit(f"❌ {error}")
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        raise SystemExit(f"❌ 双模型处理失败：{error}")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    # 兜底：任何未捕获异常都必须以 ❌ 形式说清原因再退出。父层只认 ❌ 行，
    # 裸 traceback + 退出码 1 会被它折叠成一句「引擎异常退出（退出码 1）」，
    # 真正的原因（缺模块、路径不存在、解释器异常）就彻底丢了。
    try:
        main()
    except SystemExit:
        raise
    except BaseException as error:  # noqa: BLE001
        traceback.print_exc()
        print(f"❌ 双模型引擎异常退出：{type(error).__name__}: {error}", flush=True)
        sys.exit(1)
