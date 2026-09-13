import { useState } from "react";
import { Bot, Send, X } from "lucide-react";

export interface AgentPanelProps {
  open: boolean;
  onClose: () => void;
}

export function AgentPanel({ open, onClose }: AgentPanelProps) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([
    { role: "assistant", text: "你好，我可以读取和操作当前画布。你可以让我创建节点、连接素材或整理工作流。" },
  ]);

  if (!open) return null;

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setMessages((current) => [
      ...current,
      { role: "user", text },
      { role: "assistant", text: "已收到指令。Agent Runtime 接入后，我会在这里执行画布操作。" },
    ]);
    setDraft("");
  };

  return (
    <aside
      className="absolute right-4 top-16 z-[110] flex h-[min(680px,calc(100%-96px))] w-[min(390px,calc(100%-32px))] flex-col overflow-hidden rounded-xl border border-border-dark bg-surface-dark shadow-2xl"
      data-canvas-agent-panel
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="flex items-center justify-between border-b border-border-dark px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-text-dark">
          <Bot className="h-4 w-4 text-accent" /> AI Agent
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-text-muted hover:bg-bg-dark hover:text-text-dark" aria-label="关闭 AI Agent">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`max-w-[88%] rounded-lg px-3 py-2 text-xs leading-relaxed ${message.role === "user" ? "ml-auto bg-accent text-white" : "bg-bg-dark text-text-dark"}`}>
            {message.text}
          </div>
        ))}
      </div>
      <div className="border-t border-border-dark p-3">
        <div className="flex items-end gap-2 rounded-lg border border-border-dark bg-bg-dark p-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            placeholder="告诉 Agent 你想怎么操作画布…"
            rows={2}
            className="min-h-10 flex-1 resize-none bg-transparent text-xs text-text-dark outline-none placeholder:text-text-muted"
          />
          <button type="button" onClick={send} disabled={!draft.trim()} className="rounded-md bg-accent p-2 text-white disabled:opacity-40" aria-label="发送">
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
