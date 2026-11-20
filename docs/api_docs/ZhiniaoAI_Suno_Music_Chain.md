# 知鸟AI · Suno 音乐链路规格（`music` 模型）

> 事实来源（2026-09-20 实测，全部**免鉴权**可复核）：
> - `GET https://cuai.token6688.com/v1/logical-models` → `models[].param_schema`
>   （**权威字段表**，12 个字段）
> - `GET https://cuai.token6688.com/api/v1/models` → 计费元数据
>   （`unit_price_micro_usd = 171429`、`billing_unit = per_request`）
> - 无 key 路由探测：
>
> | 路径 | 结果 |
> |---|---|
> | `POST /v1/audio/speech` | `401` ✅ 已注册 |
> | `POST /v1/audio/speech/async` | `401` ✅ 已注册 |
> | `GET /v1/tasks/{task_id}` | `401` ✅ 已注册 |
> | `POST /v1/audio/generations` | `401` ✅ 已注册（网关通用别名） |
> | `POST /v1/audio/music` | **`404`** ✗ **不存在** |
>
> **未做任何真实计费调用。** 鉴权在参数校验之前（无 key / 错 key 一律 `401`，拿不到
> 字段级报错），因此「响应体形状」与「文本字段名」标注为**待一次实跑确认**（见第 7 节）。

## 0. 一句话结论

`music` 是 Suno 的音乐生成模型，**一个模型 + 8 种 operation**：
`operation` 决定其余 11 个字段显隐，产出物可能是音频、视频（`mp4`）或**文本**（`lyrics`）。

## 1. 本次修掉的两个真实故障

| 项 | 旧实现 | 平台事实 | 后果 |
|---|---|---|---|
| 端点 | `resolveZzdhAudioPath('music')` → `/v1/audio/music` | 该路径 **404** | **音乐生成一直打不通** |
| 请求体 | `{ model, input, metadata{lyrics_text, music_length_ms} }` | 顶层扁平字段 + `operation` | 即使端点对了平台也不认 |

另外两处是**凭空造的控件**：

- 「演唱音色」下拉 —— `param_schema` 里**没有 `voice`**。声线由 `vocal_gender` 控制。
  （旧提示语「音乐模型通常忽略此项」本身就是承认它没用。）
- 「音乐时长」下拉（15/30/60/120s）—— `param_schema` 里**没有 `music_length_ms`**，
  那是字子动画的字段。Suno 的曲长由模型决定。

## 2. 端点与传输

```
POST {base}/api/v1/model-runtime/invoke   ← 提交(信封), 立即返回 { task_id }
GET  {base}/v1/tasks/{task_id}            ← 轮询到终态
     → 结果给 CDN URL → 下载落盘
```

### 🔴 2.1 为什么不是 `/v1/audio/speech/async`（2026-11-18 修正）

上一版写的是「与语音链路共用同一个提交端点，靠 `model` 分流」——**这条是错的**。
实测（App 1.2.64 用户报障）：

```json
{"error": {"message": "params.voice is required for speech"}}   // HTTP 400
```

`/v1/audio/speech(/async)` 是**语音合成（TTS）专用**端点，固定按 speech 处理，
`operation` 传什么都不会改变它的判断，缺 `params.voice` 就直接 400。音乐卡必须走
`POST /api/v1/model-runtime/invoke`（或扁平别名 `/v1/audio/generations`，但那个端点
固定按「生成」处理，表达不了 `extend/cover/stems`，故不用）。

请求体是**信封**，不是顶层扁平：

```jsonc
{
  "model_id": "music",          // 模型目录里的 id / public_id
  "modality": "audio",          // 音频模态在统一入口里恒为异步
  "operation": "generate",      // 音乐卡必填：不写会被当成 TTS，报 params.input is required
  "params": {
    "prompt": "轻松惬意的民谣",  // 描述/主题；**必须存在**，后处理操作也要给（空串可）
    "version": "chirp-v6",      // 平台会归一成 v6
    "mode": "song",             // song / instrumental
    "style": "民谣, 治愈",
    "lyrics": "[verse]\n...",
    "title": "春日",
    "vocal_gender": "f",        // 仅 song 模式
    "negative_tags": "重金属",
    "clip_id": "…",             // stems/stems_all/mp4/concat
    "continue_clip_id": "…",    // extend
    "cover_clip_id": "…"        // cover
  }
}
```

免鉴权复核手段（**¥0**，不打厂商、不冻结、不计费）：

```
POST {base}/api/v1/model-runtime/dry-run     ← 同一个信封, 返回 wire.body 与命中渠道
```

> dry-run 的 `wire.body` 只展开生成骨架（`prompt/version/custom/style/...`），
> `clip_id` 一类字段在预览里不出现 —— 别据此判断参数被丢弃。

- **异步是必须的**：Suno 出歌中位 60–120 秒，同步长连接不可靠。
- 轮询间隔 **3 秒**（文档「建议每 3 秒轮询一次」）。
- 终态判定必须 **同时看 `state` 与 `status`** —— 文档原文：
  「`is_final=true` 对成功和失败都成立 — 必须看 `state`(success/failed) 或
  `error` 字段区分成败, 别只判 `is_final`」。
- 客户端超时 20 分钟（兜底，不是预期耗时）。

## 3. 计费

| 项 | 值 |
|---|---|
| `billing_unit` | `per_request` |
| `unit_price_micro_usd` | `171429` |
| ≈ ⚡ | **0.171429 / 次** |
| 语义 | 按**提交次数**计费，与时长/字符无关 |

⚠️ 因为按提交计费，且平台**先鉴权后校验**，参数不合法也是在扣费之后才报错 ——
所以 `validateSunoMusicInput` 必须由客户端在**发请求前**挡住。

## 4. 权威字段表（照抄 `param_schema`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `operation` | enum | `generate` | 平台 19 种，本应用登记 9 种，见下 |
| `version` | enum | `chirp-v6` | `chirp-v6` / `chirp-v6-mini` / `chirp-v5` / `chirp-v4-5` |
| `mode` | enum | `song` | `song`(含人声) / `instrumental`(纯器乐) |
| `style` | string | — | 音乐风格/流派/情绪，逗号分隔（映射 Suno `tags`） |
| `lyrics` | string | — | 自定义歌词；**留空 → 灵感模式自动作词**（`gpt_description_prompt`） |
| `title` | string | — | 歌曲标题 |
| `vocal_gender` | enum | `auto` | `auto` / `m` / `f`。**仅 song 模式有效** |
| `negative_tags` | string | — | 不希望出现的风格标签，逗号分隔 |
| `clip_id` | string | — | `stems` / `stems_all` / `mp4` / `concat` **必填** |
| `continue_clip_id` | string | — | `extend` **必填** |
| `continue_at` | string | — | `extend` 可选，不传则从结尾续 |
| `cover_clip_id` | string | — | `cover` **必填** |
| `cover_audio_url` | string | — | `upload_cover` **必填**：公网可下载的音频（mp3/wav/m4a，建议 ≤8 分钟）；非纯音乐模式须同时给 `lyrics` |

字段总数为 **25**，`operation` 的 `enum` 有 **19** 项。本应用只落地 9 项，其余
（`persona` / `import` / `upload_extend` / `inspo` / `sample` / `add_vocals` /
`add_instrumental` / `add_stem` / `replace_section` / `mashup`）各自还需额外字段
（`persona_name`、`audio_urls`、`start_s`/`end_s`、`infill_lyrics`、`second_clip_id`），
**未接入前不要塞进下拉** —— 选了必然失败的项比没有这一项更糟。

模型元数据补充：`max_prompt_chars = 5000`、`tags = [audio, music, suno]`、
`supported_vendors = [AII, APM, BB6, MXH, OLX, TKG]`。

`version` 备注（平台原文）：官方自 2026-09-09 起只提供 V6 系列，旧版本请求自动按 v6 处理；
`v5` / `v4.5` 是个别渠道专供的旧引擎，非官方现役版本。

## 5. 9 种 operation 的字段依赖

| operation | 源 | 需要主题 | 生成类字段生效 | 产出 |
|---|---|---|---|---|
| `generate` | — | ✅ | ✅ | 音频 |
| `extend` | clip: `continue_clip_id`(+`continue_at`) | — | ✅ | 音频 |
| `cover` | clip: `cover_clip_id` | ✅ | ✅ | 音频 |
| `upload_cover` | **音频**: `cover_audio_url` | —（歌曲模式须给 `lyrics`） | ✅ | 音频 |
| `lyrics` | — | ✅ | — | **文本** |
| `stems` | clip: `clip_id` | — | — | 音频（多轨） |
| `stems_all` | clip: `clip_id` | — | — | 音频（多轨，12 路） |
| `mp4` | clip: `clip_id` | — | — | **视频** |
| `concat` | clip: `clip_id` | — | — | 音频 |

这里的「生成类字段」= `version` / `mode` / `style` / `lyrics` / `title` /
`vocal_gender` / `negative_tags`。

### 5.1 `upload_cover`：源是音频文件，不是 clip

这是唯一**不依赖平台内 clip** 的源。三段式：

```
画布上的音频（本地路径 / asset:// / data URL / 公网 URL）
  → uploadZhiniaoReferenceAsset   (/v1/files, 幂等、不计费) → 公网直链
  → dry-run 免费探测「这条直链真的会被发出去吗」
  → POST /api/v1/model-runtime/invoke {operation:'upload_cover', params.cover_audio_url}
```

节点侧存的是**原始地址**（`sunoCoverAudioUrl`），不做预改写：改写只能发生在提交那一刻，
否则本地文件被换成 24 小时后失效的图床 URL，重开工程就再也上传不了。

#### 🔴 实测：当前平台渠道会丢弃源音频（2026-11-18）

`POST /api/v1/model-runtime/dry-run`（同信封，¥0）逐渠道验证的结果：

| lane | `candidate_type` | 发出去的 body | 有源吗 |
|---|---|---|---|
| `music@APM:default` | `apimart-suno-async` | `{"custom":true,"instrumental":true,"style":"jazz","version":"v6"}` | ❌ |
| `music@MXH:default` | `suno-music-async` | `{"make_instrumental":true,"mv":"chirp-hawk","prompt":"","tags":"jazz"}` | ❌ |
| `music@AII` / `music@BB6` | — | 锁渠道 + `version=chirp-v6` → `503 dry_run_no_route` | — |
| `music@OLX` | — | `422 pinned_channel_unavailable` | — |

`cover_audio_url`（以及 `cover_clip_id`、`audio_url`）在**所有可用渠道**都被映射器
静默丢弃 —— 也就是提交后会扣 ⚡0.1714 却生成一首全新的歌，用户看不出原因。

因此链路层加了守卫 `assertSunoSourceReachesUpstream`：提交前跑一次 dry-run，比对
`wire` 里是否出现源（整串 → host → 路径 → 文件名逐级放宽，见
`sunoDryRunCarriesSource`）；不含则**不提交**，直接报出「平台渠道未透传源音频」。
dry-run 本身失败也拦（付费操作，没有证据就不替平台担保）。

平台修好渠道映射后，这个守卫会自动放行，不需要改代码。

## 6. 实现映射

| 层 | 文件 | 内容 |
|---|---|---|
| 协议 | `src/commands/sunoMusic.ts` | 25 字段表、9 operation 规格、请求体构造、校验、响应解析、`sunoDryRunCarriesSource` |
| 链路 | `src/commands/ai.ts` | `generateSunoMusic`（上传源音频 → dry-run 守卫 → 异步提交+轮询+下载）、`generateSunoLyrics`、分发顺序 |
| 端口 | `application/ports.ts` | `SunoMusicPayload`、`GenerateAudioLyricsPayload`、`generateAudioLyrics` |
| 网关 | `infrastructure/tauriAiGateway.ts` | 字段透传（含 `suno_cover_audio_url`） |
| 模型 | `models/registry.ts` | `musicProtocol: 'suno' \| 'generic'`（与链路层同源判定） |
| 节点 | `nodes/audio/SunoMusicStudio.tsx` | 一个 operation 下拉驱动的表单（含「源音频」选择） |
| 节点 | `nodes/audio/SunoTagPicker.tsx` | 风格/排除标签的点选面板（收起态一行） |
| 节点 | `nodes/audio/sunoTagLibrary.ts` | 446 个风格标签 + 89 个排除标签，按分组维护 |
| 节点 | `domain/canvasNodes.ts` | `sunoOperation` / `sunoVersion` / … / `sunoCoverClipId` / `sunoCoverAudioUrl` |

### 分发顺序（`generateAudio`）

```
1. MiniMax 三件套        voice-clone / voice-design / speech-2.8
2. 字子动画              audio_transport === 'zzdh-openai-audio' 或 zzdh base url
3. Suno                  isSunoMusicModel(apiModel)  ← 只认裸 `music`
4. OpenAI 兼容兜底
```

第 2 步排在 Suno 之前是刻意的：字子动画的 `music-2.6` 走
`/v1/audio/music` + `metadata{…}`，与 Suno 是**两套协议**。

`isSunoMusicModel` **精确匹配** `music` / `suno`，不做宽匹配 ——
`music-2.6`、`suno-v3` 这类名字属于别家平台，宽匹配会把它们误判进 Suno 链路。

### `lyrics` 为什么不在「操作」下拉里

`operation=lyrics` 的产出是**歌词文本**，不是音频/视频。把它放进下拉会让「生成」按钮
在一个产出文本的操作上返回「媒体路径」。所以做成歌词框旁边的 **「AI 写词」按钮**，
结果直接回填歌词框 —— 与平台自身的 UI 一致（其文案为「请先在描述框输入歌曲主题」）。
因此下拉里是 **8 项**，`lyrics` 走独立入口。

## 7. 待一次实跑确认

| 项 | 现状 | 依据 |
|---|---|---|
| 请求体信封形状 | **已确认**：信封 `{model_id, modality, operation, params}` | openapi.json + dry-run 实测（2026-11-18） |
| 文本字段名 | 用 `params.prompt`（`params.input` 是等价别名） | dry-run：两种写法都映射成上游 `prompt` |
| `operation=generate` 是否可省略 | **必须显式发送** | dry-run：不写 → `400 params.input is required`（被当成 TTS） |
| 响应体形状 | 解析写得**尽量宽容**（深度遍历 + 打分排序） | 未见文档示例，见 `extractSunoFileUrls` |
| clip 标识字段 | 优先 `source_id`，兼容 `clip_id` | `continue_clip_id` 的说明原文：「来自上次生成结果的 source_id」 |
| `upload_cover` 源音频是否真的送厂 | **当前渠道未实现**（静默丢弃），已加 dry-run 守卫 | dry-run 逐渠道实测，见 §5.1 |
| `cover` 的 `cover_clip_id` 是否真的送厂 | **同样未实现**（同一映射器丢弃），尚未加守卫 | 同上；用 cover 前建议先 dry-run 确认 |

按铁律：真实计费端点需**逐个征得同意后一次一条**验证，单价 ⚡0.1714/次。

## 8. 已知取舍

1. **多轨只落第一条**。`stems` / `stems_all` 平台返回多条音轨，而 `generateAudio` 的
   契约是「返回一个媒体路径」。`extractSunoFileUrls` 会给字段路径含 `vocal` 的加分，
   所以拿到的通常是人声轨。UI 上对此有明确提示。
2. **clip 映射只存内存**。`sunoClipIdByResultPath` 是模块级 Map（与即梦 CLI 的 job map
   同样取舍）—— 应用重启后历史结果查不到 clip，需手填。
3. **`mp4` 落到音频节点**。产出的是 MP4 视频文件，但节点输出契约是音频媒体节点。
   UI 上标注了「该操作产出的是 MP4 视频文件，不是音频」。
4. **出片的封面图不会被当成音频**。`extractSunoFileUrls` 对图片扩展名直接判负分并剔除；
   若结果里只有图片，返回空数组让上层报「没有产出」，而不是拿封面图当音频播。

## 9. UI 补充：顶部输入框的说明 + 标签库

### 9.1 节点顶部那个大输入框是什么

它是 `style` **之外的**那一半信息 —— 节点主输入框 = `description`，链路层映射到
Suno 的 **主题 / 描述**（`gpt_description_prompt` 那一侧），同时是
`operation=lyrics`（AI 写词）的输入源。

所以两条分工是硬的：

| 框 | 写什么 | 映射 |
|---|---|---|
| 顶部大输入框 | **唱什么**：主题、故事、画面、情绪、人称 | 主题/描述 |
| 「风格标签」 | **怎么唱**：曲风、乐器、人声、编制 | Suno `tags` |
| 「排除风格」 | 不要什么 | Suno `negative_tags` |

因为该框没有 label，Suno 页做了三件事让它自解释：
`promptHint` 灰字（工作室滚动区第一行，紧贴框下方）+ Suno 专属
`promptPlaceholder` + 输入框 `title` 提示（打字后 placeholder 消失，靠 title 兜底）。

### 9.2 标签库

`SUNO_STYLE_TAG_GROUPS` / `SUNO_NEGATIVE_TAG_GROUPS` 两套数据，7 组 + 4 组：

| 风格库（446） | 排除库（89） |
|---|---|
| 曲风流派 102 / 情绪氛围 80 / 乐器编制 75 / 人声演唱 55 / 编曲制作 49 / 场景题材 59 / 语言地区 26 | 排除曲风 28 / 排除人声 18 / 排除音质缺陷 23 / 排除情绪与题材 20 |

三条设计约定：

1. **收起态只占一行**。节点高度固定（默认 560px），风格库几百个词常驻会把输入区
   挤没，所以默认收起、只显示「已选 N 个」，点开才铺（`max-h-40` 内滚）。
2. **按值 toggle，不存第二份状态**。chip 高亮由字段值 `parseTagList` 推导，
   所以手改输入框也会立刻反映到 chip 上；点一下加入、再点移除，
   移除时**保持其余标签原顺序**（不打乱用户手填的次序）。
3. **标签是数据，不走 i18n**。这些词会原样写进提示词（`style` → Suno `tags`），
   属于「内容」而非界面外壳，与模型名/音色名同性质。**分组标题**才是界面文案，
   走 `node.audioGen.suno.tagGroups.*`（中英双份）。

分隔符解析容忍 `,` `，` `、` `;` `；`，回写统一成 `", "` —— 用户从别处粘一串
中文逗号分隔的词，不该被当成一个巨型标签。

不变量（`sunoTagLibrary.test.ts` 里守着）：**同一个标签只出现在一个分组里**。
高亮是按值判定的，跨组重复会让「点 A 组、B 组那个词也跟着亮」——
这类错误人眼扫 400 个词扫不出来，只能靠测试。
