"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatMessageMarkdownProps {
  content: string;
  className?: string;
}

export function ChatMessageMarkdown({ content, className }: ChatMessageMarkdownProps) {
  const value = String(content || "").trim();
  if (!value) return null;

  return (
    <div
      className={[
        "leading-relaxed break-words",
        "[&_p]:mb-3 [&_p:last-child]:mb-0",
        "[&_ul]:mb-3 [&_ul:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-5",
        "[&_ol]:mb-3 [&_ol:last-child]:mb-0 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:mb-1 [&_li:last-child]:mb-0",
        "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3",
        "[&_a]:underline [&_a]:underline-offset-2",
        "[&_code]:rounded [&_code]:bg-black/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.92em]",
        className || "",
      ].join(" ")}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
    </div>
  );
}
