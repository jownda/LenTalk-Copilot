import { beforeEach, describe, expect, it } from 'vitest';

import { usePromptLibraryStore } from './promptLibraryStore';

const LIB_ID = 'lib-probe';

/** 造一个干净的可编辑词库,避免依赖内置种子数据 */
function seedLibrary(items: Array<Record<string, unknown>> = []) {
  usePromptLibraryStore.setState({
    libraries: [
      {
        id: LIB_ID,
        name: '探针库',
        items: items as never,
        createdAt: 1,
      },
    ],
    categories: [],
  });
}

const payload = {
  name: '探针条目',
  scene: '',
  positive: 'a probe prompt',
  negative: '',
  category: 'custom',
};

describe('promptLibraryStore 写接口的返回值', () => {
  beforeEach(() => seedLibrary());

  it('addTemplate 返回创建出的条目(id / 时间戳齐全)并追加到目标词库', () => {
    const created = usePromptLibraryStore.getState().addTemplate(LIB_ID, payload);

    expect(created).not.toBeNull();
    expect(created?.id).toMatch(/^prompt-/);
    expect(created?.createdAt).toBe(created?.updatedAt);
    expect(created?.positive).toBe('a probe prompt');

    const library = usePromptLibraryStore.getState().libraries.find((lib) => lib.id === LIB_ID);
    expect(library?.items.map((item) => item.name)).toEqual(['探针条目']);
  });

  it('addTemplate 在词库不存在时返回 null(不允许静默无操作)', () => {
    const result = usePromptLibraryStore.getState().addTemplate('lib-missing', payload);

    expect(result).toBeNull();
    expect(usePromptLibraryStore.getState().libraries[0].items).toHaveLength(0);
  });

  it('updateTemplate 命中条目返回 true,且只更新目标条目', () => {
    const state = usePromptLibraryStore.getState();
    const first = state.addTemplate(LIB_ID, payload);
    state.addTemplate(LIB_ID, { ...payload, name: '第二条' });
    expect(first).not.toBeNull();

    const ok = usePromptLibraryStore
      .getState()
      .updateTemplate(LIB_ID, first?.id ?? '', { name: '改过名' });

    expect(ok).toBe(true);
    const names = usePromptLibraryStore.getState().libraries[0].items.map((item) => item.name);
    expect(names).toEqual(['改过名', '第二条']);
  });

  it('updateTemplate 在词库或条目不存在时返回 false', () => {
    const created = usePromptLibraryStore.getState().addTemplate(LIB_ID, payload);

    expect(usePromptLibraryStore.getState().updateTemplate('lib-missing', created?.id ?? '', { name: 'x' })).toBe(false);
    expect(usePromptLibraryStore.getState().updateTemplate(LIB_ID, 'prompt-missing', { name: 'x' })).toBe(false);
    expect(usePromptLibraryStore.getState().libraries[0].items[0].name).toBe('探针条目');
  });
});
