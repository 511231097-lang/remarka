import test from "node:test";
import assert from "node:assert/strict";

import { isBookVisibleToViewer } from "./bookView";

// Privacy matrix lock-in tests. The shared helper drives both `/book/[bookId]`
// SSR (including `generateMetadata`) and `GET /api/books/[bookId]` —
// regressions here would silently leak private books to anonymous probes
// or hide owner's books from themselves. Treat any change to these tests
// as a security review trigger.

const PUBLIC_BOOK = { isPublic: true, ownerUserId: "owner-1" };
const PRIVATE_BOOK = { isPublic: false, ownerUserId: "owner-1" };

test("public book is visible to anonymous viewer", () => {
  assert.equal(isBookVisibleToViewer(PUBLIC_BOOK, null), true);
});

test("public book is visible to non-owner authenticated viewer", () => {
  assert.equal(isBookVisibleToViewer(PUBLIC_BOOK, { id: "someone-else" }), true);
});

test("public book is visible to its owner", () => {
  assert.equal(isBookVisibleToViewer(PUBLIC_BOOK, { id: "owner-1" }), true);
});

test("private book is hidden from anonymous viewer", () => {
  assert.equal(isBookVisibleToViewer(PRIVATE_BOOK, null), false);
});

test("private book is hidden from non-owner authenticated viewer", () => {
  // Critical: even authenticated users must not see another user's private
  // book. A regression here would expose private uploads across accounts.
  assert.equal(isBookVisibleToViewer(PRIVATE_BOOK, { id: "someone-else" }), false);
});

test("private book is visible to its owner", () => {
  assert.equal(isBookVisibleToViewer(PRIVATE_BOOK, { id: "owner-1" }), true);
});

test("ownerUserId comparison is exact (no prefix/substring leaks)", () => {
  // Defensive: if anyone ever switches to startsWith/includes-style ID
  // matching this test fails immediately.
  const book = { isPublic: false, ownerUserId: "owner-1" };
  assert.equal(isBookVisibleToViewer(book, { id: "owner-12" }), false);
  assert.equal(isBookVisibleToViewer(book, { id: "owner-" }), false);
  assert.equal(isBookVisibleToViewer(book, { id: "" }), false);
});
