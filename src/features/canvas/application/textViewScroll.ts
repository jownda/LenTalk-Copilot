/**
 * 编辑态 ⇄ 预览态的滚动位置搬运。
 *
 * 画布上有若干节点把「编辑态」做成 `<textarea>`、「预览态」做成另一个 `overflow-auto`
 * 容器(文本节点是 markdown 渲染, 提示词优化节点是等宽正文)。两者是**互相独立**的滚动
 * 容器, 新挂载的那个默认 `scrollTop = 0` —— 于是「往下翻着改完 → 退出编辑」会跳回第一行。
 * 切换时把偏移量搬到新挂载的容器上, 即可让视图停在原来的位置。
 *
 * 纯函数, 与具体节点无关: 偏移量写回前按**目标容器自己的可滚范围**钳一次 —— 两个容器的
 * 内容高度未必一致(markdown 的段落间距/标题字号、字号/行高差异都会变), 浏览器自己也会
 * 钳, 但显式钳一次行为才可断言。
 */
export function clampTextViewScrollTop(scrollTop: number, maxScrollTop: number): number {
  if (!Number.isFinite(scrollTop) || scrollTop <= 0) return 0;
  if (!Number.isFinite(maxScrollTop) || maxScrollTop <= 0) return 0;
  return Math.min(scrollTop, maxScrollTop);
}
