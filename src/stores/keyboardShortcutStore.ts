import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** 快捷键功能 id */
export type ShortcutId = 'undo' | 'redo' | 'group' | 'copy' | 'paste' | 'delete';

/** 快捷键绑定:主键(小写)+ 修饰键 */
export interface ShortcutBinding {
  /** 主键(小写),如 'z' / 'delete' / 'enter' */
  key: string;
  /** 是否要求 ⌘/Ctrl */
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export const SHORTCUT_IDS: ShortcutId[] = ['undo', 'redo', 'group', 'copy', 'paste', 'delete'];

export const DEFAULT_SHORTCUTS: Record<ShortcutId, ShortcutBinding> = {
  undo: { key: 'z', ctrl: true, shift: false, alt: false },
  redo: { key: 'y', ctrl: true, shift: false, alt: false },
  group: { key: 'g', ctrl: true, shift: false, alt: false },
  copy: { key: 'c', ctrl: true, shift: false, alt: false },
  paste: { key: 'v', ctrl: true, shift: false, alt: false },
  delete: { key: 'delete', ctrl: false, shift: false, alt: false },
};

/** 单字符/功能键的显示标签 */
const KEY_LABELS: Record<string, string> = {
  delete: 'Delete',
  backspace: '⌫',
  enter: 'Enter',
  escape: 'Esc',
  space: 'Space',
  tab: 'Tab',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  ' ': 'Space',
};

function keyDisplayLabel(key: string): string {
  return KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** 生成可读快捷键标签,如 ⌘Z / Ctrl+Shift+G */
export function shortcutLabel(binding: ShortcutBinding, isMac: boolean): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push(isMac ? '⌘' : 'Ctrl');
  if (binding.shift) parts.push(isMac ? '⇧' : 'Shift');
  if (binding.alt) parts.push(isMac ? '⌥' : 'Alt');
  const keyLabel = keyDisplayLabel(binding.key);
  if (keyLabel) {
    parts.push(keyLabel);
  }
  return parts.join(isMac ? '' : '+');
}

/** 判断 KeyboardEvent 是否匹配某个绑定(Delete 兼容 Backspace) */
export function matchesBinding(
  event: KeyboardEvent,
  binding: ShortcutBinding | undefined
): boolean {
  if (!binding) {
    return false;
  }
  const commandPressed = event.ctrlKey || event.metaKey;
  if (commandPressed !== binding.ctrl) {
    return false;
  }
  if (event.shiftKey !== binding.shift) {
    return false;
  }
  if (event.altKey !== binding.alt) {
    return false;
  }
  const key = event.key.toLowerCase();
  if (binding.key === 'delete') {
    return key === 'delete' || key === 'backspace';
  }
  return key === binding.key;
}

/** 从 KeyboardEvent 提取绑定(仅接受单字符或已知功能键) */
export function bindingFromEvent(event: KeyboardEvent): ShortcutBinding | null {
  const key = event.key.toLowerCase();
  const knownKeys = new Set([
    'delete', 'backspace', 'enter', 'escape', 'space', 'tab',
    'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  ]);
  if (key.length !== 1 && !knownKeys.has(key)) {
    return null;
  }
  if (key.length === 1 && !/^[a-z0-9]$/.test(key)) {
    return null;
  }
  return {
    key,
    ctrl: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
  };
}

interface KeyboardShortcutState {
  bindings: Record<ShortcutId, ShortcutBinding>;
  setBinding: (id: ShortcutId, binding: ShortcutBinding) => void;
  resetOne: (id: ShortcutId) => void;
  resetAll: () => void;
}

export const useKeyboardShortcutStore = create<KeyboardShortcutState>()(
  persist(
    (set) => ({
      bindings: DEFAULT_SHORTCUTS,
      setBinding: (id, binding) =>
        set((state) => ({ bindings: { ...state.bindings, [id]: binding } })),
      resetOne: (id) =>
        set((state) => ({ bindings: { ...state.bindings, [id]: DEFAULT_SHORTCUTS[id] } })),
      resetAll: () => set({ bindings: DEFAULT_SHORTCUTS }),
    }),
    {
      name: 'storyboard-keyboard-shortcuts-v1',
      partialize: (state) => ({ bindings: state.bindings }),
    }
  )
);
