import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import {
  appendDictation,
  dictationErrorMessage,
  finalText,
  interimText,
  listensContinuously,
  type SpeechResultEvent,
} from "@/features/chat/useDictation";

const result = (transcript: string, isFinal: boolean) => ({ isFinal, 0: { transcript } });
const event = (resultIndex: number, ...results: ReturnType<typeof result>[]): SpeechResultEvent => ({
  resultIndex,
  results,
});

describe("dictation results", () => {
  it("takes only new final words for the message, and the rest as what is being heard", () => {
    const e = event(1, result("already used", true), result(" remind me ", true), result("to call", false));
    expect(finalText(e)).toBe("remind me");
    expect(interimText(e)).toBe("to call");
  });

  it("returns nothing when there are no new words", () => {
    const e = event(1, result("already used", true));
    expect(finalText(e)).toBe("");
    expect(interimText(e)).toBe("");
  });

  it("adds a phrase after a space and keeps the draft within the message limit", () => {
    expect(appendDictation("", "hello", 10)).toBe("hello");
    expect(appendDictation("Plan  ", "my week", 100)).toBe("Plan my week");
    expect(appendDictation("12345", "678901234", 10)).toBe("12345 6789");
  });
});

describe("dictation errors", () => {
  it("says nothing when dictation was stopped on purpose", () => {
    expect(dictationErrorMessage("aborted")).toBeNull();
  });

  it("explains a blocked microphone and unknown errors", () => {
    expect(dictationErrorMessage("not-allowed")).toMatch(/Allow the microphone for this site/);
    expect(dictationErrorMessage("something-new")).toBe("Dictation stopped unexpectedly; try again.");
  });
});

describe("listening mode", () => {
  it("listens one phrase at a time on Android and continuously elsewhere", () => {
    expect(listensContinuously("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131.0 Mobile Safari/537.36")).toBe(false);
    expect(listensContinuously("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36")).toBe(true);
  });
});

describe("security headers", () => {
  it("lets P-Dot's own pages use the microphone, and nothing else", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const policy = rules.flatMap((rule) => rule.headers).find((h) => h.key === "Permissions-Policy")?.value;
    expect(policy).toContain("microphone=(self)");
    expect(policy).toContain("camera=()");
    expect(policy).toContain("geolocation=()");
  });
});
