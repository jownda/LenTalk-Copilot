import { useCallback, useEffect, useState } from 'react';

import { browserTemplateRepository } from '@/features/templates/storage/templateRepository';
import type { Template } from '@/features/templates/types';

/**
 * 读取模板库列表（含拖拽所需的 graph）。
 *
 * 只在挂载与 `visible` 从 false 变 true 时拉取一次，避免每次渲染打 IPC/IndexedDB。
 */
export function useTemplateLibrary(visible: boolean): { templates: Template[]; loading: boolean; refresh: () => Promise<void> } {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(await browserTemplateRepository.list());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    void browserTemplateRepository
      .list()
      .then((items) => {
        if (!cancelled) setTemplates(items);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  return { templates, loading, refresh };
}
