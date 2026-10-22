// Which turns Auto may act on (decisions 0011 and 0015). Pure, so it is
// unit-tested (tests/unit/chat-ui-auto.test.ts).
import { TAINTED_ASK_REASON } from "@/features/actions/format";
import type { ApprovalMode } from "@/lib/approval-policy";
import type { ActionProposalDTO, ChatStreamEvent, MessageRole } from "@/types/api";
import { turnStartFor } from "./placement";

/** Step IDs of the reads that taint a reply: a workflow's (flights.*, research.*) and a Google read's (google-<call>). */
const OUTSIDE_STEP = /^(?:flights\.|research\.|google-)/;

/**
 * Whether a stream event shows the reply read outside results, so Auto may
 * not act on it even when the stream ends without `done`. A result always
 * comes from a workflow or a Google read. A failed step read nothing (a
 * refused or skipped call). A workflow's search event always follows its own
 * steps, and the web search toggle does not taint a reply (decision 0015).
 */
export function readsOutside(event: ChatStreamEvent): boolean {
  if (event.type === "result") return true;
  if (event.type === "step") return event.step.status !== "failed" && OUTSIDE_STEP.test(event.step.id);
  return false;
}

/** The tainted turns with `turn` added when its reply read outside results. The same set when nothing changes. */
export function withTaintedTurn(
  tainted: ReadonlySet<string>,
  turn: string | null,
  readOutside: boolean,
): ReadonlySet<string> {
  if (!turn || !readOutside || tainted.has(turn)) return tainted;
  return new Set(tainted).add(turn);
}

/** The turns without `turn`. The same set when it was not there. */
export function withoutTurn(turns: ReadonlySet<string>, turn: string): ReadonlySet<string> {
  if (!turns.has(turn)) return turns;
  const next = new Set(turns);
  next.delete(turn);
  return next;
}

/**
 * The turns Auto may act on once a reply is done. A turn is added only when
 * its message was sent in Auto, the reply was not tainted (it read no web
 * pages and no Google data) and no earlier attempt at the same turn was
 * tainted (a Retry after a failed or stopped reply keeps that attempt's
 * proposals). Otherwise it is removed.
 */
export function autoTurnsAfterDone(
  turns: ReadonlySet<string>,
  turn: string,
  { sentInAuto, autoAllowed, tainted }: { sentInAuto: boolean; autoAllowed: boolean; tainted: ReadonlySet<string> },
): ReadonlySet<string> {
  if (sentInAuto && autoAllowed && !tainted.has(turn)) return turns.has(turn) ? turns : new Set(turns).add(turn);
  return withoutTurn(turns, turn);
}

interface TurnMessage {
  id: string;
  role: MessageRole;
  createdAt: string;
  pending?: boolean;
}

/** In Auto, the reasons shown on waiting cards, plus the tainted-reply reason for proposals from tainted turns. */
export function withTaintedReasons(
  asks: ReadonlyMap<string, string>,
  proposals: readonly ActionProposalDTO[],
  messages: readonly TurnMessage[],
  taintedTurns: ReadonlySet<string>,
  mode: ApprovalMode,
): Map<string, string> {
  const reasons = new Map(asks);
  if (mode !== "auto" || taintedTurns.size === 0) return reasons;
  for (const proposal of proposals) {
    if (proposal.status !== "proposed" || reasons.has(proposal.id)) continue;
    const turn = turnStartFor([...messages], proposal.createdAt);
    if (turn && taintedTurns.has(turn)) reasons.set(proposal.id, TAINTED_ASK_REASON);
  }
  return reasons;
}
