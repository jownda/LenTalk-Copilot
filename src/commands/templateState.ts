import { invoke, isTauri } from '@tauri-apps/api/core';

export interface TemplateStorageRecord {
  id: string;
  name: string;
  payloadJson: string;
  createdAt: number;
  updatedAt: number;
}

export async function listTemplateRecords(): Promise<TemplateStorageRecord[]> {
  if (!isTauri()) return [];
  return invoke<TemplateStorageRecord[]>('list_template_records');
}

export async function getTemplateRecord(id: string): Promise<TemplateStorageRecord | null> {
  if (!isTauri()) return null;
  return invoke<TemplateStorageRecord | null>('get_template_record', { templateId: id });
}

export async function saveTemplateRecord(record: TemplateStorageRecord): Promise<void> {
  if (!isTauri()) return;
  await invoke('save_template_record', { record });
}

export async function deleteTemplateRecord(id: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('delete_template_record', { templateId: id });
}
