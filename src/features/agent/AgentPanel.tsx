import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  Loader2,
  Plus,
  Send,
  Settings2,
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
} from "@/features/cinematicStudio/app/providers/aiSettings";
import { openSettingsDialog } from "@/features/settings/settingsEvents";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";

import { selectSessionsForProject, useAgentStore } from "./agentStore";
import { streamChat } from "./llmClient";
import { MarkdownText } from "./MarkdownText";
import type { AgentChatTurn, AgentMessage, AgentModelSelection } from "./types";

export interface AgentPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 当前只做纯文本创作助手，还读不到画布。
 * 明确写进系统提示，避免模型凭空编造"画布上有哪几个节点"——
 * 编造出来的节点清单比直接说"我做不到"更有害。
 */
const SYSTEM_PROMPT = [
  "你是 LenTalk Copilot 内置的创作助手，帮助用户构思故事、深化情节、撰写提示词。",
  "回答使用简体中文，简洁、具体、可执行；涉及创作建议时直接给出可用的文本，而不是泛泛而谈。",
  "当前版本你还不能读取或修改画布上的内容。若用户要求操作画布，请如实说明暂时做不到，" +
    "并给出你建议的手动步骤，不要假设画布上存在任何节点。",
].join("");

const SUGGESTIONS = [
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

export function AgentPanel({ open, onClose }: AgentPanelProps) {
  const projectId = useProjectStore((state) => state.currentProjectId);
  const customApis = useSettingsStore((state) => state.customApis);

  const hydrated = useAgentStore((state) => state.hydrated);
  const sessions = useAgentStore((state) => state.sessions);
  const activeSessionId = useAgentStore((state) => state.activeSessionId);
  const streaming = useAgentStore((state) => state.streaming);
  const storeSelection = useAgentStore((state) => state.selection);

  const hydrate = useAgentStore((state) => state.hydrate);
  const createSession = useAgentStore((state) => state.createSession);
  const deleteSession = useAgentStore((state) => state.deleteSession);
  const setActiveSession = useAgentStore((state) => state.setActiveSession);
  const setSelection = useAgentStore((state) => state.setSelection);
  const appendMessage = useAgentStore((state) => state.appendMessage);
  const patchMessage = useAgentStore((state) => state.patchMessage);
  const beginStreaming = useAgentStore((state) => state.beginStreaming);
  const endStreaming = useAgentStore((state) => state.endStreaming);

  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
  const isBusy = Boolean(streaming);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // 打开面板时若尚无选中会话，自动落到当前项目最近的一次对话
  useEffect(() => {
    if (!open || !hydrated || activeSession) return;
    const first = projectSessions[0];
    if (first) setActiveSession(first.id);
  }, [open, hydrated, activeSession, projectSessions, setActiveSession]);

  // 新消息 / 流式增量都要把视口钉在底部
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [activeSession?.messages, streaming]);

  const resolveSettings = useCallback((target: AgentModelSelection | null): AISettings => {
    return target ? resolveLenTalkChatModel(target.providerId, target.model) : loadAISettings();
  }, []);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || useAgentStore.getState().streaming) return;

    const sessionId = activeSession?.id ?? createSession(projectId ?? null);
    // createSession 之后 store 已同步更新，这里必须重新取一次，不能用闭包里的旧数组
    const session = useAgentStore.getState().sessions.find((item) => item.id === sessionId) ?? null;
    const history = session?.messages ?? [];
    const target = session?.selection ?? useAgentStore.getState().selection ?? defaultSelection;
    const settings = resolveSettings(target);

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

    const turns: AgentChatTurn[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history
        .filter((message) => message.role !== "system" && message.content.trim().length > 0)
        .map((message) => ({ role: message.role, content: message.content })),
      { role: "user", content: text },
    ];

    const controller = new AbortController();
    abortRef.current = controller;
    beginStreaming(sessionId, assistantId);

    let accumulated = "";
    try {
      await streamChat({
        settings,
        messages: turns,
        signal: controller.signal,
        onDelta: (delta) => {
          accumulated += delta;
          // 流式期间不写盘：一轮回答几百个 token，逐次落盘会明显卡顿
          patchMessage(sessionId, assistantId, { content: accumulated }, { persist: false });
        },
      });
      patchMessage(sessionId, assistantId, {
        content: accumulated,
        pending: false,
        error: accumulated.trim() ? undefined : "模型没有返回内容。",
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      patchMessage(sessionId, assistantId, {
        content: accumulated,
        pending: false,
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
  ]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
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

  if (!open) return null;

  const messages = activeSession?.messages ?? [];

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

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <div className="space-y-3 pt-2">
            <div className="rounded-lg bg-bg-dark px-3 py-2 text-xs leading-relaxed text-text-dark">
              你好，我是 LenTalk 创作助手。可以帮你构思故事、深化情节、撰写提示词。
              <span className="mt-1 block text-text-muted">
                当前版本我还看不到画布内容——画布操作能力会在后续版本接入。
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
              className={`max-w-[88%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                message.role === "user"
                  ? "ml-auto bg-accent text-white"
                  : "bg-bg-dark text-text-dark"
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

      <div className="border-t border-border-dark p-3">
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

        <div className="mb-2 flex items-center gap-2">
          <select
            value={selectionKey(selection)}
            onChange={(event) => handleModelChange(event.target.value)}
            disabled={isBusy}
            className="min-w-0 flex-1 rounded-md border border-border-dark bg-bg-dark px-2 py-1 text-[11px] text-text-dark outline-none disabled:opacity-50"
            aria-label="选择对话模型"
          >
            {modelOptions.length === 0 ? (
              <option value="">未配置 Chat 模型</option>
            ) : (
              <>
                {selection ? null : <option value="">请选择模型</option>}
                {modelOptions.map((option) => {
                  const key = `${option.providerId}::${option.model}`;
                  return (
                    <option key={key} value={key}>
                      {option.providerName} · {option.model}
                    </option>
                  );
                })}
              </>
            )}
          </select>
        </div>

        <div className="flex items-end gap-2 rounded-lg border border-border-dark bg-bg-dark p-2">
          <textarea
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
            className="min-h-10 flex-1 resize-none bg-transparent text-xs text-text-dark outline-none placeholder:text-text-muted"
          />
          {isBusy ? (
            <button
              type="button"
              onClick={handleStop}
              className="rounded-md bg-bg-dark p-2 text-text-dark ring-1 ring-border-dark hover:ring-accent"
              aria-label="停止生成"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!draft.trim()}
              className="rounded-md bg-accent p-2 text-white disabled:opacity-40"
              aria-label="发送"
            >
              {hydrated ? <Send className="h-3.5 w-3.5" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
