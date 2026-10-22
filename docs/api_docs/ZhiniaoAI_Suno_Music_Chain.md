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
POST {base}/v1/audio/speech/async        ← 提交, 返回 { task_id }
GET  {base}/v1/tasks/{task_id}           ← 轮询到终态
     → 结果给 CDN URL → 下载落盘
```

与语音链路**共用同一个提交端点族**，靠 `model` 分流（官方说法：
「把 base_url 换成本平台、model 填 `music`，其余请求体保持 GT 原样即可」）。

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
| `operation` | enum | `generate` | 8 种，见下 |
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

模型元数据补充：`max_prompt_chars = 5000`、`tags = [audio, music, suno]`、
`supported_vendors = [AII, APM, BB6, MXH, OLX, TKG]`。

`version` 备注（平台原文）：官方自 2026-09-09 起只提供 V6 系列，旧版本请求自动按 v6 处理；
`v5` / `v4.5` 是个别渠道专供的旧引擎，非官方现役版本。

## 5. 8 种 operation 的字段依赖

| operation | 源 clip 字段 | 需要主题 | 生成类字段生效 | 产出 |
|---|---|---|---|---|
| `generate` | — | ✅ | ✅ | 音频 |
| `extend` | `continue_clip_id`(+`continue_at`) | — | ✅ | 音频 |
| `cover` | `cover_clip_id` | ✅ | ✅ | 音频 |
| `lyrics` | — | ✅ | — | **文本** |
| `stems` | `clip_id` | — | — | 音频（多轨） |
| `stems_all` | `clip_id` | — | — | 音频（多轨，12 路） |
| `mp4` | `clip_id` | — | — | **视频** |
| `concat` | `clip_id` | — | — | 音频 |

这里的「生成类字段」= `version` / `mode` / `style` / `lyrics` / `title` /
`vocal_gender` / `negative_tags`。

## 6. 实现映射

| 层 | 文件 | 内容 |
|---|---|---|
| 协议 | `src/commands/sunoMusic.ts` | 12 字段表、8 operation 规格、请求体构造、校验、响应解析 |
| 链路 | `src/commands/ai.ts` | `generateSunoMusic`（异步提交+轮询+下载）、`generateSunoLyrics`、分发顺序 |
| 端口 | `application/ports.ts` | `SunoMusicPayload`、`GenerateAudioLyricsPayload`、`generateAudioLyrics` |
| 网关 | `infrastructure/tauriAiGateway.ts` | 字段透传 |
| 模型 | `models/registry.ts` | `musicProtocol: 'suno' \| 'generic'`（与链路层同源判定） |
| 节点 | `nodes/audio/SunoMusicStudio.tsx` | 一个 operation 下拉驱动的表单 |
| 节点 | `nodes/audio/SunoTagPicker.tsx` | 风格/排除标签的点选面板（收起态一行） |
| 节点 | `nodes/audio/sunoTagLibrary.ts` | 446 个风格标签 + 89 个排除标签，按分组维护 |
| 节点 | `domain/canvasNodes.ts` | `sunoOperation` / `sunoVersion` / … / `sunoCoverClipId` |

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
因此下拉里是 **7 项**，`lyrics` 走独立入口。

## 7. 待一次实跑确认

| 项 | 现状 | 依据 |
|---|---|---|
| 请求体信封形状 | 按**顶层扁平**构造（与 speech 同端点同风格） | `param_schema` 是顶层字段；字子动画的 `metadata` 信封对本平台不成立 |
| 文本字段名 | 用 `input` | 同端点上 speech-2.8 已用 `input`（见 MiniMax 链路文档） |
| `operation=generate` 是否可省略 | **显式发送** | `default: generate`，显式更不容易出歧义 |
| 响应体形状 | 解析写得**尽量宽容**（深度遍历 + 打分排序） | 未见文档示例，见 `extractSunoFileUrls` |
| clip 标识字段 | 优先 `source_id`，兼容 `clip_id` | `continue_clip_id` 的说明原文：「来自上次生成结果的 source_id」 |

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
