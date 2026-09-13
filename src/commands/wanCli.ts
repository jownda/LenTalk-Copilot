import { invoke, isTauri } from "@tauri-apps/api/core";
import i18n from "@/i18n";

function requireDesktop() {
  if (!isTauri()) throw new Error(i18n.t("wanCli.desktopOnly"));
}

export interface WanCliStatus {
  version: string;
  authenticated: boolean;
  message?: string;
}

export async function checkWanCli(executable: string): Promise<WanCliStatus> {
  requireDesktop();
  return invoke("wan_cli_status", { executable });
}

export async function loginWanCli(executable: string, site: string, accessKey: string): Promise<void> {
  requireDesktop();
  await invoke("wan_cli_login", { executable, site, accessKey });
}

export async function generateWanCliVideo(request: {
  client_job_id?: string;
  executable: string;
  prompt: string;
  model_version: string;
  duration: number;
  aspect_ratio: string;
  video_resolution?: string;
  image_mode?: "reference" | "first-last";
  reference_images?: string[];
  reference_audio?: string[];
}): Promise<string> {
  requireDesktop();
  return invoke("generate_wan_cli_video", { request });
}
