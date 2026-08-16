import { isTauri } from '@tauri-apps/api/core';

export function isWindowsDesktopRuntime(): boolean {
  return isTauri() && typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
}
