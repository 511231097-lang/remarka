/**
 * Monotonic event id generator.
 *
 * Format: `<timestampMs>-<seq>` where seq increments per process. This is
 * sortable lexicographically by time and unique within a process. We avoid
 * full ULID to keep zero deps; for our purposes (Last-Event-ID resume not
 * implemented in phase 1) this is more than sufficient.
 */

let lastTimestamp = 0;
let sequence = 0;

export function nextEventId(): string {
  const now = Date.now();
  if (now === lastTimestamp) {
    sequence += 1;
  } else {
    lastTimestamp = now;
    sequence = 0;
  }
  return `${now}-${sequence.toString(36)}`;
}
