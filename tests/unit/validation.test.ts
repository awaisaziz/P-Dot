import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_CHARS } from "@/lib/limits";
import { MAX_SAFE_URL_CHARS, safeNextPath, toSafeHttpUrl } from "@/lib/safe-url";
import { chatRequestSchema, newPasswordSchema } from "@/lib/schemas";

const ID = "3f8e2a4c-9b1d-4e7f-8a2b-1c3d5e7f9a0b";

describe("chatRequestSchema", () => {
  it("accepts a new message and trims it", () => {
    const result = chatRequestSchema.safeParse({ action: "send", message: "  hi  ", webSearch: false });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ action: "send", message: "hi", webSearch: false });
  });

  it("accepts a message for an existing conversation", () => {
    const result = chatRequestSchema.safeParse({ action: "send", conversationId: ID, message: "hi", webSearch: true });
    expect(result.success).toBe(true);
  });

  it.each([
    ["empty message", { action: "send", message: "   ", webSearch: false }],
    ["too long", { action: "send", message: "x".repeat(MAX_MESSAGE_CHARS + 1), webSearch: false }],
    ["missing webSearch", { action: "send", message: "hi" }],
    ["non-boolean webSearch", { action: "send", message: "hi", webSearch: "yes" }],
    ["malformed conversation ID", { action: "send", conversationId: "123", message: "hi", webSearch: false }],
    ["client-supplied user ID", { action: "send", message: "hi", webSearch: false, userId: ID }],
    ["retry without conversation", { action: "retry", webSearch: false }],
    ["retry with a message", { action: "retry", conversationId: ID, message: "hi", webSearch: false }],
    ["unknown action", { action: "delete", conversationId: ID, webSearch: false }],
    ["not an object", "hello"],
  ])("rejects %s", (_label, body) => {
    expect(chatRequestSchema.safeParse(body).success).toBe(false);
  });

  it("accepts a message at exactly the limit", () => {
    const body = { action: "send", message: "x".repeat(MAX_MESSAGE_CHARS), webSearch: false };
    expect(chatRequestSchema.safeParse(body).success).toBe(true);
  });

  it("accepts the browser's time zone and the Google chip on send and on retry", () => {
    const send = { action: "send", message: "hi", webSearch: false, timeZone: "America/Argentina/Buenos_Aires", connectors: { google: true } };
    expect(chatRequestSchema.safeParse(send).data).toEqual(send);
    const retry = { action: "retry", conversationId: ID, webSearch: false, timeZone: "Etc/GMT+5", connectors: { google: false } };
    expect(chatRequestSchema.safeParse(retry).success).toBe(true);
    // Both are optional; a missing chip means off.
    expect(chatRequestSchema.safeParse({ action: "send", message: "hi", webSearch: false, connectors: {} }).success).toBe(true);
  });

  it.each([
    ["a time zone over 64 characters", { timeZone: `Europe/${"x".repeat(60)}` }],
    ["a time zone with markup", { timeZone: "<script>" }],
    ["an empty time zone", { timeZone: " " }],
    ["a time zone that is not text", { timeZone: 5 }],
    ["an unknown connector", { connectors: { slack: true } }],
    ["a chip that is not a boolean", { connectors: { google: "yes" } }],
  ])("rejects %s", (_label, extra) => {
    expect(chatRequestSchema.safeParse({ action: "send", message: "hi", webSearch: false, ...extra }).success).toBe(false);
  });
});

describe("newPasswordSchema", () => {
  it("requires at least 8 characters", () => {
    expect(newPasswordSchema.safeParse("short").success).toBe(false);
    expect(newPasswordSchema.safeParse("long enough").success).toBe(true);
  });

  it("rejects passwords longer than 72 bytes", () => {
    expect(newPasswordSchema.safeParse("é".repeat(37)).success).toBe(false); // 74 bytes
    expect(newPasswordSchema.safeParse("a".repeat(72)).success).toBe(true);
  });
});

describe("toSafeHttpUrl", () => {
  it.each(["https://example.com/a?b=1", "http://example.org/"])("allows %s", (url) => {
    expect(toSafeHttpUrl(url)).toBe(new URL(url).toString());
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://example.com/file",
    "https://user:pass@example.com/",
    "not a url",
    "",
    42,
    null,
  ])("rejects %s", (url) => {
    expect(toSafeHttpUrl(url)).toBeNull();
  });

  it("rejects a URL that is short enough before normalization but too long after it", () => {
    // Each CJK character becomes 9 ASCII bytes: %E4%B8%AD.
    const fits = `https://e0.com/${"中".repeat(225)}${"a".repeat(8)}`;
    expect(toSafeHttpUrl(fits)).toHaveLength(MAX_SAFE_URL_CHARS);
    const expands = `https://e0.com/${"中".repeat(226)}`;
    expect(expands.length).toBeLessThan(MAX_SAFE_URL_CHARS);
    expect(toSafeHttpUrl(expands)).toBeNull();
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin paths", () => {
    expect(safeNextPath("/chat?c=1")).toBe("/chat?c=1");
    expect(safeNextPath("/settings")).toBe("/settings");
  });

  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "chat", "", undefined, "/x\u0000"])(
    "falls back for %s",
    (value) => {
      expect(safeNextPath(value)).toBe("/chat");
    },
  );
});
