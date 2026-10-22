import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Loader2,
  LocateFixed,
  Play,
  Plus,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";

import {
  isRemoteConfigured,
  listLenTalkChatModels,
  loadAISettings,
  resolveLenTalkChatModel,
  type AISettings,
  type LenTalkChatModelOption,
} from "@/features/cinematicStudio/app/providers/aiSettings";
import { openSettingsDialog } from "@/features/settings/settingsEvents";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";

import { selectSessionsForProject, useAgentStore } from "./agentStore";
import { extractNodeMediaUrl, extractToolResultNodeIds, getCanvasAgentSnapshot } from "./canvasContext";
import {
  formatSummaryForSystemPrompt,
  summarizeHistory,
  mechanicalTrim,
  prepareHistory,
} from "./contextCompression";
import {
  CANVAS_ACCESS_HINTS,
  CANVAS_ACCESS_LABELS,
  buildCanvasToolPrompt,
  formatCanvasSnapshotForPrompt,
  formatCanvasToolResults,
  parseCanvasReply,
  stripCanvasToolBlocks,
  type CanvasAgentAccessLevel,
} from "./canvasToolProtocol";
import {
  MAX_CANVAS_TOOL_ROUNDS,
  confirmAndRunCanvasToolCall,
  runCanvasToolCall,
} from "./canvasToolRunner";
import { streamChat } from "./llmClient";
import { MarkdownText } from "./MarkdownText";
import {
  AGENT_SKILLS,
  composeAgentSystemPrompt,
  findAgentSkill,
  type AgentSkill,
} from "./skills";
import type { AgentChatTurn, AgentMessage, AgentModelSelection, AgentToolCallRecord } from "./types";
import { useThumbnailFallback } from "@/features/canvas/ui/useCanvasImageSource";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { useCanvasStore } from "@/stores/canvasStore";

export interface AgentPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 基础人设。画布能力由 `buildCanvasToolPrompt` 按权限档位动态追加，
 * 实时画布快照由每次发送时注入 —— 三者拼在一起才是完整的 system prompt。
 *
 * 措辞上刻意强调「以系统给的现状为准」：模型对画布的唯一可靠信息来源是那份快照，
 * 一旦放任它凭印象描述节点，编出来的清单比承认不知道更有害。
 */
const SYSTEM_PROMPT = [
  "你是 LenTalk Copilot 内置的创作助手，帮助用户构思故事、深化情节、撰写提示词，并直接读写用户的画布。",
  "回答使用简体中文，简洁、具体、可执行；涉及创作建议时直接给出可用的文本，而不是泛泛而谈。",
  "关于画布：系统消息里的「画面现状」是当前画布的真实内容，节点名称（同名会带 #2、#3 后缀）与它完全一致，",
  "你对画布的一切描述都必须以它为准；快照里没有的节点就是不存在，不要凭印象补充。",
  "需要更完整的信息（例如某个节点的完整提示词）时，用画布工具去读，不要猜测。",
].join("");

const SUGGESTIONS = [
  "看看我画布上有什么，帮我理一下创作顺序",
  "帮我想三个悬疑短片的开场钩子",
  "把这段情节深化成一场戏：主角发现信是伪造的",
  "写一段赛博朋克城市夜景的文生图提示词",
];

function selectionKey(selection: AgentModelSelection | null): string {
  return selection ? `${selection.providerId}::${selection.model}` : "";
}

function parseSelectionKey(value: string): AgentModelSelection | null {
  if (!value) return null;
  const index = value.indexOf("::");
  if (index < 0) return null;
  return { providerId: value.slice(0, index), model: value.slice(index + 2) };
}

// ---------------------------------------------------------------------------
// 待确认操作的执行与结果回填
// ---------------------------------------------------------------------------

/** 生成最长等多久（视频偶尔要几分钟），超时就别再挂着「生成中」了 */
const MEDIA_WATCH_TIMEOUT_MS = 15 * 60 * 1000;

interface PendingMediaWatch {
  sessionId: string;
  messageId: string;
  recordIndex: number;
  /** 被触发的源节点 */
  sourceNodeId: string;
  /** 确认那一刻相关节点已有的媒体地址 —— 用来区分"新结果"和"本来就有的" */
  baseline: Map<string, string | null>;
  startedAt: number;
}

/** 与源节点相关的全部节点（它自己 + 它的直接下游） */
function collectRelatedNodeIds(sourceNodeId: string): Set<string> {
  const state = useCanvasStore.getState();
  const related = new Set<string>([sourceNodeId]);
  for (const edge of state.edges) {
    if (edge.source === sourceNodeId) related.add(edge.target);
  }
  return related;
}

function buildMediaBaseline(sourceNodeId: string): Map<string, string | null> {
  const state = useCanvasStore.getState();
  const related = collectRelatedNodeIds(sourceNodeId);
  const baseline = new Map<string, string | null>();
  for (const node of state.nodes) {
    if (!related.has(node.id)) continue;
    baseline.set(node.id, extractNodeMediaUrl(node.data as Record<string, unknown>));
  }
  return baseline;
}

/** 找"新冒出来"的媒体地址：结果节点是生成过程中才 create 出来的，所以不在 baseline 里 */
function findNewlyGeneratedMedia(watch: PendingMediaWatch): string | null {
  const state = useCanvasStore.getState();
  const related = collectRelatedNodeIds(watch.sourceNodeId);
  for (const node of state.nodes) {
    if (!related.has(node.id)) continue;
    const url = extractNodeMediaUrl(node.data as Record<string, unknown>);
    if (!url) continue;
    if (url !== (watch.baseline.get(node.id) ?? null)) return url;
  }
  return null;
}

/** 改写某条工具记录（一律走 getState()，避免闭包里拿到过期的消息数组） */
function patchToolRecord(
  sessionId: string,
  messageId: string,
  recordIndex: number,
  patch: Partial<AgentToolCallRecord>,
): void {
  const state = useAgentStore.getState();
  const session = state.sessions.find((item) => item.id === sessionId);
  const message = session?.messages.find((item) => item.id === messageId);
  const records = message?.toolCalls ?? [];
  if (recordIndex >= records.length) return;
  const next = records.map((item, index) => (index === recordIndex ? { ...item, ...patch } : item));
  state.patchMessage(sessionId, messageId, { toolCalls: next });
}

/**
 * AI 回复里回显的生成结果。
 *
 * **只引用，不复制**：这里显示的就是画布上那份素材本身。
 * 预览刻意走画布那套缩略图缓存 —— 同一张图在画布里早就生成过缩略图，
 * 这里直接命中，既不额外落一份文件，也不用再解码一张大图。
 */
function AgentMediaPreview({ url }: { url: string }) {
  const thumbnail = useThumbnailFallback(url);
  return (
    <a
      href={resolveImageDisplayUrl(url)}
      target="_blank"
      rel="noreferrer"
      title="点击查看原图"
      className="mt-1 block overflow-hidden rounded border border-border-dark"
    >
      {thumbnail.url ? (
        <img
          src={thumbnail.url}
          alt="生成结果"
          className="max-h-48 w-full object-cover object-top"
          decoding="async"
        />
      ) : (
        <div className="flex h-24 w-full animate-pulse items-center justify-center bg-white/[0.06] text-[10px] text-text-muted">
          缩略图生成中…
        </div>
      )}
    </a>
  );
}

/**
 * SKILL 缩略图。
 *
 * 没有配图（或图挂了）时回退成「名字首字」色块 ——
 * 直接渲染一个空的 `<img>` 会留下破图图标，比不显示图更难看。
 */
function SkillThumbnail({ skill }: { skill: AgentSkill }) {
  const [failed, setFailed] = useState(false);
  if (!skill.thumbnail || failed) {
    return (
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-bg-dark text-[13px] font-medium text-text-muted">
        {skill.name.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      src={skill.thumbnail}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="h-9 w-9 shrink-0 rounded bg-bg-dark object-cover"
    />
  );
}

function AgentPanelImpl({ open, onClose }: AgentPanelProps) {
  const projectId = useProjectStore((state) => state.currentProjectId);
  const customApis = useSettingsStore((state) => state.customApis);

  const hydrated = useAgentStore((state) => state.hydrated);
  const sessions = useAgentStore((state) => state.sessions);
  const activeSessionId = useAgentStore((state) => state.activeSessionId);
  const streaming = useAgentStore((state) => state.streaming);
  const storeSelection = useAgentStore((state) => state.selection);
  const storeSkillId = useAgentStore((state) => state.skillId);
  const canvasAccess = useAgentStore((state) => state.canvasAccess);

  const hydrate = useAgentStore((state) => state.hydrate);
  const createSession = useAgentStore((state) => state.createSession);
  const deleteSession = useAgentStore((state) => state.deleteSession);
  const setActiveSession = useAgentStore((state) => state.setActiveSession);
  const setSelection = useAgentStore((state) => state.setSelection);
  const setSkill = useAgentStore((state) => state.setSkill);
  const setCanvasAccess = useAgentStore((state) => state.setCanvasAccess);
  const appendMessage = useAgentStore((state) => state.appendMessage);
  const patchMessage = useAgentStore((state) => state.patchMessage);
  const beginStreaming = useAgentStore((state) => state.beginStreaming);
  const endStreaming = useAgentStore((state) => state.endStreaming);
  const setContextSummary = useAgentStore((state) => state.setContextSummary);

  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  /** 正在压缩早期上下文：此时还没开始请求，但同样要挡住重复发送 */
  const [compressing, setCompressing] = useState(false);
  const [compressionStatus, setCompressionStatus] = useState<string | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 输入框：随草稿内容自动长高，长文不必在 2 行的小窗里来回滚 */
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** 消息列表的包裹层：生成结果的图片是**异步撑高**的，靠它感知内容高度变化 */
  const contentRef = useRef<HTMLDivElement | null>(null);
  /**
   * 是否吸附在底部。
   *
   * 只有用户**主动往上翻**看历史时才置 false —— 那种情况下新消息来了不该把他拽回底部；
   * 他自己滚回底部 64px 以内就自动恢复吸附。其余所有情况（打开面板、切会话、
   * 图片加载完撑高）都应当贴着最新一条。
   */
  const pinnedToBottomRef = useRef(true);

  const scrollThreadToBottom = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, []);

  const handleThreadScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    pinnedToBottomRef.current = distanceToBottom < 64;
  }, []);

  /**
   * 打开面板 / 切换会话：**无条件**回到最新一条。
   *
   * 以前只在「消息变了」时滚一次 —— 但面板是靠 `return null` 卸载的，重新打开时
   * 消息数组没变、effect 不重跑，于是每次都停在会话开头。
   * 用双层 rAF：第一帧让 React 把消息真正挂到 DOM，第二帧布局完成才拿得到真实 scrollHeight。
   */
  useEffect(() => {
    if (!open) return;
    pinnedToBottomRef.current = true;
    let innerFrame = 0;
    const outerFrame = requestAnimationFrame(() => {
      scrollThreadToBottom();
      innerFrame = requestAnimationFrame(scrollThreadToBottom);
    });
    return () => {
      cancelAnimationFrame(outerFrame);
      if (innerFrame) cancelAnimationFrame(innerFrame);
    };
  }, [open, activeSessionId, scrollThreadToBottom]);

  /**
   * 内容异步撑高时继续贴底。
   *
   * 生成结果的媒体卡片要等图片解码完才有高度，而那一刻**不会触发 React 重渲染**，
   * 上面那个按消息数组变化的 effect 抓不到 —— 表现就是「打开时在底部，一秒钟后
   * 被顶到中间」。ResizeObserver 盯包裹层才能覆盖这种情况。
   */
  useEffect(() => {
    if (!open) return;
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinnedToBottomRef.current) scrollThreadToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [open, scrollThreadToBottom]);
  /** 等着把生成结果回填到卡片上的监听 */
  const mediaWatchesRef = useRef<PendingMediaWatch[]>([]);

  const projectSessions = useMemo(
    () => selectSessionsForProject(sessions, projectId ?? null),
    [sessions, projectId],
  );
  const activeSession = useMemo(
    () => projectSessions.find((session) => session.id === activeSessionId) ?? null,
    [projectSessions, activeSessionId],
  );

  // `listLenTalkChatModels` / `loadAISettings` 读的是 settingsStore 的 getState() 快照，
  // 本身不响应式；customApis 在这里是**刻意的失效触发器**——用户在设置里增删
  // Chat 模型后，这两个值必须重算，否则下拉框会停在旧列表上。
  /* eslint-disable react-hooks/exhaustive-deps -- customApis 是刻意的失效触发器，见上方说明 */
  const modelOptions = useMemo(() => listLenTalkChatModels(), [customApis]);

  const defaultSelection = useMemo<AgentModelSelection | null>(() => {
    const settings = loadAISettings();
    return settings.provider && settings.model
      ? { providerId: settings.provider, model: settings.model }
      : null;
  }, [customApis]);
  /* eslint-enable react-hooks/exhaustive-deps */

  const selection = activeSession?.selection ?? storeSelection ?? defaultSelection;
  // SKILL 优先取当前会话上存的值；**没有活动会话时回退到 store 的待用值** ——
  // 与 `selection` 同一套思路。否则「新项目里还没聊过」时点加载 SKILL 会毫无反应。
  const activeSkillId = activeSession ? activeSession.skillId ?? null : storeSkillId ?? null;
  const activeSkill = useMemo(() => findAgentSkill(activeSkillId), [activeSkillId]);
  const isBusy = Boolean(streaming) || compressing;

  /**
   * 输入框随内容自动长高。
   *
   * 以前固定 2 行，写长提示词得在小窗里上下滚，很难看全。
   * 现在 2 行起步，随草稿撑高，到 `max-h-44`（约 9 行）后转入内部滚动。
   * 每次（包括发送清空后）先回到 `auto` 再量 `scrollHeight`，
   * 否则高度只增不减。
   */
  useEffect(() => {
    const el = composerTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, open]);

  // 新消息 / 流式增量：吸附时跟随；用户正在翻历史就不打断他
  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    scrollThreadToBottom();
  }, [activeSession?.messages, streaming, scrollThreadToBottom]);

  /** 模型按平台分组：模型多时平铺看不出归属，分组后和「选模型」面板的观感一致 */
  const groupedModelOptions = useMemo(() => {
    const groups = new Map<string, LenTalkChatModelOption[]>();
    for (const option of modelOptions) {
      const list = groups.get(option.providerName) ?? [];
      list.push(option);
      groups.set(option.providerName, list);
    }
    return [...groups.entries()];
  }, [modelOptions]);

  /**
   * 工具条上的三个浮层（权限 / SKILL / 模型）**互斥**：
   * 同时只开一个，否则两块面板会叠在同一片区域里。
   */
  const toggleComposerPanel = useCallback((panel: "access" | "skills" | "models") => {
    setShowAccess((current) => (panel === "access" ? !current : false));
    setShowSkills((current) => (panel === "skills" ? !current : false));
    setShowModels((current) => (panel === "models" ? !current : false));
  }, []);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // 打开面板时若尚无选中会话，自动落到当前项目最近的一次对话
  useEffect(() => {
    if (!open || !hydrated || activeSession) return;
    const first = projectSessions[0];
    if (first) setActiveSession(first.id);
  }, [open, hydrated, activeSession, projectSessions, setActiveSession]);

  /**
   * 工具条浮层：点面板外或按 Escape 收起。
   *
   * 触发按钮与面板都包在 `[data-agent-popover]` 里，`pointerdown` 命中它们时不算「点外面」
   * —— 否则按钮自己的 onClick 还没跑到，面板就先被关了，表现成「点了没反应」。
   */
  useEffect(() => {
    if (!showAccess && !showSkills && !showModels) return;
    const closeAll = () => {
      setShowAccess(false);
      setShowSkills(false);
      setShowModels(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-agent-popover]")) return;
      closeAll();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAll();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showAccess, showSkills, showModels]);

  /**
   * 盯住画布，等生成结果冒出来就回填到对应的工具卡片上。
   *
   * 订阅的是整个 canvasStore（生成过程中结果节点是新建的，节点数会变），
   * 但只有存在待回填的监听时才做实际计算，空转成本可忽略。
   */
  useEffect(() => {
    const unsubscribe = useCanvasStore.subscribe(() => {
      const watches = mediaWatchesRef.current;
      if (watches.length === 0) return;
      const now = Date.now();
      const keep: PendingMediaWatch[] = [];
      for (const watch of watches) {
        const mediaUrl = findNewlyGeneratedMedia(watch);
        if (mediaUrl) {
          patchToolRecord(watch.sessionId, watch.messageId, watch.recordIndex, {
            ok: true,
            pending: false,
            message: "已完成生成，结果如下（引用自画布，未额外复制文件）。",
            mediaUrl,
          });
          continue;
        }
        if (now - watch.startedAt > MEDIA_WATCH_TIMEOUT_MS) {
          patchToolRecord(watch.sessionId, watch.messageId, watch.recordIndex, {
            ok: false,
            message: "等待生成结果超时，可能是任务失败或已取消 —— 可以到画布上看一眼那个节点。",
          });
          continue;
        }
        keep.push(watch);
      }
      mediaWatchesRef.current = keep;
    });
    return unsubscribe;
  }, []);

  const resolveSettings = useCallback((target: AgentModelSelection | null): AISettings => {
    return target ? resolveLenTalkChatModel(target.providerId, target.model) : loadAISettings();
  }, []);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    // `abortRef` 覆盖「压缩中」与「流式中」两个阶段：前者 `streaming` 还是 null，
    // 只看 store 的话连按两次 Enter 会并发起两轮请求。
    if (!text || abortRef.current || useAgentStore.getState().streaming) return;

    const sessionId = activeSession?.id ?? createSession(projectId ?? null);
    // createSession 之后 store 已同步更新，这里必须重新取一次，不能用闭包里的旧数组
    const session = useAgentStore.getState().sessions.find((item) => item.id === sessionId) ?? null;
    const history = session?.messages ?? [];
    const target = session?.selection ?? useAgentStore.getState().selection ?? defaultSelection;
    const settings = resolveSettings(target);
    // 取的是**这个会话**加载的 SKILL，而不是面板上正在显示的那份 —— 两者通常一致，
    // 但刚新建会话、或用户在流式期间切换时可能不同，规则必须跟着消息走。
    const targetSkill = findAgentSkill(session?.skillId ?? null);
    // 权限档位取的是**发送这一刻**的值：中途改档只影响下一条消息
    const level = useAgentStore.getState().canvasAccess;

    if (!isRemoteConfigured(settings)) {
      setNotice("尚未配置可用的 Chat 模型：请到「设置 → 自定义平台」添加模型并填入 API Key。");
      return;
    }
    setNotice(null);

    const userMessage: AgentMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    const assistantId = crypto.randomUUID();
    const assistantMessage: AgentMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      pending: true,
      modelLabel: target?.model ?? settings.model,
    };

    appendMessage(sessionId, userMessage);
    appendMessage(sessionId, assistantMessage);
    setDraft("");

    const controller = new AbortController();
    abortRef.current = controller;

    /** 压缩阶段被中止：还没进入流式，但要保证占位消息不会一直转圈 */
    const cancelDuringCompression = () => {
      abortRef.current = null;
      endStreaming();
      patchMessage(sessionId, assistantId, {
        content: "",
        pending: false,
        error: "已停止生成",
      });
    };

    /**
     * 超长历史的压缩在**组装请求之前**做：摘要要落盘、要拼进 system prompt，
     * 不能事后再补。只在真正超预算时才发请求，平时这一步是纯计算（零延迟）。
     */
    let keepMessages = history;
    let summary = session?.contextSummary ?? null;
    if (history.length > 0) {
      try {
        setCompressing(true);
        const prepared = await prepareHistory({
          messages: history,
          summary,
          summarize: (turns, previousSummary) =>
            summarizeHistory({
              settings,
              turns,
              previousSummary,
              signal: controller.signal,
              onProgress: setCompressionStatus,
            }),
        });
        if (prepared.compressed && prepared.summary) {
          summary = prepared.summary;
          setContextSummary(sessionId, prepared.summary);
        }
        keepMessages = prepared.keep;
      } catch (error) {
        if (controller.signal.aborted) {
          // 用户在压缩阶段点了停止：不留半截状态，直接按「已停止」收尾
          cancelDuringCompression();
          return;
        }
        // 压缩失败不该连对话一起断掉 —— 退化成机械裁剪，并如实说明原因
        keepMessages = mechanicalTrim(history, summary);
        const reason = error instanceof Error ? error.message : String(error);
        setNotice(`早期对话压缩失败（${reason}），本轮只携带了最近的部分对话；下次发送会自动重试。`);
      } finally {
        setCompressing(false);
        setCompressionStatus(null);
      }
    }
    if (controller.signal.aborted) {
      cancelDuringCompression();
      return;
    }

    // 快照按发送那一刻现取：模型对画布的唯一可靠信息来源就是它
    const summaryBlock = formatSummaryForSystemPrompt(summary);
    const systemPrompt = [
      composeAgentSystemPrompt(SYSTEM_PROMPT, targetSkill),
      "",
      formatCanvasSnapshotForPrompt(getCanvasAgentSnapshot()),
      buildCanvasToolPrompt(level),
      summaryBlock ? `\n${summaryBlock}` : "",
    ].join("\n");

    // 历史里的画布操作要把执行结果一起带回去，否则模型看不到自己上一轮做过什么，
    // 会重复建节点或反复问同一件事。
    const historyTurns: AgentChatTurn[] = [];
    for (const message of keepMessages) {
      if (message.role === "system" || !message.content.trim()) continue;
      historyTurns.push({ role: message.role, content: message.content });
      if (message.role === "assistant" && message.toolCalls?.length) {
        historyTurns.push({ role: "user", content: formatCanvasToolResults(message.toolCalls) });
      }
    }

    const turns: AgentChatTurn[] = [
      { role: "system", content: systemPrompt },
      ...historyTurns,
      { role: "user", content: text },
    ];

    beginStreaming(sessionId, assistantId);

    const records: AgentToolCallRecord[] = [];
    const settledTexts: string[] = [];

    /** 已完成轮次的文本 + 当前轮正在流式的文本 */
    const displayText = (current: string) =>
      [...settledTexts, current].filter((part) => part.trim().length > 0).join("\n\n");

    const commit = (patch: Partial<AgentMessage> = {}) => {
      patchMessage(sessionId, assistantId, {
        content: displayText(""),
        pending: false,
        toolCalls: records.length > 0 ? [...records] : undefined,
        ...patch,
      });
    };

    try {
      for (let round = 0; round < MAX_CANVAS_TOOL_ROUNDS; round += 1) {
        let accumulated = "";
        await streamChat({
          settings,
          messages: turns,
          signal: controller.signal,
          onDelta: (delta) => {
            accumulated += delta;
            // 流式期间不写盘：一轮回答几百个 token，逐次落盘会明显卡顿。
            // 工具块在打字过程中就要剥掉，否则半截 JSON 会闪一下再消失。
            patchMessage(
              sessionId,
              assistantId,
              { content: displayText(stripCanvasToolBlocks(accumulated)) },
              { persist: false },
            );
          },
        });

        const parsed = parseCanvasReply(accumulated);
        settledTexts.push(parsed.text);

        // 没有工具调用（也没有写坏的块）＝ 这一轮就是最终回答
        if (parsed.calls.length === 0 && parsed.errors.length === 0) break;

        const roundRecords = parsed.calls.map((call) => runCanvasToolCall(call, level));
        records.push(...roundRecords);

        patchMessage(
          sessionId,
          assistantId,
          { content: displayText(""), toolCalls: [...records] },
          { persist: false },
        );

        // 有待用户确认的操作就到此为止：后续步骤多半依赖生成结果，
        // 让模型在「还没生成」的前提下继续规划只会产出一堆空话。
        if (roundRecords.some((item) => item.pending)) break;

        // 把模型这一轮的原文（含工具块）+ 真实执行结果接回上下文，它才能接着往下走
        turns.push({ role: "assistant", content: accumulated });
        turns.push({ role: "user", content: formatCanvasToolResults(roundRecords, parsed.errors) });

        if (round === MAX_CANVAS_TOOL_ROUNDS - 1) {
          settledTexts.push("（本轮画布操作已达次数上限，如需继续请再发一条消息。）");
        }
      }
      const hasOutput = displayText("").trim().length > 0 || records.length > 0;
      commit({ error: hasOutput ? undefined : "模型没有返回内容。" });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      commit({
        error: aborted
          ? "已停止生成"
          : error instanceof Error
            ? error.message
            : String(error),
      });
    } finally {
      abortRef.current = null;
      endStreaming();
    }
  }, [
    activeSession?.id,
    appendMessage,
    beginStreaming,
    createSession,
    defaultSelection,
    draft,
    endStreaming,
    patchMessage,
    projectId,
    resolveSettings,
    setContextSummary,
  ]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** 用户点了「执行」：这一刻才真正调用工具（会花钱的、或者要删东西的） */
  const handleConfirmToolCall = useCallback((messageId: string, recordIndex: number) => {
    const state = useAgentStore.getState();
    const sessionId = state.activeSessionId;
    if (!sessionId) return;
    const message = state.sessions
      .find((item) => item.id === sessionId)
      ?.messages.find((item) => item.id === messageId);
    const target = message?.toolCalls?.[recordIndex];
    if (!target || !target.pending) return;

    const executed = confirmAndRunCanvasToolCall(
      { tool: target.tool, arguments: target.arguments },
      state.canvasAccess,
    );
    patchToolRecord(sessionId, messageId, recordIndex, { ...executed, pending: false, skipped: false });

    // 生成是长任务：登记监听，等画布上出现结果就把媒体引用回填到这张卡片
    const nodeId = (executed.data as { nodeId?: string } | undefined)?.nodeId;
    if (executed.ok && target.tool === "canvas.run_node" && nodeId) {
      mediaWatchesRef.current.push({
        sessionId,
        messageId,
        recordIndex,
        sourceNodeId: nodeId,
        baseline: buildMediaBaseline(nodeId),
        startedAt: Date.now(),
      });
      patchToolRecord(sessionId, messageId, recordIndex, {
        message: "已开始生成，完成后会把结果带回到这里…",
      });
    }
  }, []);

  const handleSkipToolCall = useCallback((messageId: string, recordIndex: number) => {
    const sessionId = useAgentStore.getState().activeSessionId;
    if (!sessionId) return;
    patchToolRecord(sessionId, messageId, recordIndex, {
      pending: false,
      skipped: true,
      ok: false,
      message: "已跳过，没有执行。",
    });
  }, []);

  /**
   * 把画布镜头移到这张卡片碰过的节点上。
   *
   * 只投递请求，真正取景由 Canvas 里的 effect 调 `fitView` 完成 ——
   * 视口是 React Flow 的非受控状态，这里拿不到它的实例。
   */
  const handleLocateToolCall = useCallback((nodeIds: string[]) => {
    useCanvasStore.getState().requestFocusNodes(nodeIds);
  }, []);

  const handleNewSession = useCallback(() => {
    if (useAgentStore.getState().streaming) return;
    createSession(projectId ?? null);
    setShowSessions(false);
    setNotice(null);
  }, [createSession, projectId]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      if (useAgentStore.getState().streaming) return;
      setActiveSession(sessionId);
      setShowSessions(false);
    },
    [setActiveSession],
  );

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      if (useAgentStore.getState().streaming) return;
      deleteSession(sessionId);
      setShowSessions(false);
    },
    [deleteSession],
  );

  const handleModelChange = useCallback(
    (value: string) => {
      setSelection(parseSelectionKey(value));
    },
    [setSelection],
  );

  const handleSkillPick = useCallback(
    (skillId: string | null) => {
      if (useAgentStore.getState().streaming) return;
      setSkill(skillId);
      setShowSkills(false);
    },
    [setSkill],
  );

  if (!open) return null;

  const messages = activeSession?.messages ?? [];
  const contextSummary = activeSession?.contextSummary ?? null;

  return (
    <aside
      className="absolute right-4 top-16 z-[110] flex h-[min(680px,calc(100%-96px))] w-[min(420px,calc(100%-32px))] flex-col overflow-hidden rounded-xl border border-border-dark bg-surface-dark shadow-2xl"
      data-canvas-agent-panel
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border-dark px-4 py-3">
        <div className="relative flex min-w-0 items-center gap-2">
          <Bot className="h-4 w-4 shrink-0 text-accent" />
          <button
            type="button"
            onClick={() => setShowSessions((value) => !value)}
            className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-sm font-medium text-text-dark hover:bg-bg-dark"
            aria-label="切换会话"
          >
            <span className="truncate">{activeSession?.title ?? "新对话"}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          </button>
          {showSessions ? (
            <div className="absolute left-0 top-full z-20 mt-1 max-h-72 w-64 overflow-y-auto rounded-lg border border-border-dark bg-surface-dark py-1 shadow-2xl">
              {projectSessions.length === 0 ? (
                <div className="px-3 py-2 text-xs text-text-muted">还没有对话</div>
              ) : (
                projectSessions.map((session) => (
                  <div
                    key={session.id}
                    className={`group flex items-center gap-2 px-3 py-2 text-xs hover:bg-bg-dark ${
                      session.id === activeSessionId ? "text-accent" : "text-text-dark"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectSession(session.id)}
                      className="min-w-0 flex-1 truncate text-left"
                      title={session.title}
                    >
                      {session.title}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteSession(session.id)}
                      className="shrink-0 rounded p-1 text-text-muted opacity-0 hover:text-red-500 group-hover:opacity-100"
                      aria-label={`删除会话 ${session.title}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={handleNewSession}
            className="rounded p-1 text-text-muted hover:bg-bg-dark hover:text-text-dark"
            aria-label="新建对话"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-muted hover:bg-bg-dark hover:text-text-dark"
            aria-label="关闭 AI Agent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={handleThreadScroll}
        className="min-h-0 flex-1 overflow-y-auto p-3"
      >
        {/* 包裹层：`space-y-3` 挪到这里，同时给 ResizeObserver 一个可观察的内容块
            （直接观察滚动容器没用 —— 它有固定高度，内容变化不改变它自身尺寸）。 */}
        <div ref={contentRef} className="space-y-3">
        {/* 压缩备忘：默认收起，只占一行。用户得能看见「AI 还记得什么」——
            否则模型按备忘回答时，看起来就像凭空知道了一些他以为自己已经翻过去的事。 */}
        {contextSummary && messages.length > 0 ? (
          <div className="rounded-lg border border-border-dark bg-bg-dark px-2.5 py-1.5 text-[11px]">
            <button
              type="button"
              onClick={() => setShowSummary((value) => !value)}
              className="flex w-full items-center gap-1.5 text-left text-text-muted transition-colors hover:text-text-dark"
              aria-expanded={showSummary}
            >
              <Sparkles className="h-3 w-3 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">
                已压缩前 {contextSummary.messageCount} 条早期对话（约 {contextSummary.tokens} tokens）
              </span>
              <ChevronDown
                className={`h-3 w-3 shrink-0 transition-transform ${showSummary ? "rotate-180" : ""}`}
              />
            </button>
            {showSummary ? (
              <div className="mt-1.5 space-y-1.5 border-t border-border-dark pt-1.5">
                <p className="whitespace-pre-wrap break-words leading-relaxed text-text-dark">
                  {contextSummary.text}
                </p>
                <div className="flex items-start justify-between gap-2 text-[10px] text-text-muted">
                  <span className="min-w-0 flex-1">
                    这些原文不再随请求发送，只有上面这份备忘参与对话。
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (!activeSession) return;
                      setContextSummary(activeSession.id, null);
                      setShowSummary(false);
                      setNotice("已撤销压缩：下一轮会重新带上完整原文，超预算时会再压一次。");
                    }}
                    className="shrink-0 rounded border border-border-dark px-1.5 py-0.5 text-text-dark hover:border-accent hover:text-accent"
                  >
                    撤销压缩
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {/* 气泡宽度按角色分开：用户消息保留对话气泡感（右贴边、最宽 88%）；
            **AI 回答铺满整宽** —— 正文是长段落 + 工具结果卡片，右侧留 12% 空档
            只会让长文更窄、更早折行。 */}
        {messages.length === 0 ? (
          <div className="space-y-3 pt-2">
            <div className="rounded-lg bg-bg-dark px-3 py-2 text-xs leading-relaxed text-text-dark">
              你好，我是 LenTalk 创作助手。可以帮你构思故事、深化情节、撰写提示词，也能直接读写画布。
              {activeSkill ? (
                <span className="mt-1 block text-accent">
                  已加载 SKILL：{activeSkill.name} —— 接下来每一轮回答都会严格按它的规则产出。
                </span>
              ) : null}
              <span className="mt-1 block text-text-muted">
                我已经能看到当前画布的节点与连线。当前画布权限：{CANVAS_ACCESS_LABELS[canvasAccess]}
                —— 需要调整时点左下角的盾牌图标。
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setDraft(suggestion)}
                  className="rounded-full border border-border-dark px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:border-accent hover:text-accent"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`rounded-lg px-3 py-2 text-xs leading-relaxed ${
                message.role === "user"
                  ? "ml-auto max-w-[88%] bg-accent text-white"
                  : "w-full bg-bg-dark text-text-dark"
              }`}
            >
              {message.role === "assistant" ? (
                <>
                  {message.content ? (
                    <MarkdownText content={message.content} />
                  ) : message.pending ? (
                    <span className="text-text-muted">正在思考…</span>
                  ) : null}
                  {message.pending && message.content ? (
                    <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-text-muted align-middle" />
                  ) : null}
                  {/* AI 对画布做过的操作。展开在正文下方，用户一眼能看到「它到底动了什么」 */}
                  {message.toolCalls?.length ? (
                    <div className="mt-2 space-y-1 border-t border-border-dark/60 pt-1.5">
                      {message.toolCalls.map((record, index) => {
                        // 这张卡片碰过的节点。有 id 才给「定位」按钮 ——
                        // 读快照、撤销这类操作没有目标节点，给了按钮也没处可去。
                        const locateIds = extractToolResultNodeIds(record.data);
                        return (
                          <div
                            key={`${record.tool}-${index}`}
                            className="rounded border border-border-dark bg-surface-dark/60 px-2 py-1"
                          >
                            <div className="flex items-center gap-1">
                              {record.pending ? (
                                <Play className="h-3 w-3 shrink-0 text-accent" />
                              ) : record.ok ? (
                                <Check className="h-3 w-3 shrink-0 text-accent" />
                              ) : (
                                <X className="h-3 w-3 shrink-0 text-red-400" />
                              )}
                              <span className="text-[10px] font-medium text-text-dark">
                                {record.label}
                              </span>
                              <span className="truncate text-[10px] text-text-muted">{record.tool}</span>
                            </div>
                            <div
                              className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-[10px] leading-snug text-text-muted"
                              title={record.message}
                            >
                              {record.message}
                            </div>
                            {record.mediaUrl ? <AgentMediaPreview url={record.mediaUrl} /> : null}
                            {record.pending ? (
                              <div className="mt-1.5 flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => handleConfirmToolCall(message.id, index)}
                                  className="rounded bg-accent px-2 py-0.5 text-[10px] font-medium text-white hover:opacity-90"
                                >
                                  确认执行
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleSkipToolCall(message.id, index)}
                                  className="rounded border border-border-dark px-2 py-0.5 text-[10px] text-text-muted hover:text-text-dark"
                                >
                                  跳过
                                </button>
                              </div>
                            ) : null}
                            {/* 删除类卡片不给定位按钮：那张返回里的 nodeId 已经不在画布上了 */}
                            {!record.pending && record.ok && record.tool !== "canvas.delete_node" && locateIds.length > 0 ? (
                              <button
                                type="button"
                                onClick={() => handleLocateToolCall(locateIds)}
                                className="mt-1.5 flex items-center gap-1 rounded border border-border-dark px-2 py-0.5 text-[10px] text-text-muted hover:border-accent hover:text-accent"
                                title="把画布镜头移到这个节点上"
                              >
                                <LocateFixed className="h-3 w-3 shrink-0" />
                                定位到画布
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  {message.error ? (
                    <div className="mt-1 text-[11px] text-red-500">{message.error}</div>
                  ) : null}
                </>
              ) : (
                <span className="whitespace-pre-wrap break-words">{message.content}</span>
              )}
            </div>
          ))
        )}
        </div>
      </div>

      <div className="border-t border-border-dark p-3">
        {/* 压缩进度：与下方 notice 分开，因为 notice 永远带「去设置」按钮，
            而压缩既不是错误也跟设置无关。 */}
        {compressionStatus ? (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-2 text-[11px] text-text-dark">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent" />
            <span className="flex-1">{compressionStatus}</span>
            <span className="shrink-0 text-[10px] text-text-muted">会保留最近对话原文</span>
          </div>
        ) : null}
        {notice ? (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-border-dark bg-bg-dark px-2.5 py-2 text-[11px] leading-relaxed text-text-muted">
            <span className="flex-1">{notice}</span>
            <button
              type="button"
              onClick={() => openSettingsDialog({ category: "providers" })}
              className="flex shrink-0 items-center gap-1 rounded border border-border-dark px-2 py-0.5 text-text-dark hover:border-accent hover:text-accent"
            >
              <Settings2 className="h-3 w-3" />
              去设置
            </button>
          </div>
        ) : null}

        {/* SKILL 与模型选择收进输入框内部。
            单独占一行时，那条深色圆角描边和下面的输入框长得一模一样，视觉上就是「两层输入框」。 */}
        <div className="flex flex-col gap-1 rounded-lg border border-border-dark bg-bg-dark px-2 py-1.5">
          <textarea
            ref={composerTextareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
            placeholder="和 AI 聊聊你的故事、情节或提示词…（Enter 发送，Shift+Enter 换行）"
            rows={2}
            className="min-h-9 max-h-44 w-full resize-none overflow-y-auto bg-transparent py-1 text-xs leading-relaxed text-text-dark outline-none placeholder:text-text-muted"
          />
          <div className="relative flex items-center gap-1.5">
            {/* 画布权限档位。做成纯图标是为了不再把工具条撑挤 —— 它也确实是低频操作 */}
            <div className="relative shrink-0" data-agent-popover>
              <button
                type="button"
                onClick={() => toggleComposerPanel("access")}
                disabled={isBusy}
                className={`flex items-center rounded px-1 py-0.5 outline-none transition-colors hover:bg-white/5 disabled:opacity-50 ${
                  canvasAccess === "read-only"
                    ? "text-text-muted hover:text-text-dark"
                    : "text-accent"
                }`}
                aria-label="画布权限"
                aria-expanded={showAccess}
                title={`画布权限：${CANVAS_ACCESS_LABELS[canvasAccess]} —— ${CANVAS_ACCESS_HINTS[canvasAccess]}`}
              >
                <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
              </button>
              {showAccess ? (
                <div className="absolute bottom-full left-0 z-30 mb-1 w-64 overflow-hidden rounded-lg border border-border-dark bg-surface-dark py-1 shadow-2xl">
                  {(Object.keys(CANVAS_ACCESS_LABELS) as CanvasAgentAccessLevel[]).map((option) => {
                    const selected = option === canvasAccess;
                    return (
                      <button
                        key={option}
                        type="button"
                        onClick={() => {
                          setCanvasAccess(option);
                          setShowAccess(false);
                        }}
                        className={`block w-full px-3 py-2 text-left hover:bg-bg-dark ${
                          selected ? "bg-accent/10" : ""
                        }`}
                      >
                        <span
                          className={`flex items-center gap-1 text-[11px] font-medium ${
                            selected ? "text-accent" : "text-text-dark"
                          }`}
                        >
                          {CANVAS_ACCESS_LABELS[option]}
                          {selected ? <Check className="h-3 w-3 shrink-0" /> : null}
                        </span>
                        <span className="mt-0.5 block text-[10px] leading-snug text-text-muted">
                          {CANVAS_ACCESS_HINTS[option]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div className="relative shrink-0" data-agent-popover>
              <button
                type="button"
                onClick={() => toggleComposerPanel("skills")}
                disabled={isBusy}
                className={`flex max-w-[170px] items-center gap-1 rounded px-1.5 py-0.5 text-[11px] outline-none transition-colors hover:bg-white/5 disabled:opacity-50 ${
                  activeSkill ? "text-accent" : "text-text-muted hover:text-text-dark"
                }`}
                aria-label="加载 SKILL"
                aria-expanded={showSkills}
                title={activeSkill ? `已加载 SKILL：${activeSkill.name}` : "加载 SKILL"}
              >
                <Sparkles className="h-3 w-3 shrink-0" />
                <span className="truncate">{activeSkill?.name ?? "加载 SKILL"}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </button>
              {showSkills ? (
                <div className="absolute bottom-full left-0 z-30 mb-1 max-h-80 w-80 overflow-y-auto rounded-lg border border-border-dark bg-surface-dark py-1 shadow-2xl">
                  <button
                    type="button"
                    onClick={() => handleSkillPick(null)}
                    className={`block w-full px-3 py-2 text-left text-[11px] hover:bg-bg-dark ${
                      activeSkill ? "text-text-muted" : "text-accent"
                    }`}
                  >
                    不使用 SKILL
                  </button>
                  {AGENT_SKILLS.map((skill) => {
                    const selected = skill.id === activeSkillId;
                    return (
                      <button
                        key={skill.id}
                        type="button"
                        onClick={() => handleSkillPick(skill.id)}
                        className={`flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-bg-dark ${
                          selected ? "bg-accent/10 text-accent" : "text-text-dark"
                        }`}
                      >
                        <SkillThumbnail skill={skill} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1">
                            <span className="truncate text-[11px] font-medium">{skill.name}</span>
                            {selected ? <Check className="h-3 w-3 shrink-0" /> : null}
                          </span>
                          <span className="line-clamp-2 mt-0.5 block text-[10px] leading-snug text-text-muted">
                            {skill.intro}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>

            {/* 模型选择：与「加载 SKILL」同一款（裸按钮 + 弹出面板）。
                原先这里是原生 select —— 去掉边框底色是为了让它不像「第二条输入框」，
                但原生 select 的选项列表由系统绘制，与本应用其余下拉完全脱节。 */}
            <div className="relative shrink-0" data-agent-popover>
              <button
                type="button"
                onClick={() => toggleComposerPanel("models")}
                disabled={isBusy || modelOptions.length === 0}
                className={`flex max-w-[200px] items-center gap-1 rounded px-1.5 py-0.5 text-[11px] outline-none transition-colors hover:bg-white/5 disabled:opacity-50 ${
                  selection ? "text-text-dark" : "text-text-muted hover:text-text-dark"
                }`}
                aria-label="选择对话模型"
                aria-expanded={showModels}
                title={
                  selection
                    ? `对话模型：${selection.model}`
                    : modelOptions.length
                      ? "选择对话模型"
                      : "未配置 Chat 模型"
                }
              >
                <span className="truncate">
                  {selection ? selection.model : modelOptions.length ? "选择模型" : "未配置 Chat 模型"}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </button>
            </div>

            {/* 模型面板挂在**工具条**这一层，而不是触发器内部：
                触发器位于工具条中偏右，若从它 `left-0` 展开 288px 会顶穿输入框右边界，
                被面板的 overflow-hidden 裁掉（选中勾看不见）。
                挂到工具条这层用 left-0 right-0，宽度就与输入框对齐。 */}
            {showModels && modelOptions.length > 0 ? (
              <div
                data-agent-popover
                data-agent-model-panel
                className="absolute bottom-full left-0 right-0 z-30 mb-1 max-h-80 overflow-y-auto rounded-lg border border-border-dark bg-surface-dark py-1 shadow-2xl"
              >
                {groupedModelOptions.map(([providerName, options]) => (
                  <div key={providerName}>
                    {/* 按平台分组：模型多时平铺看不出归属 */}
                    <p className="px-3 pb-0.5 pt-1.5 text-[10px] text-text-muted">{providerName}</p>
                    {options.map((option) => {
                      const key = `${option.providerId}::${option.model}`;
                      const selected = key === selectionKey(selection);
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => {
                            handleModelChange(key);
                            setShowModels(false);
                          }}
                          className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] hover:bg-bg-dark ${
                            selected ? "bg-accent/10 text-accent" : "text-text-dark"
                          }`}
                        >
                          <span className="min-w-0 flex-1 truncate">{option.model}</span>
                          {selected ? <Check className="h-3 w-3 shrink-0" /> : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            ) : null}

            {/* 撑杆：把发送按钮顶到右端 */}
            <span className="min-w-0 flex-1" />

            {isBusy ? (
              <button
                type="button"
                onClick={handleStop}
                className="shrink-0 rounded-md p-1.5 text-text-dark ring-1 ring-border-dark hover:ring-accent"
                aria-label="停止生成"
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={!draft.trim()}
                className="shrink-0 rounded-md bg-accent p-1.5 text-white disabled:opacity-40"
                aria-label="发送"
              >
                {hydrated ? <Send className="h-3.5 w-3.5" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

/**
 * `memo` 挡的是**画布传来的重渲染**：Canvas 订阅了 nodes/edges，拖一下节点就是每帧
 * 重渲染一次整棵子树；面板里几十条消息的 markdown 不该跟着重算。
 * 面板自身的数据仍由 agentStore 订阅驱动，那是它必须响应的变化。
 */
export const AgentPanel = memo(AgentPanelImpl);
