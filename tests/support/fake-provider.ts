import { kindFromStatus, ProviderError } from "@/server/providers/errors";
import type { CompletionChunk, ModelCallRequest, ModelProvider, TokenUsage } from "@/server/providers/model";
import type { ToolCall } from "@/server/assistant/tools";

/**
 * What one call to a fake model does. Times use setTimeout, so tests can run
 * them with fake timers.
 */
export interface FakeBehavior {
  /** Wait before the response (time to first byte). */
  delayMs?: number;
  /** Fail with this HTTP status after the delay. */
  status?: number;
  retryAfterMs?: number;
  /** Fail with this error after the delay. */
  error?: ProviderError;
  /** Chunks after the delay. `reasoning` sends a reasoning marker; `toolCalls` a tool request. */
  chunks?: { text?: string; reasoning?: boolean; toolCalls?: ToolCall[]; delayMs?: number; error?: ProviderError }[];
  /** Usage in the finish chunk (null: none). Default 10 in, 5 out. */
  usage?: TokenUsage | null;
  /** Never finish (for deadline tests). */
  hang?: boolean;
}

export interface FakeCall {
  model: string;
  request: ModelCallRequest;
  startedAt: number;
  /** True once the call's signal was aborted. */
  aborted: boolean;
  /** True once the stream ended for any reason. */
  ended: boolean;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError("nebius", "aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new ProviderError("nebius", "aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A streaming provider with a script for each model. Each call to a model uses
 * the next behavior in its list; the last one repeats.
 */
export class FakeProvider implements ModelProvider {
  readonly name = "nebius" as const;
  calls: FakeCall[] = [];
  private used = new Map<string, number>();

  constructor(private readonly scripts: Record<string, FakeBehavior[]>) {}

  callsTo(model: string): FakeCall[] {
    return this.calls.filter((call) => call.model === model);
  }

  stream(request: ModelCallRequest, signal: AbortSignal): AsyncIterable<CompletionChunk> {
    const list = this.scripts[request.model] ?? [{ status: 404 }];
    const index = this.used.get(request.model) ?? 0;
    this.used.set(request.model, index + 1);
    const behavior = list[Math.min(index, list.length - 1)]!;
    const call: FakeCall = { model: request.model, request, startedAt: Date.now(), aborted: false, ended: false };
    signal.addEventListener("abort", () => (call.aborted = true), { once: true });
    this.calls.push(call);

    return (async function* () {
      try {
        await wait(behavior.delayMs ?? 0, signal);
        if (behavior.status) {
          throw new ProviderError("nebius", kindFromStatus(behavior.status), behavior.status, {
            retryAfterMs: behavior.retryAfterMs,
          });
        }
        if (behavior.error) throw behavior.error;
        for (const chunk of behavior.chunks ?? [{ text: `Answer from ${request.model}.` }]) {
          if (chunk.delayMs) await wait(chunk.delayMs, signal);
          if (chunk.error) throw chunk.error;
          if (chunk.reasoning) yield { type: "reasoning" as const };
          if (chunk.text !== undefined) yield { type: "text" as const, text: chunk.text };
          if (chunk.toolCalls) yield { type: "tool_calls" as const, calls: chunk.toolCalls };
        }
        if (behavior.hang) await wait(10 ** 9, signal);
        yield {
          type: "finish" as const,
          finishReason: "stop",
          usage: behavior.usage === undefined ? { promptTokens: 10, completionTokens: 5 } : behavior.usage,
        };
      } finally {
        call.ended = true;
      }
    })();
  }
}
