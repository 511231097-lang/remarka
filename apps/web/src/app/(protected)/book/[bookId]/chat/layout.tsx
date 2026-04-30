import { BookChat } from "@/components/BookChat";

/**
 * Wrapping `<BookChat />` in a Next.js layout — instead of rendering it from
 * each `page.tsx` — keeps the chat instance STABLE when the user switches
 * between sessions. Without this, navigating from /chat to /chat/[sessionId]
 * (or between two sessionIds) unmounts/remounts `<BookChat />` because each
 * route segment has its own `page.tsx`. The layout file persists across all
 * routes underneath, so the sessions sidebar, header, and messages list keep
 * their own state and DOM, and only the URL params change.
 *
 * BookChat itself reads `useParams()` reactively — when sessionId changes,
 * it refetches messages without recreating the whole component tree.
 *
 * Page files under this layout (chat/page.tsx, chat/[sessionId]/page.tsx)
 * intentionally render `null` — all UI lives in this layout.
 */
export default function BookChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <BookChat />
      {children}
    </>
  );
}
