import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/server/auth/session";
import { getAssistantConfig } from "@/server/config";
import { toNdjsonStream } from "@/server/http/ndjson";
import type { ChatStreamEvent } from "@/types/api";

// Work that must outlive the response (decision 0017). `nextRequest` stands in
// for Next's request scope: the after() below throws outside it, as Next's does.
const nextRequest = new AsyncLocalStorage<{ handed: Promise<unknown>[] }>();
/** Set to act as the Cloudflare Workers runtime. */
let workersCtx: { waitUntil: (work: Promise<unknown>) => void } | null = null;

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    if (!workersCtx) throw new Error("Not running in the Workers runtime.");
    return { ctx: workersCtx };
  },
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: Promise<unknown>) => {
    const request = nextRequest.getStore();
    if (!request) throw new Error("`after` was called outside a request scope.");
    request.handed.push(task);
  },
}));

const { createAssistantDeps, createWaitUntilForRequest, waitUntil } = await import("@/server/assistant/deps");

afterEach(() => {
  workersCtx = null;
});

function newRequest() {
  return { handed: [] as Promise<unknown>[] };
}

describe("waitUntil", () => {
  it("hands work to the Workers ctx.waitUntil on Cloudflare, not to after()", () => {
    const toWorkers: Promise<unknown>[] = [];
    workersCtx = {
      waitUntil: (work) => {
        toWorkers.push(work);
      },
    };
    const request = newRequest();
    const work = Promise.resolve();
    nextRequest.run(request, () => waitUntil(work));
    expect(toWorkers).toEqual([work]);
    expect(request.handed).toEqual([]);
  });

  it("hands work to Next's after() elsewhere", () => {
    const request = newRequest();
    const work = Promise.resolve();
    nextRequest.run(request, () => waitUntil(work));
    expect(request.handed).toEqual([work]);
  });

  it("lets the work simply run outside a request", async () => {
    let ran = false;
    const work = Promise.resolve().then(() => {
      ran = true;
    });
    expect(() => waitUntil(work)).not.toThrow();
    await work;
    expect(ran).toBe(true);
  });
});

describe("createWaitUntilForRequest", () => {
  it("reaches after() from a streamed reply that runs after the handler returned", async () => {
    const request = newRequest();
    const bound = Promise.resolve("bound");
    const plain = Promise.resolve("plain");
    async function* reply(handOff: (work: Promise<unknown>) => void): AsyncGenerator<ChatStreamEvent> {
      yield { type: "delta", text: "one" };
      yield { type: "delta", text: "two" };
      handOff(bound);
      waitUntil(plain);
      yield { type: "delta", text: "three" };
    }
    // The route handler builds the reply stream inside the request and returns it.
    const stream = nextRequest.run(request, () => toNdjsonStream(reply(createWaitUntilForRequest())));

    // A slow client: the stream waits with a chunk queued, so each later read
    // runs the reply's code in the reader's async context, outside the request.
    const reader = stream.getReader();
    let chunks = (await reader.read()).done ? 0 : 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    while (!(await reader.read()).done) chunks += 1;

    expect(chunks).toBe(3);
    // A plain waitUntil from the same place finds no request, so only the bound hand-off arrives.
    expect(request.handed).toEqual([bound]);
  });

  it("is the waitUntil that createAssistantDeps gives the assistant", () => {
    const request = newRequest();
    const auth = { userId: "user-1", email: null, supabase: {} } as unknown as AuthContext;
    const config = getAssistantConfig({ NEBIUS_API_KEY: "k", NODE_ENV: "test" });
    const deps = nextRequest.run(request, () => createAssistantDeps(auth, config));
    const work = Promise.resolve();
    deps.waitUntil(work);
    expect(request.handed).toEqual([work]);
  });
});
