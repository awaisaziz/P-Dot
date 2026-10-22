import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRetrievalRepository } from "@/server/db/retrieval";
import { RepositoryError } from "@/server/db/conversations";

interface RpcCall {
  name: string;
  args: { p_query: string; p_mode: string | null; p_count: number };
}

type Rows = Record<string, unknown>[];

/**
 * A fake supabase.rpc. By default it behaves like the OLD database functions:
 * it keeps only the rows saved with p_mode, so a null mode matches nothing.
 * With `newFunction` a null mode matches every row, as after migration
 * 20261022000000_one_workspace.sql. Rows come back most similar first and cut
 * to p_count, as the functions do.
 */
function fakeSupabase(rowsByMode: Record<string, Rows>, options: { failMode?: string; newFunction?: boolean } = {}) {
  const calls: RpcCall[] = [];
  const supabase = {
    async rpc(name: string, args: RpcCall["args"]) {
      calls.push({ name, args });
      if (options.failMode !== undefined && args.p_mode === options.failMode) {
        return { data: null, error: { message: "boom" } };
      }
      const rows =
        args.p_mode === null
          ? options.newFunction
            ? Object.values(rowsByMode).flat()
            : []
          : (rowsByMode[args.p_mode] ?? []);
      const sorted = [...rows].sort((a, b) => (b.similarity as number) - (a.similarity as number));
      return { data: sorted.slice(0, Math.min(Math.max(args.p_count, 1), 20)), error: null };
    },
  };
  return { supabase: supabase as unknown as SupabaseClient, calls };
}

const memory = (id: string, similarity: number) => ({ id, content: `memory ${id}`, similarity });
const chunk = (id: string, similarity: number) => ({
  id,
  document_id: `doc-${id}`,
  title: `Doc ${id}`,
  content: `chunk ${id}`,
  similarity,
});

describe("matchMemories", () => {
  it("with a null mode asks for each saved mode once, then merges by similarity and cuts to the count", async () => {
    const { supabase, calls } = fakeSupabase({
      personal: [memory("p1", 0.9), memory("p2", 0.5), memory("p3", 0.2)],
      work: [memory("w1", 0.8), memory("w2", 0.6), memory("w3", 0.1)],
    });
    const matches = await createRetrievalRepository(supabase).matchMemories([0.1, 0.2], null, 4);

    expect(matches.map((m) => m.id)).toEqual(["p1", "w1", "w2", "p2"]);
    expect(matches[0]).toEqual({ id: "p1", content: "memory p1", similarity: 0.9 });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.args.p_mode).sort()).toEqual(["personal", "work"]);
    for (const call of calls) {
      expect(call).toEqual({ name: "match_memories", args: { p_query: "[0.1,0.2]", p_mode: call.args.p_mode, p_count: 4 } });
    }
    // Never a null mode: the old function would match nothing for it.
    expect(calls.some((c) => c.args.p_mode === null)).toBe(false);
  });

  it("starts both searches before either answers", async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const supabase = {
      async rpc(_name: string, args: RpcCall["args"]) {
        started.push(args.p_mode as string);
        await gate;
        return { data: [], error: null };
      },
    } as unknown as SupabaseClient;

    const pending = createRetrievalRepository(supabase).matchMemories([1], null, 5);
    await Promise.resolve();
    expect(started.sort()).toEqual(["personal", "work"]);
    release();
    expect(await pending).toEqual([]);
  });

  it("keeps one row per id, the most similar one", async () => {
    const { supabase } = fakeSupabase({
      personal: [memory("same", 0.4), memory("p1", 0.3)],
      work: [memory("same", 0.7)],
    });
    const matches = await createRetrievalRepository(supabase).matchMemories([1], null, 5);
    expect(matches).toEqual([memory("same", 0.7), memory("p1", 0.3)]);
  });

  it("passes a mode through unchanged in one call", async () => {
    const { supabase, calls } = fakeSupabase({
      personal: [memory("p1", 0.9)],
      work: [memory("w1", 0.8), memory("w2", 0.6)],
    });
    const matches = await createRetrievalRepository(supabase).matchMemories([0.5], "work", 3);
    expect(calls).toEqual([{ name: "match_memories", args: { p_query: "[0.5]", p_mode: "work", p_count: 3 } }]);
    expect(matches.map((m) => m.id)).toEqual(["w1", "w2"]);
  });

  it("returns the same rows on the old function and on the new one that accepts a null mode", async () => {
    const rows = { personal: [memory("p1", 0.9), memory("p2", 0.3)], work: [memory("w1", 0.6)] };
    const old = fakeSupabase(rows);
    const fresh = fakeSupabase(rows, { newFunction: true });

    const onOld = await createRetrievalRepository(old.supabase).matchMemories([1], null, 5);
    const onNew = await createRetrievalRepository(fresh.supabase).matchMemories([1], null, 5);
    expect(onOld.map((m) => m.id)).toEqual(["p1", "w1", "p2"]);
    expect(onNew).toEqual(onOld);
  });

  it("caps the merged list at 20, like the database functions", async () => {
    const many = (prefix: string) => Array.from({ length: 20 }, (_, i) => memory(`${prefix}${i}`, 1 - i / 100));
    const { supabase } = fakeSupabase({ personal: many("p"), work: many("w") });
    expect(await createRetrievalRepository(supabase).matchMemories([1], null, 50)).toHaveLength(20);
  });

  it("throws a RepositoryError when either search fails", async () => {
    const { supabase } = fakeSupabase({ personal: [memory("p1", 0.9)] }, { failMode: "work" });
    await expect(createRetrievalRepository(supabase).matchMemories([1], null, 5)).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe("matchDocumentChunks", () => {
  it("with a null mode merges both searches by similarity, maps the columns and cuts to the count", async () => {
    const { supabase, calls } = fakeSupabase({
      personal: [chunk("p1", 0.4), chunk("p2", 0.35)],
      work: [chunk("w1", 0.95), chunk("w2", 0.3)],
    });
    const matches = await createRetrievalRepository(supabase).matchDocumentChunks([0.3], null, 3);

    expect(matches).toEqual([
      { id: "w1", documentId: "doc-w1", title: "Doc w1", content: "chunk w1", similarity: 0.95 },
      { id: "p1", documentId: "doc-p1", title: "Doc p1", content: "chunk p1", similarity: 0.4 },
      { id: "p2", documentId: "doc-p2", title: "Doc p2", content: "chunk p2", similarity: 0.35 },
    ]);
    expect(calls.map((c) => c.name)).toEqual(["match_document_chunks", "match_document_chunks"]);
    expect(calls.map((c) => c.args.p_mode).sort()).toEqual(["personal", "work"]);
    expect(calls.every((c) => c.args.p_count === 3 && c.args.p_query === "[0.3]")).toBe(true);
  });

  it("passes a mode through unchanged in one call", async () => {
    const { supabase, calls } = fakeSupabase({ personal: [chunk("p1", 0.4)], work: [chunk("w1", 0.9)] });
    const matches = await createRetrievalRepository(supabase).matchDocumentChunks([0.3], "personal", 2);
    expect(calls).toEqual([{ name: "match_document_chunks", args: { p_query: "[0.3]", p_mode: "personal", p_count: 2 } }]);
    expect(matches.map((m) => m.id)).toEqual(["p1"]);
  });

  it("throws a RepositoryError when either search fails", async () => {
    const { supabase } = fakeSupabase({ work: [chunk("w1", 0.9)] }, { failMode: "personal" });
    await expect(createRetrievalRepository(supabase).matchDocumentChunks([1], null, 5)).rejects.toBeInstanceOf(
      RepositoryError,
    );
  });
});
