/**
 * Tiny SSE wire-format helpers.
 *
 * SSE format:
 *   id: <eventId>
 *   event: <type>
 *   data: <json>
 *   <blank line>
 *
 * Comments (start with `:`) are used for heartbeat — they don't trigger
 * client onmessage but keep the connection alive through proxies.
 */

import type { UserEvent } from "./types";

const ENCODER = new TextEncoder();

export function formatSseEvent(event: UserEvent): Uint8Array {
  const json = JSON.stringify(event.data);
  const lines = [`id: ${event.id}`, `event: ${event.type}`, `data: ${json}`, "", ""];
  return ENCODER.encode(lines.join("\n"));
}

export function formatSseComment(text: string): Uint8Array {
  return ENCODER.encode(`: ${text}\n\n`);
}
