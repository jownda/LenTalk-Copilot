import { memo, useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * 聊天消息里的 markdown 渲染。
 * 样式沿用 TextAnnotationNode 的写法（tailwind 任意值选择器），
 * 但字号按聊天场景收小一档——同一套 CSS 变量，因此明暗主题自动跟随。
 */
const MARKDOWN_CLASS = [
  "markdown-body break-words text-[13px] leading-6",
  "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-text-muted/30 [&_blockquote]:pl-3 [&_blockquote]:text-text-muted",
  "[&_code]:rounded [&_code]:bg-text-muted/15 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px]",
  "[&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:text-sm [&_h1]:font-semibold",
  "[&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-[13px] [&_h2]:font-semibold",
  "[&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-[13px] [&_h3]:font-semibold",
  "[&_hr]:my-3 [&_hr]:border-text-muted/20",
  "[&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  // 代码块里的长行必须自动折行：分镜提示词一行能到 100+ 字，
  // 面板只有 420px 宽，横向滚动等于看不全。overflow-x-auto 保留作兜底。
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-text-muted/15 [&_pre]:p-2",
  "[&_pre]:whitespace-pre-wrap [&_pre]:break-words",
  "[&_pre_code]:whitespace-pre-wrap [&_pre_code]:break-words [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[12px]",
  "[&_td]:border [&_td]:border-text-muted/20 [&_td]:px-2 [&_td]:py-1",
  "[&_th]:border [&_th]:border-text-muted/20 [&_th]:px-2 [&_th]:py-1",
  "[&_ul]:list-disc [&_ul]:pl-5",
].join(" ");

/**
 * 插件数组与自定义渲染器必须是**模块常量**。
 *
 * 之前它们直接写在 JSX 里，每次渲染都是新数组/新对象；画布任何一次重渲染
 * （拖一个节点就是每帧一次）都会让整屏消息的 markdown 从头解析一遍 ——
 * 长会话里单帧几十毫秒，表现就是拖画布时面板卡、CPU 高。
 */
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

function MarkdownLink({
  href,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"a">) {
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (!href) return;
      // 外链交给系统浏览器；非 Tauri 环境（浏览器调试）退回 window.open
      void openUrl(href).catch(() => {
        if (typeof window !== "undefined") window.open(href, "_blank", "noreferrer");
      });
    },
    [href],
  );

  return (
    <a {...props} href={href} target="_blank" rel="noreferrer" onClick={handleClick}>
      {children}
    </a>
  );
}

const MARKDOWN_COMPONENTS: Components = { a: MarkdownLink };

/**
 * `memo` 是这里的重点：消息正文不变时，父组件（AgentPanel，随画布每帧重渲染）
 * 不应该带着整段 markdown 重新解析。
 */
export const MarkdownText = memo(function MarkdownText({ content }: { content: string }) {
  return (
    <div className={MARKDOWN_CLASS}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
