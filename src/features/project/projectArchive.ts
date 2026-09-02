import { invoke, isTauri } from "@tauri-apps/api/core";
import JSZip from "jszip";

import type { ProjectRecord } from "@/commands/projectState";

const PROJECT_ARCHIVE_FORMAT = "lentalk-canvas-project";
const PROJECT_ARCHIVE_VERSION = 1;

interface ProjectArchive {
  format: typeof PROJECT_ARCHIVE_FORMAT;
  version: typeof PROJECT_ARCHIVE_VERSION;
  exportedAt: string;
  project: ProjectRecord;
}

export interface ProjectArchiveSaveResult {
  saved: boolean;
  path?: string;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isProjectRecord(value: unknown): value is ProjectRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    isFiniteTimestamp(record.createdAt) &&
    isFiniteTimestamp(record.updatedAt) &&
    isFiniteTimestamp(record.nodeCount) &&
    typeof record.nodesJson === "string" &&
    typeof record.edgesJson === "string" &&
    typeof record.viewportJson === "string" &&
    typeof record.historyJson === "string" &&
    (record.thumbnails === undefined ||
      (Array.isArray(record.thumbnails) && record.thumbnails.every((item) => typeof item === "string")))
  );
}

/** Reads the portable project format used by project export and cloud upload. */
export function parseProjectArchive(serialized: string): ProjectRecord {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("项目文件不是有效的 JSON。");
  }

  if (!value || typeof value !== "object") {
    throw new Error("项目文件格式无效。");
  }

  const archive = value as Partial<ProjectArchive>;
  if (archive.format !== PROJECT_ARCHIVE_FORMAT || archive.version !== PROJECT_ARCHIVE_VERSION) {
    throw new Error("不是受支持的 LenTalk 项目文件。");
  }
  if (!isProjectRecord(archive.project)) {
    throw new Error("项目文件缺少完整的项目数据。");
  }

  return {
    ...archive.project,
    name: archive.project.name.trim() || "未命名项目",
    nodeCount: Math.max(0, Math.floor(archive.project.nodeCount)),
    ...(archive.project.thumbnails ? { thumbnails: [...archive.project.thumbnails] } : {}),
  };
}

function sanitizeFileName(name: string): string {
  const normalized = name.trim().replace(/[\\/:*?"<>|]+/g, "-");
  return normalized || "LenTalk-project";
}

export function createProjectArchiveFileName(projectName: string): string {
  return `${sanitizeFileName(projectName)}.lentalk-project.zip`;
}

export function createProjectArchive(project: ProjectRecord): Blob {
  const archive: ProjectArchive = {
    format: PROJECT_ARCHIVE_FORMAT,
    version: PROJECT_ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    project,
  };
  return new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
}

function downloadProjectArchive(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function isProjectBundleFile(fileName: string): boolean {
  return fileName.trim().toLowerCase().endsWith(".zip");
}

async function createBrowserProjectBundle(project: ProjectRecord): Promise<Blob> {
  const zip = new JSZip();
  zip.file("project.json", await createProjectArchive(project).text());
  return await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

/** Browser fallback: project resources are already embedded in the persisted image pool. */
export async function parseBrowserProjectFile(file: File): Promise<ProjectRecord> {
  if (!isProjectBundleFile(file.name)) {
    return parseProjectArchive(await file.text());
  }

  const zip = await JSZip.loadAsync(file);
  const projectFile = zip.file("project.json");
  if (!projectFile) {
    throw new Error("项目压缩包缺少 project.json。");
  }
  return parseProjectArchive(await projectFile.async("string"));
}

export async function importProjectBundle(sourcePath: string): Promise<ProjectRecord> {
  return await invoke<ProjectRecord>("import_project_bundle", { sourcePath });
}

/**
 * Desktop uses the native save dialog. Selecting an iCloud Drive, OneDrive,
 * Dropbox, or other synced folder hands uploading to the user's cloud client.
 * Browser builds fall back to a regular download.
 */
export async function saveProjectArchive(project: ProjectRecord): Promise<ProjectArchiveSaveResult> {
  const fileName = createProjectArchiveFileName(project.name);

  if (!isTauri()) {
    downloadProjectArchive(await createBrowserProjectBundle(project), fileName);
    return { saved: true };
  }

  const { save } = await import("@tauri-apps/plugin-dialog");
  const filePath = await save({
    defaultPath: fileName,
    filters: [{ name: "LenTalk 项目压缩包", extensions: ["zip"] }],
  });
  if (!filePath) {
    return { saved: false };
  }

  await invoke("export_project_bundle", { record: project, destinationPath: filePath });
  return { saved: true, path: filePath };
}
