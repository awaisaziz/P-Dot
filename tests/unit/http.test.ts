import { describe, expect, it } from "vitest";
import { readChatStream, StreamFormatError } from "@/features/chat/stream";
import { getAssistantConfig, getSiteUrl } from "@/server/config";
import { ConfigError } from "@/lib/supabase-config";
import { isSameOrigin, readJsonBody } from "@/server/http/request";
import { collect, streamFrom } from "../support/streams";

function post(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("readJsonBody", () => {
  it("parses JSON within the size limit", async () => {
    expect(await readJsonBody(post('{"a":1}'), 100)).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rejects bodies over the limit even without a content-length header", async () => {
    const request = new Request("http://localhost/api/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: streamFrom(['{"a":"', "x".repeat(200), '"}']),
      duplex: "half",
    } as RequestInit);
    expect(await readJsonBody(request, 100)).toMatchObject({ ok: false, status: 413 });
  });

  it("rejects other content types", async () => {
    expect(await readJsonBody(post("{}", { "content-type": "text/plain" }), 100)).toMatchObject({ status: 415 });
  });
});

describe("isSameOrigin", () => {
  const request = (headers: Record<string, string>) => new Request("http://localhost/", { headers });

  it("accepts matching or absent Origin headers", () => {
    expect(isSameOrigin(request({ host: "app.example", origin: "https://app.example" }))).toBe(true);
    expect(isSameOrigin(request({ host: "app.example" }))).toBe(true);
  });

  it("rejects other origins", () => {
    expect(isSameOrigin(request({ host: "app.example", origin: "https://evil.example" }))).toBe(false);
    expect(isSameOrigin(request({ host: "app.example", origin: "null" }))).toBe(false);
  });
});

describe("readChatStream", () => {
  it("parses events split across chunks", async () => {
    const events = await collect(
      readChatStream(streamFrom(['{"type":"delta","te', 'xt":"a"}\n\n{"type":"delta","text":"b"}\n{"type":"done"', ',"message":{},"truncated":false}'])),
    );
    expect(events.map((e) => e.type)).toEqual(["delta", "delta", "done"]);
  });

  it("skips events of an unknown type, so a newer server does not break an older tab", async () => {
    const events = await collect(
      readChatStream(streamFrom(['{"type":"exec"}\n{"type":"delta","text":"a"}\n{"type":"later_event","x":1}'])),
    );
    expect(events.map((e) => e.type)).toEqual(["delta"]);
  });

  it("passes step and result events through", async () => {
    const step = { type: "step", step: { id: "flights.search", label: "Searched the web", status: "done" } };
    const result = { type: "result", result: { kind: "calendar", events: [], window: { start: "a", end: "b" } } };
    const events = await collect(readChatStream(streamFrom([`${JSON.stringify(step)}\n${JSON.stringify(result)}\n`])));
    expect(events).toEqual([step, result]);
  });

  it("rejects malformed JSON and events without a string type", async () => {
    await expect(collect(readChatStream(streamFrom(['{"type":"delta"\n'])))).rejects.toBeInstanceOf(StreamFormatError);
    await expect(collect(readChatStream(streamFrom(['{"text":"a"}\n'])))).rejects.toBeInstanceOf(StreamFormatError);
    await expect(collect(readChatStream(streamFrom(['{"type":7}\n'])))).rejects.toBeInstanceOf(StreamFormatError);
    await expect(collect(readChatStream(streamFrom(["null\n"])))).rejects.toBeInstanceOf(StreamFormatError);
  });
});

describe("getAssistantConfig", () => {
  it("requires the Nebius key and reports names only", () => {
    try {
      getAssistantConfig({ NEBIUS_API_KEY: "", NODE_ENV: "test" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).missing).toEqual(["NEBIUS_API_KEY"]);
    }
  });

  it.each(["NEBIUS_FAST_MODELS", "NEBIUS_STANDARD_MODELS", "NEBIUS_HEAVY_MODELS", "NEBIUS_VISION_MODELS"])(
    "refuses a model without a price in %s, naming the variable but not the value",
    (name) => {
      try {
        getAssistantConfig({
          NEBIUS_API_KEY: "k",
          [name]: "nvidia/nemotron-3-super-120b-a12b,moonshotai/Kimi-K3",
          NODE_ENV: "test",
        });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).missing).toEqual([name]);
        expect(String((error as Error).message)).not.toContain("Kimi");
      }
    },
  );

  it.each([
    ["more than four models", "nvidia/Nemotron-3_5-Lightning,nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B,nvidia/nemotron-3-super-120b-a12b,nvidia/Nemotron-3-Ultra-550b-a55b,nvidia/Nemotron-3.5-Super-VL"],
    ["the same model twice", "nvidia/nemotron-3-super-120b-a12b,nvidia/nemotron-3-super-120b-a12b"],
    ["only commas", ", ,"],
  ])("refuses a chain with %s", (_label, value) => {
    expect(() => getAssistantConfig({ NEBIUS_API_KEY: "k", NEBIUS_FAST_MODELS: value, NODE_ENV: "test" })).toThrow(
      ConfigError,
    );
  });

  it("refuses a reasoning budget that leaves less than 512 tokens for the reply", () => {
    expect(() =>
      getAssistantConfig({
        NEBIUS_API_KEY: "k",
        NEBIUS_HEAVY_MAX_OUTPUT_TOKENS: "2048",
        NEBIUS_HEAVY_THINKING_BUDGET: "1600",
        NODE_ENV: "test",
      }),
    ).toThrow(ConfigError);
  });

  it("applies defaults and treats a blank Tavily key as search disabled", () => {
    const config = getAssistantConfig({
      NEBIUS_API_KEY: "secret",
      NEBIUS_BASE_URL: "https://api.tokenfactory.nebius.com/v1/",
      TAVILY_API_KEY: " ",
      NODE_ENV: "test",
    });
    expect(config.nebius).toEqual({ apiKey: "secret", baseUrl: "https://api.tokenfactory.nebius.com/v1" });
    expect(config.tavily).toBeNull();
    expect(config.quota).toEqual({ requestsPerWindow: 30, windowSeconds: 3600 });
    expect(config.spend).toEqual({
      nebius: { day: 1_000_000, period: 20_000_000, userDay: 250_000 },
      tavily: { day: 40, period: 800, userDay: 10 },
    });
    expect(config.routing.fast).toMatchObject({
      models: ["nvidia/Nemotron-3_5-Lightning", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", "nvidia/nemotron-3-super-120b-a12b"],
      maxOutputTokens: 1024,
      thinkingBudgetTokens: 0,
      hedgeAfterMs: 1500,
    });
    expect(config.routing.standard).toMatchObject({
      models: ["nvidia/nemotron-3-super-120b-a12b", "nvidia/Nemotron-3_5-Lightning"],
      maxOutputTokens: 2048,
      thinkingBudgetTokens: 0,
      hedgeAfterMs: null,
    });
    expect(config.routing.heavy).toMatchObject({
      models: ["nvidia/Nemotron-3-Ultra-550b-a55b", "nvidia/nemotron-3-super-120b-a12b"],
      maxOutputTokens: 4096,
      thinkingBudgetTokens: 1024,
      hedgeAfterMs: null,
    });
    expect(config.routing.vision).toMatchObject({ models: ["nvidia/Nemotron-3.5-Super-VL"], hedgeAfterMs: null });
  });

  it("reads model chains and turns hedging off with 0", () => {
    const config = getAssistantConfig({
      NEBIUS_API_KEY: "k",
      NEBIUS_FAST_MODELS: " nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B , nvidia/Nemotron-3_5-Lightning ",
      NEBIUS_HEDGE_AFTER_MS: "0",
      NEBIUS_HEAVY_THINKING_BUDGET: "0",
      NODE_ENV: "test",
    });
    expect(config.routing.fast.models).toEqual(["nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", "nvidia/Nemotron-3_5-Lightning"]);
    expect(config.routing.fast.hedgeAfterMs).toBeNull();
    expect(config.routing.heavy.thinkingBudgetTokens).toBe(0);
  });

  it("reads spend caps in dollars and credits", () => {
    const config = getAssistantConfig({
      NEBIUS_API_KEY: "k",
      NEBIUS_DAILY_CAP_USD: "2.5",
      NEBIUS_TOTAL_CAP_USD: "15",
      NEBIUS_USER_DAILY_CAP_USD: "0.1",
      TAVILY_DAILY_CREDITS: "20",
      TAVILY_MONTHLY_CREDITS: "500",
      TAVILY_USER_DAILY_CREDITS: "5",
      NODE_ENV: "test",
    });
    expect(config.spend).toEqual({
      nebius: { day: 2_500_000, period: 15_000_000, userDay: 100_000 },
      tavily: { day: 20, period: 500, userDay: 5 },
    });
  });

  it("never lets the per-user cap pass the cap for all users", () => {
    const config = getAssistantConfig({
      NEBIUS_API_KEY: "k",
      NEBIUS_DAILY_CAP_USD: "0.1",
      TAVILY_DAILY_CREDITS: "3",
      NODE_ENV: "test",
    });
    expect(config.spend.nebius).toMatchObject({ day: 100_000, userDay: 100_000 });
    expect(config.spend.tavily).toMatchObject({ day: 3, userDay: 3 });
  });

  it.each([
    ["NEBIUS_DAILY_CAP_USD", "0"],
    ["NEBIUS_DAILY_CAP_USD", "101"],
    ["NEBIUS_TOTAL_CAP_USD", "-1"],
    ["NEBIUS_USER_DAILY_CAP_USD", "0.6"],
    ["TAVILY_DAILY_CREDITS", "1.5"],
    ["TAVILY_MONTHLY_CREDITS", "0"],
    ["TAVILY_USER_DAILY_CREDITS", "21"],
    ["NEBIUS_TOTAL_CAP_USD", "abc"],
  ])("rejects %s=%s and names only the variable", (name, value) => {
    try {
      getAssistantConfig({ NEBIUS_API_KEY: "k", NEBIUS_MODEL: "nvidia/nemotron-3-super-120b-a12b", [name]: value, NODE_ENV: "test" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).missing).toEqual([name]);
    }
  });

  it("rejects out-of-range limits", () => {
    expect(() =>
      getAssistantConfig({ NEBIUS_API_KEY: "k", NEBIUS_MODEL: "nvidia/nemotron-3-super-120b-a12b", CHAT_WINDOW_SECONDS: "5", NODE_ENV: "test" }),
    ).toThrow(ConfigError);
  });
});

describe("getSiteUrl", () => {
  it("uses SITE_URL without a trailing slash, else localhost", () => {
    expect(getSiteUrl({ SITE_URL: "https://p-dot.example/", NODE_ENV: "test" })).toBe("https://p-dot.example");
    expect(getSiteUrl({ NODE_ENV: "test" })).toBe("http://localhost:3000");
  });
});
