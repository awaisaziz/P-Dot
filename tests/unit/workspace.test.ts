import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { countWorkModeRows } from "@/server/db/workspace";

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

interface Call {
  table: string;
  columns?: string;
  options?: unknown;
  filters: [string, unknown][];
}

type Result = { count: number | null; error: unknown } | Error;

/** A fake query builder that answers each table with the given head-only count result. */
function fakeSupabase(results: Record<string, Result>) {
  const calls: Call[] = [];
  const supabase = {
    from(table: string) {
      const call: Call = { table, filters: [] };
      calls.push(call);
      const builder = {
        select(columns: string, options?: unknown) {
          call.columns = columns;
          call.options = options;
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return builder;
        },
        then<T>(resolve: (value: unknown) => T, reject: (reason: unknown) => T) {
          const result = results[table] ?? { count: 0, error: null };
          return result instanceof Error ? Promise.reject(result).then(resolve, reject) : Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { supabase: supabase as unknown as SupabaseClient, calls };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("countWorkModeRows", () => {
  it("sums head-only Work counts over the five tables, scoped to the user", async () => {
    const { supabase, calls } = fakeSupabase({
      conversations: { count: 2, error: null },
      tasks: { count: 3, error: null },
      memories: { count: 0, error: null },
      documents: { count: 1, error: null },
      reminders: { count: 4, error: null },
    });
    expect(await countWorkModeRows(supabase, ALICE)).toBe(10);
    expect(calls.map((c) => c.table).sort()).toEqual(["conversations", "documents", "memories", "reminders", "tasks"]);
    for (const call of calls) {
      expect(call.columns).toBe("id");
      expect(call.options).toEqual({ count: "exact", head: true });
      expect(call.filters).toEqual([
        ["user_id", ALICE],
        ["mode", "work"],
      ]);
    }
  });

  it("answers 0 when the user has no Work rows", async () => {
    const { supabase } = fakeSupabase({});
    expect(await countWorkModeRows(supabase, ALICE)).toBe(0);
  });

  it.each([
    ["an error result", { count: null, error: { message: "boom" } }],
    ["a missing count", { count: null, error: null }],
    ["a thrown error", new Error("network")],
  ])("answers 0 for %s on any table", async (_label, failure) => {
    const { supabase } = fakeSupabase({ tasks: { count: 3, error: null }, reminders: failure as Result });
    expect(await countWorkModeRows(supabase, ALICE)).toBe(0);
  });

  it("logs no user ID when it fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { supabase } = fakeSupabase({ memories: new Error("network") });
    await countWorkModeRows(supabase, ALICE);
    expect(warn).toHaveBeenCalled();
    for (const [line] of warn.mock.calls) expect(String(line)).not.toContain(ALICE);
  });
});
