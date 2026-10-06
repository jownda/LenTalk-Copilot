import { useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
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
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-text-muted/15 [&_pre]:p-2",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[12px]",
  "[&_td]:border [&_td]:border-text-muted/20 [&_td]:px-2 [&_td]:py-1",
  "[&_th]:border [&_th]:border-text-muted/20 [&_th]:px-2 [&_th]:py-1",
  "[&_ul]:list-disc [&_ul]:pl-5",
].join(" ");

export function MarkdownText({ content }: { content: string }) {
  const handleLinkClick = useCallback((href?: string) => {
    if (!href) return;
    // 外链交给系统浏览器；非 Tauri 环境（浏览器调试）退回 window.open
    void openUrl(href).catch(() => {
      if (typeof window !== "undefined") window.open(href, "_blank", "noreferrer");
    });
  }, []);

  return (
    <div className={MARKDOWN_CLASS}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ href, children, ...props }) => (
            <a
              {...props}
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault();
                handleLinkClick(href);
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
