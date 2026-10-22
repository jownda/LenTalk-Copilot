import { canvasAgentTools, type CanvasAgentPermission, type CanvasAgentToolName } from "./canvasTools";
import { executeCanvasAgentCommand, type CanvasAgentCommand, type CanvasAgentToolResult } from "./commandExecutor";
import { getCanvasAgentSnapshot, type CanvasAgentSnapshot } from "./canvasContext";

export interface CanvasAgentPlugin {
  id: "lentalk.canvas";
  version: "1.0.0";
  tools: typeof canvasAgentTools;
  getSnapshot(): CanvasAgentSnapshot;
  execute(command: CanvasAgentCommand, options?: { confirmed?: boolean }): CanvasAgentToolResult;
}

export const lenTalkCanvasPlugin: CanvasAgentPlugin = {
  id: "lentalk.canvas",
  version: "1.0.0",
  tools: canvasAgentTools,
  getSnapshot: getCanvasAgentSnapshot,
  execute(command, options = {}) {
    const definition = Object.values(canvasAgentTools).find((tool) => tool.name === command.tool);
    if (!definition) return { ok: false, message: `未知画布工具：${command.tool}` };
    const permission = definition.permission as string;
    if ((("requiresConfirmation" in definition && definition.requiresConfirmation) || permission === "destructive" || permission === "paid-operation") && !options.confirmed) {
      return { ok: false, message: `操作 ${command.tool} 需要用户确认后执行。` };
    }
    return executeCanvasAgentCommand(command);
  },
};

export type { CanvasAgentPermission, CanvasAgentToolName };
