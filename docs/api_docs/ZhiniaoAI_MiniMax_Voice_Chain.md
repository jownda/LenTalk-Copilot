# 知鸟AI · MiniMax 海螺语音链路规格

> 事实来源（2026-09-20 实测，全部**免鉴权**可复核）：
> - `GET https://cuai.token6688.com/v1/logical-models` —— 全量模型元数据 + `param_schema`（**权威字段表**）
> - `GET https://cuai.token6688.com/api/v1/models` —— 分页模型目录（含价格 `output_price` / `billing_type`）
> - `GET https://cuai.token6688.com/api/v1/models/{model}` —— 单模型详情
> - `GET https://cuai.token6688.com/zh-CN/docs` —— 文档站（SPA，正文在 `self.__next_f.push` 载荷里）
>
> **未做任何真实计费调用。** 鉴权在参数校验之前，无 key / 错 key 一律 `401`，拿不到校验错误细节；
> 因此「响应体形状」一节标注为**待一次实跑确认**（见文末「待确认项」）。

## 0. 一句话结论

`voice-clone`（音色克隆）、`voice-design`（音色设计）是**一次性创建音色资产**的接口，
`speech-2.8`（语音克隆 2.8）是**消费音色做合成**的接口。三者的联结点是 **`voice_id`**。

```
音色克隆 ──┐
           ├──▶ voice_id ──▶ 音色库（跨项目）──▶ speech-2.8 合成 ──▶ 音频
音色设计 ──┘
                     ▲
官方系统音色库（647 条）──┘  ← 海螺官方音色，自带试听 MP3，见 §9
```

**音色有两个来源**：你自己克隆/设计的资产，以及**海螺官方的 647 条系统音色**。
后者是「试听免费」的关键 —— 官方给每条都配了试听 MP3，所以不必为了听一下而付费合成一次。

## 1. 端点

平台只有**一个音频端点族**，`model` 决定能力（即官方所说的
「把 base_url 换成本平台、model 填 `voice-clone`，其余请求体保持 GT 原样即可」）。

| 方法 | 路径 | 形态 | 无 key 探测 |
|---|---|---|---|
| POST | `/v1/audio/speech` | 同步，**直接返回音频二进制** | `401` ✅ 已注册 |
| POST | `/v1/audio/speech/async` | 异步，返回任务 | `401` ✅ 已注册 |
| GET | `/v1/tasks/{task_id}` | 轮询任务，完成后给 CDN URL | `401` ✅ 已注册 |
| POST | `/v1/audio/voices` | 声纹库：上传参考音频 | `401` ✅ 已注册 |
| GET | `/v1/audio/voices` | 声纹库：列出音色 | `401` ✅ 已注册 |
| POST | `/v1/files` | 文件上传（网关通用） | `401` ✅ 已注册 |

**不存在**（`404`，别照抄别家文档）：
`/v1/audio/music`、`/v1/audio/sound-effects`、`/v1/audio/voice-clone`、
`/v1/voice-clone`、`/v1/voice-design`、`/v1/audio/voice-design`、`/v1/voices`、`/v1/files/upload`。

> 即：**音乐也走 `/v1/audio/speech`**（model=`music`）。本项目现有 `generateZzdhAudio()` 按
> kind 分流的 `/v1/audio/music`、`/v1/audio/sound-effects` 对知鸟**不成立**，必须走同一端点。

## 2. 计费

| model | display_name | billing | 价格 | 语义 |
|---|---|---|---|---|
| `voice-clone` | MiniMax Voice Clone | `per_request` | **⚡2.20 / 次** | 一次性音色费 |
| `voice-design` | MiniMax Voice Design | `per_request` | **⚡2.1944 / 次** | 一次性音色费 |
| `speech-2.8` | MiniMax Speech 2.8 (Voice Clone) | `per_char` | **45 µ$/字符** | 按字符合成 |
| `music` | Suno Music | `per_request` | ⚡0.1714 / 次 | 音乐 |
| `tts-1` / `tts-1-hd` / `gpt-4o-mini-tts` | GT TTS / GT TTS HD / GT-4o Mini TTS | `per_char` / `per_request` | 0.015 / 0 / 0.0417 | OpenAI 系 TTS |

**关键**：`voice-clone` 的 `voice_id` **同一 ID 重复克隆幂等，不二次收费** → 重试安全，
客户端可以放心自带 `voice_id` 并在失败后重试。

## 3. 三个模型的权威字段表（照抄 `param_schema`）

### 3.1 `voice-clone` — 音色克隆（海螺 音色克隆）

`capabilities: ["音色克隆","样本复刻","专属音色","音色资产"]`，`input_hint`：
「上传一段 10 秒-5 分钟的清晰人声样本 (mp3/m4a/wav, <20MB), 生成专属音色.」

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `voice_id` | string | **是** | **调用方自定义**的新音色 ID。字母开头，8-256 字符，字母/数字/`-`/`_`。克隆成功后该 ID 直接用于 `speech-2.8` 的 `voice`。**同一 ID 重复克隆幂等（不二次收费）** |
| `sample_url` | string | **是** | 待复刻的人声样本。**「我方存储 URL 或 `data:`」**；mp3/m4a/wav，10 秒-5 分钟，<20MB |
| `preview_text` | string | 否 | **当前克隆动作不产出试听**（试听 = 创建后首次真实合成，由上层激活流程完成）。保留仅为兼容旧调用，**不发厂商** |

⚠️ `preview_text` 是死字段 —— 克隆完**必须再发一次 `speech-2.8`** 才能听到声音。

### 3.2 `voice-design` — 音色设计（海螺 音色设计）

`capabilities: ["音色设计","文生音色","描述词生成音色","专属音色"]`，`input_hint`：
「输入音色描述词 (性别/年龄/质感/适用场景) + 一句试听文本, 生成专属音色.」

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `prompt` | string (textarea) | **是** | 音色描述词，如「冷漠疲惫带防备感的青年男性声音」「低沉富有磁性的悬疑播音员」 |
| `preview_text` | string (textarea) | **是** | 试听文本。**返回的音频即此文本用新音色念出** |
| `voice_id` | string (input) | **是** | **调用方自定义**的新音色 ID。字母开头，**≥8 字符**，字母+数字。设计成功后即可用于 `speech-2.8` 的 `voice` |

与克隆的差别：设计**直接返回试听音频**（克隆不返回）。

### 3.3 `speech-2.8` — 语音克隆 2.8 配音（海螺 语音克隆 2.8）

`capabilities: ["语音克隆","文字转语音","音色复刻","多语言","高音质","hd","turbo"]`，
`input_hint`：「输入想要朗读的文本内容, 选择克隆音色 + version (2.6/2.8) + tier (hd/turbo) 生成语音.」
`max_prompt_chars: 9999`。

| 字段 | 类型 | 必填 | 默认 | 可选值 |
|---|---|---|---|---|
| `voice` | string (dropdown) | **是** | — | MMX 音色：预设（如 `female-tianmei`）或**用户克隆音色 ID（从音色库选）** |
| `version` | enum (radio) | 否 | `2.8` | `2.8` / `2.6` |
| `tier` | enum (radio) | 否 | `hd` | `hd`（高音质，配音/播客）/ `turbo`（速度优先，实时） |
| `speed` | enum (dropdown) | 否 | `1` | `0.5` / `0.75` / `1` / `1.25` / `1.5` / `2` |
| `pitch` | enum (dropdown) | 否 | `0` | `-6`（低沉）/ `-3` / `0` / `3` / `6`（明亮） |
| `emotion` | enum (dropdown) | 否 | `auto` | `auto` / `happy` / `sad` / `angry` / `fearful` / `surprised` / `calm` |
| `sound_effects` | enum (dropdown) | 否 | `none` | `none` / `spacious_echo`（空旷回音）/ `auditorium_echo`（礼堂广播）/ `lofi_telephone`（电话失真）/ `robotic`（电音） |

**语言：多语言，但★没有语言参数★，不要做语言下拉。**
平台元数据 `capabilities` 里明确写着 `"多语言"`，而 `param_schema` **只有上面 7 个键**
（`voice` / `version` / `tier` / `speed` / `pitch` / `emotion` / `sound_effects`）。
把 `GET /v1/logical-models` 的全量 117 个模型挨个过一遍，**没有任何一个模型出现
`language*` / `locale` / `accent` / `dialect` 之类的键**（实测：无密钥即可拉取，HTTP 200）。
结论：语言由**输入文本自动识别**——用目标语言写文本就是该语言，界面上给一句说明即可。
若硬塞 `language_boost`（MiniMax 原生 T2A 有这个字段）之类的未登记参数，属于文档 0.1 说的
「平台会静默忽略」那一类，只会让用户以为选了没生效。

🚨 **`speech-2.8` 没有任何参考样音字段。** 它只吃 `voice`（voice_id）。
本项目现有实现（`buildAudioBody` 每次带 `reference_audio` / `reference_audio_url`）
对这条链路**完全无效**——平台会静默忽略，表现为「克隆了但声音没变」。

文案原文：`emotion` 的 `auto` 描述为「自动识别情绪」；`pitch`/`speed`/`sound_effects` 中文标签分别是
语调 / 语速 / 音效。

## 4. 声纹库（`/v1/audio/voices`）

> **这个端点只管「你自己的音色」**：`GET /v1/audio/voices` 带上 key 返回
> `{"data":[],"has_more":false,"next_cursor":null,"object":"list"}` —— 还没克隆过就是空数组。
> 它**不返回**官方那几百条系统音色；官方音色库在别处，见 **§9**。

平台自己的 UI 文案（文档站载荷 `voiceClone.*` / 文档 i18n）：

| key | 原文 |
|---|---|
| `voiceLibraryLimits` | **上传只接受 `multipart/form-data` 本地文件，不接受 JSON 或外部 URL。音频须为 MP3/M4A/WAV，时长 10–300 秒（含边界），文件严格小于 20 MiB。** |
| `voiceLibraryIntro` | speech-2.8 克隆音色时，必须先上传参考音频并等待声纹就绪，再把声纹 ID 传给语音生成接口。 |
| `voiceLibraryMapping` | 参数映射：`speech.model = voice.model`；`speech.voice = voice.id`。 |
| `voiceLibraryPublicModel` | 公开模型名固定为 `speech-2.8`；音质和速度继续使用该模型已有的 `version`、`tier` 等参数。 |
| `voiceLibraryAsyncNote` | 同步 `POST /v1/audio/speech` 直接返回 audio binary（二进制）；`POST /v1/audio/speech/async` 返回任务，完成后通过 `GET /v1/tasks/{task_id}` 获取 ZN 知鸟AI CDN URL。 |
| `ttsBinaryResponseNote` | TTS 同步返回二进制音频流（Content-Type 如 `audio/mpeg`），不是 JSON。用 `response_format` 选格式（mp3/opus/aac/flac/wav/pcm），直接把响应体保存为音频文件即可。 |
| `passthroughNote` | **把 base_url 换成本平台、model 填 {model}，其余请求体保持 GT 原样即可。网关自动路由到最优厂商并翻译到其原生协议。**（"GT" = 该平台对 OpenAI/GPT 系模型的品牌前缀，`GT SDK` = OpenAI SDK） |

声纹状态机（UI 文案）：`activating`（激活中，稍后可用）→ 就绪；`expired`（已失效，需重新上传克隆）。

另有几条行为约束值得照抄：

- `familyMismatchHint`：**克隆音色绑定语音家族**。别的家族的语音模型用不了你的声纹，必须切到
  「海螺 speech-2.8」等对应模型。→ 音色库条目要记 `family`，跨家族时禁用并提示。
- `reusedNotice`：「已存在相同样本的音色，已为你复用（本次未计费）」→ 平台按**样本内容**去重。
- `errDuration`：「音频时长需为 {min}-{max} 秒，当前 {actual} 秒」→ 客户端应前置校验时长，
  避免花一次 ⚡2.2 换一个参数错误。
- `startClone` / `reclone` / `rename` / `delete` / `aiDesign` / `uploadPriceLead`：
  「开始克隆」/「重新克隆」/「重命名音色」/「删除」/「AI 设计音色」/「上传克隆」。

### 4.1 两条创建路径的取舍

| | 路径 A：model 卡片（`/v1/audio/speech` + `model=voice-clone`） | 路径 B：声纹库（`POST /v1/audio/voices`） |
|---|---|---|
| 样音 | `sample_url`，**允许 `data:` data URL** | **只收 multipart 本地文件**，拒 JSON/外部 URL |
| `voice_id` | 调用方自带 | 平台分配（映射为 `voice.id`） |
| 状态机 | 无（无试听，靠 speech-2.8 激活） | 有 `activating` / `expired` |
| 文档指向 | `passthroughNote`：只换 base_url + model | 「我的声纹库」UI |

**本项目选路径 A**：与用户指定的一致（"model 填 voice-clone"），且本地样音可以直接转
data URL 提交，不需要额外的上传端点（本项目 `resolveReferenceAssetSource()` 已经能把
`file:` / `asset:` / 绝对路径读成 data URL）。路径 B 作为后续可选增强。

## 5. 联动设计（本项目）

### 5.1 四个创作面板

| 面板 | model | 性质 | 产出 |
|---|---|---|---|
| 音色克隆 | `voice-clone` | 创建资产 | `voice_id` → 写入音色库 |
| 音色设计 | `voice-design` | 创建资产 | `voice_id` + **试听音频** → 写入音色库 |
| 2.8 配音 | `speech-2.8` | 消费资产 | 音频文件 |
| 音乐创作 | `music` | 独立 | 音频文件 |

### 5.2 `voice_id` 的生成与归属

`voice-clone` / `voice-design` **都要求调用方自带 `voice_id`**。因此：

- 生成规则：字母开头、≥8 字符、只含字母数字（design 的要求更严，取交集）
  → 例如 `lt` + base36 时间戳 + 4 位随机。
- `voice_id` 就是音色库条目的主键，直接喂给 `speech-2.8` 的 `voice`。
- **幂等性利用**：克隆失败重试时沿用同一个 `voice_id`，平台不二次收费。
  所以 `voice_id` 必须在发起请求**之前**持久化，而不是等响应。

### 5.3 音色库是唯一枢纽

`settingsStore.voiceProfiles` 从「本地样音档案」升级为「服务端音色档案」：

| 字段 | 变化 |
|---|---|
| `voiceId` | 语义从「本地音色名」改为「调用方生成 / 服务端确认的 voice_id」 |
| `source` | 新增：`clone` / `design` / `preset` / `builtin` |
| `family` | 新增：`speech-2.8` —— 跨家族不可用时提示 |
| `previewAudio` | 新增：设计的试听音频 / 克隆后首次合成结果 |
| `status` | 新增：`activating` / `ready` / `expired` |
| `referenceAudio` | 保留：样音本地路径（克隆来源留痕，便于「重新克隆」） |

跨项目复用天然成立——`settingsStore` 是全局的，与项目文件无关。

### 5.4 数据流

```
[音色克隆] 本地样音 ──resolveReferenceAssetSource──▶ data URL
              └─ 生成 voice_id ──▶ 先写音色库(status=activating)
                     └──POST /v1/audio/speech {model:voice-clone, voice_id, sample_url}──▶ 成功 status=ready
                            └─ 可选：立刻用 speech-2.8 合成一句试听（"创建即激活"）

[音色设计] 描述词 + 试听文本
              └─ 生成 voice_id ──▶ 先写音色库(status=activating)
                     └──POST /v1/audio/speech {model:voice-design, prompt, preview_text, voice_id}──▶ voice_id + 试听音频
                            └─ 存 previewAudio，status=ready

[2.8 配音] 文本 + 从音色库选 voice_id
              └──POST /v1/audio/speech {model:speech-2.8, input, voice, version, tier, speed, pitch, emotion, sound_effects}──▶ 音频二进制
                     └─ persistAudioBytes() 落盘
```

## 6. 与本项目现状的差距

| # | 现状 | 问题 | 处置 |
|---|---|---|---|
| 1 | `AudioCreativePanel` 只有 3 个面板 | 没有音色设计入口 | 加第 4 个 `voice-design` |
| 2 | `AUDIO_VOICE_CLONE_MARKER` 含 `speech[-_]?\d` | 把**消费端** `speech-2.8` 错误归进「声音克隆」页 | 移除该分支，改为显式 `voice-clone` |
| 3 | `resolveZzdhAudioKind('voice-design')` 命中 `voice` → `speech` | `voice-design` 混进「文字转语音」页，会被当普通 TTS 送 `input` | 新增 operation 维度，独立成页 |
| 4 | `buildAudioBody()` 带 `reference_audio` / `reference_audio_url` | `speech-2.8` **没有这个字段**，静默无效 | 走 `voice`（voice_id），删除样音直传 |
| 5 | `saveVoiceProfile()` 把 `voiceId` 存成当前音色名（默认 `alloy`） | 假克隆：服务端从未见过这个音色 | `voiceId` 改为调用方生成的真实 ID |
| 6 | 2.8 面板无档位/语速/语调/音效 | 平台能力没用上 | 补 `tier`/`version`/`speed`/`pitch`/`sound_effects` |
| 7 | `generateZzdhAudio()` 按 kind 打 `/v1/audio/music` 等 | 知鸟这些路径 `404` | MiniMax 链路统一走 `/v1/audio/speech` |

## 7. 实现落点

| 文件 | 改动 |
|---|---|
| `src/commands/minimaxVoice.ts` | **新建**：模型常量、参数枚举、`voice_id` 生成、三个请求体构造器、响应解析、能力判定 |
| `src/features/canvas/models/types.ts` | `AudioCreativePanel` 加 `'voice-design'`；`AudioModelDefinition` 加 `operation` / `mmxFamily` |
| `src/features/canvas/models/registry.ts` | 收敛克隆标记；`matchesAudioCreativePanel` 加分支；按 operation 分流 |
| `src/stores/settingsStore.ts` | `SavedVoiceProfile` 加 `source` / `family` / `previewAudio` / `status`；归一化 |
| `src/commands/ai.ts` | `generateAudio()` 三分流：clone / design / speech；补请求与返回类型 |
| `src/features/canvas/domain/canvasNodes.ts` | `AudioGenNodeData` 加 `creativeMode:'voice-design'` 与 mmx 参数字段 |
| `src/features/canvas/nodes/AudioGenNode.tsx` | 四面板；克隆/设计走「创建资产」分支 |
| `src/features/canvas/nodes/AudioVoiceControls.tsx` | 新增 voice-design 分支；克隆分支加时长校验与 voice_id；2.8 面板加 mmx 控件 |
| `src/i18n/locales/{zh,en}.json` | 新面板与参数文案 |

## 8. 待一次实跑确认（未验证，勿当既成事实）

以下三点**无法静态判定**，需要用 1 条真实请求确认；在此之前实现里按「最可能 + 兼容提取」处理：

1. **请求体信封**：`param_schema` 字段是**放顶层**（`{model, input, voice_id, sample_url}`）
   还是包在 `params` / `metadata` 里。文档措辞是「图片/视频/音频模型走顶层或 params 的 images 数组」，
   且 `noParams` 提示「仅需 model + prompt/messages」→ 倾向**顶层扁平**，与现有 `buildAudioBody` 一致。
2. **响应体形状**：`voice-clone` / `voice-design` 返回的 JSON 里 `voice_id` 落在哪一层
   （顶层 / `data.voice_id` / `data.voice.id`）。实现里做**递归兼容提取**。
3. **文本字段名**：`input`（OpenAI 惯例，现有代码在用）还是 `prompt`。

**实跑纪律**（技能铁律）：`voice-clone` ⚡2.20/次、`voice-design` ⚡2.1944/次。
调试**一次只发 1 条**，发之前报清「模型 / 样本时长 / 单价 / 这条大概多少钱」并取得明确同意。
被 400 拒的请求不扣费，所以优先用会被拒的写法探边界。

## 9. 官方系统音色库：试听不用自己生成

**动机**：`speech-2.8` 的试听以前只有两条路 —— 要么没有，要么现场跑一次合成（**按字符计费**）。
而海螺**官方给每个系统音色都配了一条试听 MP3**，白拿的。把它搬进来，试听就变成零成本零等待。

### 9.1 数据从哪来（两条互补的源）

| 源 | 数量 | 拿到什么 | 获取方式 |
|---|---|---|---|
| 官方音色库 `POST https://www.minimax.cn/v1/api/audio/voice/list` | **603** | `voice_id` / `uniq_id` / 名称 / **描述** / 语言·口音·性别·年龄·场景·风格标签 / **`sample_audio`（试听 MP3）** | 需签名，见 9.2 |
| 官方文档 `https://platform.minimaxi.com/docs/faq/system-voice-id` | **327** | `语言 / voice_id / voice_name`（**平台必然支持**的权威清单） | 前端渲染，需浏览器取表格 |

两者关系：**327 条文档清单里有 283 条也在音色库里**（`uniq_id` 就是同一个 id）。
差集 44 条是 v1 老音色（`male-qn-qingse` / `female-tianmei` / Christmas 角色等），音色库里没有 →
**没有描述也没有试听**，保留只为兼容存量节点数据。

> **id 用哪个字段**：`uniq_id`（形如 `Chinese_wenrounvxing`），不是那条数字 `voice_id`
> （`423575254671453` 是**音频产品内部 id**，与 API 对不上）。

### 9.2 音色库接口的签名（`yy`）

`/v1/api/audio/voice/list` 是 **POST**（虽然浏览器里看着像带 query 的 GET），且要一个头部签名：

```
参数（query, 全部必需）: device_platform=web, app_id=3001, version_code=22201, biz_id=1,
                        uuid=<任意 uuid4>, lang=zh-Hans, device_id=<任意数字串>,
                        os_name, browser_name, browser_language, browser_platform,
                        screen_width, screen_height, unix=<毫秒时间戳>
请求头:                 yy: <签名>,  referer: https://www.minimax.cn/audio/voices
请求体:                 { is_system: true, is_collect: false, page, page_size, filter: [], user_language: "zh" }
```

签名算法（前端 `r0` 函数，`o` = **md5**）：

```
yy = md5( encodeURIComponent(完整URL含query) + "_" + JSON.stringify(body) + md5(String(unix)) + "ooui" )
```

分页就是 body 里的 `page` / `page_size`（`page_size: 200` 三页多一点拉完 603 条）；
响应 `data.voice_list` / `data.total` / `data.has_more`。
`filter` 是 `[{filter_type, filter_value_list, filter_relation}]`，按语言/性别/年龄/标签过滤（本次没用）。

**试听音频是公开 CDN，无需任何鉴权**（`cdn.hailuoai.com` / `file.cdn.minimax.io` /
`filecdn.minimax.chat`），直接 `curl` 即得 `audio/mpeg`。

### 9.3 项目内落点

**数据文件只保留文档收录的 327 条** —— 9.4 实跑证明音色库独有的 320 条平台不认，生成必败，
留在下拉里就是 320 个坑（2026-09-20 复审裁掉，原 647 条快照 / 401 KB → 327 条 / 195 KB）。

| 文件 | 作用 |
|---|---|
| `src/features/canvas/nodes/audio/mmxVoiceLibrary.json` | **327 条**快照（283 有描述+试听 + 44 legacy），195 KB |
| `src/features/canvas/nodes/audio/mmxVoiceLibrary.ts` | 类型 + `isMmxSystemVoiceId` / `mmxVoiceGroupOf` / `mmxVoicesForLanguage`（无 `verifiedOnly` 参数 —— 全表即已确认集合） |
| `src/features/canvas/nodes/audio/mmxVoiceLibrary.test.ts` | 数据不变量（327 条 / id 唯一 / 试听必有 URL / legacy 无试听 / 踩坑 id 不在表内 / moss_audio 不进表） |
| `MmxVoiceStudio.tsx` | 语音合成卡：候选 = 我的音色库 + 官方 327 条；面板内「语言」过滤器；选中后摊开描述 |
| `VoiceSelect.tsx` | 加了两个通用扩展点：`listHeader`（面板内过滤器）与 `previewUnavailable`（无试听源则不渲染试听键） |

> 曾经的「仅显示官方确认音色（327）」勾选框已随裁剪删除 —— 全表都是确认过的，开关没有存在意义。

**分组是 男声 / 女声 / 童声**（童声按**年龄**轴切，不按性别 —— 儿童里男女都有）。
数据文件在排序时就按 `语言 → 分组 → (有试听优先) → 年龄 → 名字` 排好，因为 `VoiceSelect`
按**首次出现**建立分组，乱序会让「男声」小标题出现两次。

**试听的三种情况**（`resolvePreview` 的契约）：
1. 官方音色 → 直接播 `sample_audio`（免费）；
2. 自己的克隆/设计音色 → 播 `profile.previewAudio`（有就免费）；
3. 都没有（legacy 44 条）→ **不渲染试听键**。不退化成「现场合成」，因为合成按字符计费，
   而这一行混在几百条免费试听里，点下去悄悄扣费最不该发生。

**legacy 音色的补救 —— 「生成一次，自动变成试听」（2026-09-20）**：
legacy 音色第一次被用来合成成功后，`AudioGenNode` 把生成结果（本来就是落盘的本地路径）
记进 settingsStore 的 `systemVoicePreviews`（voice_id → 路径，随本机持久化）。此后下拉里
该音色的试听键出现，播的就是上次生成的音频；副标题也从「文档收录 · 无试听」变成
「试听来自上次生成」。规则：**有官方样本的不收编**（`shouldCaptureMmxVoicePreview`），
已有缓存的不覆盖（首次合成那份就是试听）；试听源优先级 `官方样本 > 本地缓存 > 无`。

> ✅ **已实跑验证（2026-09-20）**：见 9.4。**结论是「只有 327 条能用」** —— 音色库独有的
> 320 条平台一律 `Voice not found`。所以数据文件已裁到只剩这 327 条。

### 9.4 实跑结果：只有文档收录的 327 条能用（重要）

App 1.2.23 / 模型 `speech-2.8` / provider `custom:知鸟ai`，一次真实调用：

```
voice: Chinese_casual_instructor_nv1   （音色库独有，doc: false）
→ 海螺 speech-2.8 配音失败: Voice not found
```

`Chinese_casual_instructor_nv1` 在**官方音色库里存在**（有名字「活力讲师」、有描述、**有官方试听 MP3**），
但**不在**官方文档「系统音色列表」里。平台照样不认。

**推论（已据此改 UI）**：
- 官方音色库那 603 条是**海螺音频产品**的音色表，里面还混着 `moss_audio_<uuid>` 这类用户向
  音色 —— **不等于 API 支持的 `voice` 取值**。
- API 真正支持的 `voice` 集合 = 官方文档「系统音色列表」的 **327 条**（+ 你自己克隆/设计产出的 `voice_id`）。
- 所以「有试听」≠「能调用」。试听是 CDN 上的静态 MP3，跟 API 认不认这个 id 完全无关。

**对照验证（同一次批准，紧接着发的第二条）**：

```
voice: Chinese (Mandarin)_Gentleman   （文档收录第 327 条之一，"温润男声"）
input: "胃不好的人会有喉咙堵得慌，有异物感的情况吗？"（22 字符 ≈ $0.00099）
→ HTTP 200 · 59,316 B · audio/mpeg · 3.27 s
→ afinfo: 1 ch / 32,000 Hz / 128 kbps / 3.6 s
→ ID3 里带 "ContentProducer":"MiniMax" + C2PA 溯源块
```

**所以这条路是通的**：`model / input / voice / response_format` 四个字段即可，`voice` 填文档收录的
系统音色 id 就能出声。**「文档收录 ⇒ 平台支持」这个判据成立。**

**据此裁剪（2026-09-20 复审）**：数据文件只保留 327 条；音色库独有的 320 条整批删掉 ——
它们能免费试听，但生成必败，对用户是纯粹的坑。中文普通话：58 条（男 27 / 女 26 / 童 5）。

> ⚠️ 剩下的是**逐条覆盖度**：已确认「文档收录 ⇒ 平台支持」成立（对照调用 200 出声），
> 但 327 条没有一条条跑完。若将来某条收录音色也报 `Voice not found`，把 id 记回本节。
