import { readAllBrowserTemplates, writeAllBrowserTemplates } from './browserTemplateStorage';
import { deleteTemplateRecord, getTemplateRecord, listTemplateRecords, saveTemplateRecord } from '@/commands/templateState';
import { isTauri } from '@tauri-apps/api/core';
import { ensureTemplateGraph, type Template } from '../types';

export interface TemplateRepository {
  list: () => Promise<Template[]>;
  get: (id: string) => Promise<Template | null>;
  save: (template: Template) => Promise<void>;
  delete: (id: string) => Promise<void>;
}

export const browserTemplateRepository: TemplateRepository = {
  async list() {
    if (isTauri()) {
      const records = await listTemplateRecords();
      return records.flatMap((record) => parseTemplate(record.payloadJson));
    }
    return (await readAllBrowserTemplates()).map(ensureTemplateGraph);
  },
  async get(id) {
    if (isTauri()) {
      const record = await getTemplateRecord(id);
      return record ? parseTemplate(record.payloadJson)[0] ?? null : null;
    }
    const template = (await readAllBrowserTemplates()).find((item) => item.id === id) ?? null;
    return template ? ensureTemplateGraph(template) : null;
  },
  async save(template) {
    if (isTauri()) {
      const createdAt = Date.parse(template.createdAt) || Date.now();
      const updatedAt = Date.parse(template.updatedAt) || Date.now();
      await saveTemplateRecord({
        id: template.id,
        name: template.name,
        payloadJson: JSON.stringify(template),
        createdAt,
        updatedAt,
      });
      return;
    }
    const templates = await readAllBrowserTemplates();
    await writeAllBrowserTemplates([...templates.filter((item) => item.id !== template.id), template]);
  },
  async delete(id) {
    if (isTauri()) {
      await deleteTemplateRecord(id);
      return;
    }
    await writeAllBrowserTemplates((await readAllBrowserTemplates()).filter((template) => template.id !== id));
  },
};

function parseTemplate(payloadJson: string): Template[] {
  try {
    const payload: unknown = JSON.parse(payloadJson);
    return payload && typeof payload === 'object' ? [ensureTemplateGraph(payload as Template)] : [];
  } catch {
    return [];
  }
}
