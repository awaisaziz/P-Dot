"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/api-client";
import type { MemoryDTO } from "@/types/api";
import { fetchMemories } from "./api";

export type SuggestionOutcome = "waiting" | "kept" | "dropped";

export interface MemorySuggestion {
  memory: MemoryDTO;
  outcome: SuggestionOutcome;
  /** The message the suggestion came from, used to place it in the chat. */
  sourceMessageId: string | null;
}

/**
 * Memories P-Dot suggested (status "proposed"), plus the ones the
 * user kept or dropped in this view, so their outcome stays visible after a
 * reload. Reloads when `refreshKey` changes, for example after a chat reply.
 */
export function useMemorySuggestions({
  refreshKey = 0,
  enabled = true,
  onUnauthorized,
}: {
  refreshKey?: string | number;
  enabled?: boolean;
  onUnauthorized?: () => void;
}) {
  const [waiting, setWaiting] = useState<MemoryDTO[]>([]);
  const [decided, setDecided] = useState<ReadonlyMap<string, { memory: MemoryDTO; outcome: "kept" | "dropped" }>>(
    () => new Map(),
  );

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetchMemories("proposed", controller.signal).then(setWaiting, (err: unknown) => {
      if (controller.signal.aborted) return;
      if (err instanceof ApiError && err.status === 401) onUnauthorized?.();
      // Otherwise the chat shows no suggestions; the Memory page lists them all with its own errors.
    });
    return () => controller.abort();
  }, [enabled, refreshKey, onUnauthorized]);

  const settle = useCallback((memory: MemoryDTO, outcome: "kept" | "dropped") => {
    setDecided((current) => new Map(current).set(memory.id, { memory, outcome }));
  }, []);
  const kept = useCallback((memory: MemoryDTO) => settle(memory, "kept"), [settle]);
  const dropped = useCallback((memory: MemoryDTO) => settle(memory, "dropped"), [settle]);

  return { items: mergeSuggestions(waiting, decided), kept, dropped };
}

/**
 * Waiting suggestions with the decisions made in this view applied. A decided
 * one keeps its place; one that a reload no longer returns (kept or deleted)
 * is added at the end, so its outcome stays visible.
 */
export function mergeSuggestions(
  waiting: MemoryDTO[],
  decided: ReadonlyMap<string, { memory: MemoryDTO; outcome: "kept" | "dropped" }>,
): MemorySuggestion[] {
  const toItem = (memory: MemoryDTO, outcome: SuggestionOutcome) => ({
    memory,
    outcome,
    sourceMessageId: memory.sourceMessageId,
  });
  const items = waiting.map((memory) => {
    const done = decided.get(memory.id);
    return done ? toItem(done.memory, done.outcome) : toItem(memory, "waiting");
  });
  for (const [id, done] of decided) {
    if (!waiting.some((m) => m.id === id)) items.push(toItem(done.memory, done.outcome));
  }
  return items;
}
