import type { RunningHubWorkflowControl } from "@/commands/runningHubWorkflow";

/** 工作流里「素材型」输入的三类。 */
export type WorkflowMediaKind = "image" | "video" | "audio";

const MEDIA_CONTROLS: RunningHubWorkflowControl[] = ["image", "video", "audio"];

/** 这个控件是不是素材槽（要上传 / 接上游素材）。 */
export function isMediaControl(control: RunningHubWorkflowControl): control is WorkflowMediaKind {
  return MEDIA_CONTROLS.includes(control);
}

/** 素材槽的 accept：与控件类型同源，避免用户传个 .txt 进去再在平台侧失败。 */
export const ACCEPT_BY_CONTROL: Record<WorkflowMediaKind, string> = {
  image: "image/*",
  video: "video/*",
  audio: "audio/*",
};
