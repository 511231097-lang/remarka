/**
 * Public surface of the events module.
 *
 * Server-side: types, emit helpers, EventBus singleton, snapshot store.
 * Client-side: import from `./EventChannelProvider` directly (it's "use client").
 */

export type {
  BookAnalysisDoneData,
  BookAnalysisProgressData,
  ChatErrorData,
  ChatFinalData,
  ChatSnapshotData,
  ChatStatusData,
  ChatTokenData,
  ChatToolData,
  EventDataMap,
  EventType,
  NotifyPayload,
  UserEvent,
} from "./types";
export { USER_EVENTS_CHANNEL } from "./types";
export { eventBus } from "./bus";
export { snapshotStore } from "./snapshotStore";
export { emitToUser, notifyUserEvent } from "./emit";
export { listenBridge } from "./listenBridge";
export { nextEventId } from "./eventId";
