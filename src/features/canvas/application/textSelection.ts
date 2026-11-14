/**
 * 画布上的「文字选区」判定。
 *
 * 背景：画布把 Ctrl+C / Ctrl+X / Delete 绑到了节点操作上，而节点内部本身也有可读文本
 * （文本节点的 markdown、生成结果、提示词预览…）。两边共用同一套快捷键，所以必须先
 * 分清用户此刻想动的是「选中的那几行字」还是「整个节点」—— 否则选中一段提示词按
 * Ctrl+C 拿到的是节点，按 Delete 更糟，节点直接没了。
 */

/** 只需要这几个成员，便于用普通对象做单测。 */
export interface TextSelectionLike {
  isCollapsed: boolean;
  toString(): string;
  anchorNode: Node | null;
}

/** 输入类元素：它们有自己的选区语义，快捷键一律交给浏览器，不当成「画布选区」。 */
const INPUT_SELECTOR = "input, textarea, [contenteditable='true']";

/** 画布根（React Flow 容器）。只认落在画布里的选区，别把对话框里的也算进来。 */
const CANVAS_ROOT_SELECTOR = ".react-flow";

function elementOf(node: Node | null): Element | null {
  if (!node) {
    return null;
  }
  return node.nodeType === 1 ? (node as Element) : (node.parentElement ?? null);
}

function currentSelection(): TextSelectionLike | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.getSelection();
}

/**
 * 容器内是否有非折叠选区；有则返回选中的文字（已 trim）。
 *
 * 工具提示 / 只读预览这类普通文本，右键菜单靠它决定是否给出「复制选中文字」。
 */
export function readSelectedTextInside(
  container: Element | null,
  selection: TextSelectionLike | null = currentSelection(),
): string | null {
  if (!container || !selection || selection.isCollapsed) {
    return null;
  }
  const text = selection.toString().trim();
  if (!text) {
    return null;
  }
  const anchor = selection.anchorNode;
  if (!anchor || !container.contains(anchor)) {
    return null;
  }
  // 输入框里的选区单独处理（走原生菜单），这里不重复接管。
  if (elementOf(anchor)?.closest(INPUT_SELECTOR)) {
    return null;
  }
  return text;
}

/**
 * 画布里是否正选中了一段文字。
 *
 * 为 true 时，复制/剪切/删除都要让给浏览器 —— 用户要动的是那几行字。
 */
export function hasCanvasTextSelection(
  selection: TextSelectionLike | null = currentSelection(),
): boolean {
  if (!selection || selection.isCollapsed) {
    return false;
  }
  if (!selection.toString().trim()) {
    return false;
  }
  const element = elementOf(selection.anchorNode);
  if (!element) {
    return false;
  }
  if (element.closest(INPUT_SELECTOR)) {
    return false;
  }
  return Boolean(element.closest(CANVAS_ROOT_SELECTOR));
}
