import { strict as assert } from "node:assert";
import { describe, it, beforeEach } from "node:test";

import { eventBus } from "./bus";
import { nextEventId } from "./eventId";
import type { UserEvent } from "./types";

function chatToken(sessionId: string, text: string): UserEvent<"chat.token"> {
  return {
    id: nextEventId(),
    type: "chat.token",
    ts: new Date().toISOString(),
    data: { sessionId, text },
  };
}

describe("EventBus", () => {
  beforeEach(() => {
    (eventBus as unknown as { __resetForTests: () => void }).__resetForTests();
  });

  it("delivers events only to the matching userId", () => {
    const userA: UserEvent[] = [];
    const userB: UserEvent[] = [];

    eventBus.subscribe("user-a", (event) => userA.push(event));
    eventBus.subscribe("user-b", (event) => userB.push(event));

    eventBus.emit("user-a", chatToken("sess-1", "hello"));
    eventBus.emit("user-b", chatToken("sess-2", "world"));

    assert.equal(userA.length, 1);
    assert.equal(userB.length, 1);
    assert.equal((userA[0]?.data as { text: string }).text, "hello");
    assert.equal((userB[0]?.data as { text: string }).text, "world");
  });

  it("supports multiple listeners per user", () => {
    const a: string[] = [];
    const b: string[] = [];
    eventBus.subscribe("u1", (e) => a.push((e.data as { text: string }).text));
    eventBus.subscribe("u1", (e) => b.push((e.data as { text: string }).text));

    eventBus.emit("u1", chatToken("s", "x"));
    eventBus.emit("u1", chatToken("s", "y"));

    assert.deepEqual(a, ["x", "y"]);
    assert.deepEqual(b, ["x", "y"]);
  });

  it("unsubscribe removes only the targeted listener", () => {
    const received: string[] = [];
    const offA = eventBus.subscribe("u1", () => received.push("A"));
    eventBus.subscribe("u1", () => received.push("B"));

    eventBus.emit("u1", chatToken("s", "1"));
    offA();
    eventBus.emit("u1", chatToken("s", "2"));

    assert.deepEqual(received, ["A", "B", "B"]);
  });

  it("listener crash does not affect other listeners or the bus", () => {
    const survivors: string[] = [];
    eventBus.subscribe("u1", () => {
      throw new Error("boom");
    });
    eventBus.subscribe("u1", (e) => survivors.push((e.data as { text: string }).text));

    eventBus.emit("u1", chatToken("s", "ok"));
    eventBus.emit("u1", chatToken("s", "still-ok"));

    assert.deepEqual(survivors, ["ok", "still-ok"]);
    const metrics = eventBus.getMetrics();
    assert.equal(metrics.droppedTotal, 2);
  });

  it("emit with no listeners is a no-op", () => {
    eventBus.emit("nobody", chatToken("s", "x"));
    const metrics = eventBus.getMetrics();
    assert.equal(metrics.emittedTotal, 1);
    assert.equal(metrics.activeListeners, 0);
  });

  it("synchronous unsubscribe inside a listener does not break iteration", () => {
    const order: string[] = [];
    let off1: (() => void) | null = null;
    off1 = eventBus.subscribe("u1", () => {
      order.push("first");
      off1?.();
    });
    eventBus.subscribe("u1", () => order.push("second"));

    eventBus.emit("u1", chatToken("s", "x"));
    assert.deepEqual(order, ["first", "second"]);

    eventBus.emit("u1", chatToken("s", "y"));
    assert.deepEqual(order, ["first", "second", "second"]);
  });
});
