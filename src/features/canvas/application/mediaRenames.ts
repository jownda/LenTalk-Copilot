/**
 * 媒体文件「改名」后的路径映射。
 *
 * 重命名是不可逆的磁盘操作（文件已经从 `a.png` 变成 `镜头1.png`），但节点数据会进
 * 撤销栈。用户撤回到改名前的快照时，节点里躺的还是旧路径 —— 那个文件已经不在了，
 * 画面上立刻变成坏图。所以这里记一张「旧 → 新」的表，在 undo/redo 应用快照时把旧
 * 路径改写回新路径：撤销对这次改名无效（本来也没法把磁盘上的文件变回去）。
 *
 * 只存进程内的映射：重启后工程里保存的一定是最新路径，不需要跨会话保留。
 */

const renamedPaths = new Map<string, string>();

/**
 * 节点里同一个媒体文件可能以不同写法出现：原始绝对路径、`file://` 形式、
 * Windows 反斜杠、URL 编码。比较前统一成一种形态，否则改名只改到一半。
 */
export function normalizeMediaPathKey(value: string): string {
  const trimmed = value.trim();
  const withoutScheme = trimmed.replace(/^file:\/\//i, '');
  let decoded = withoutScheme;
  try {
    decoded = decodeURIComponent(withoutScheme);
  } catch {
    // 非法百分号编码：按原样比较，不做二次处理。
  }
  // Windows 的 `file:///C:/a.png` 去协议后是 `/C:/a.png`，多一个前导斜杠，
  // 不修掉就与 `C:\a.png` 判成两个不同的文件。
  return decoded.replace(/\\/g, '/').replace(/^\/([a-zA-Z]:\/)/, '$1');
}

/** 记下一次改名（`from` 是旧路径，`to` 是新路径）。 */
export function rememberMediaRename(from: string, to: string): void {
  const oldKey = normalizeMediaPathKey(from);
  const newKey = normalizeMediaPathKey(to);
  if (!oldKey || !newKey || oldKey === newKey) {
    return;
  }
  renamedPaths.set(oldKey, to);
}

/** 旧路径 → 当前真实路径；没改过名就原样返回。 */
export function resolveRenamedMediaPath(value: string): string {
  return renamedPaths.get(normalizeMediaPathKey(value)) ?? value;
}

/**
 * 递归把值里指向旧路径的字符串换成新路径。
 *
 * 只处理**整串就是该路径**的值：节点里还有提示词、标题这类自由文本，做子串替换会把
 * 用户写的字也改掉。返回原引用表示这条分支没有变化，便于上层做最小 patch。
 */
export function rewriteMediaPathInValue(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') {
    return normalizeMediaPathKey(value) === from ? to : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const rewritten = rewriteMediaPathInValue(item, from, to);
      if (rewritten !== item) changed = true;
      return rewritten;
    });
    return changed ? next : value;
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      const rewritten = rewriteMediaPathInValue(item, from, to);
      if (rewritten !== item) changed = true;
      next[key] = rewritten;
    }
    return changed ? next : value;
  }
  return value;
}

/** 递归把值里所有已改名路径换成当前路径。 */
function remapRenamedPathsInValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return resolveRenamedMediaPath(value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const rewritten = remapRenamedPathsInValue(item);
      if (rewritten !== item) changed = true;
      return rewritten;
    });
    return changed ? next : value;
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      const rewritten = remapRenamedPathsInValue(item);
      if (rewritten !== item) changed = true;
      next[key] = rewritten;
    }
    return changed ? next : value;
  }
  return value;
}

/**
 * 撤销/重做应用快照前调用：把快照里已被改名替换掉的旧路径修回当前路径。
 *
 * 没有任何改名记录时直接返回原数组（不产生新引用），不影响 undo 的引用比较。
 */
export function remapRenamedMediaPathsInNodes<T extends { data: unknown }>(nodes: T[]): T[] {
  if (renamedPaths.size === 0) {
    return nodes;
  }
  return nodes.map((node) => {
    const rewritten = remapRenamedPathsInValue(node.data);
    if (rewritten === node.data) {
      return node;
    }
    return { ...node, data: rewritten } as T;
  });
}
