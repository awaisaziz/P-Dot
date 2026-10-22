"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ApprovalModeMenu, ApprovalModeSetup } from "@/features/actions/ApprovalModePicker";
import { useApprovalMode } from "@/features/actions/approval-mode";
import { notifyActionsChanged } from "@/features/actions/events";
import { useAutoApprovals } from "@/features/actions/useAutoApprovals";
import { useProposals } from "@/features/actions/useProposals";
import { summarizeConversation } from "@/features/memory/api";
import { useMemorySuggestions, type MemorySuggestion } from "@/features/memory/useMemorySuggestions";
import { markCappedReads } from "@/features/results/format";
import { ResultList } from "@/features/results/ResultList";
import { MAX_MESSAGE_CHARS } from "@/lib/limits";
import type { ActionProposalDTO, ConversationSummary, Effort, ModelTier, SourceRef, WebSearchStatus } from "@/types/api";
import type { ConnectorsResponse } from "@/types/connectors";
import type { MessageResult } from "@/types/workflows";
import {
  ApiError,
  deleteConversation,
  fetchConversation,
  fetchConversations,
  postChat,
  renameConversation,
} from "./api";
import { fetchConnectorsOnce, googleLinkState, setGoogleChip, useGoogleChip } from "./connectors";
import { GoogleToolOption } from "./GoogleToolOption";
import { autoTurnsAfterDone, readsOutside, withTaintedReasons, withTaintedTurn, withoutTurn } from "./auto-turns";
import { MessageItem, SearchNotice, SourceList, type UiMessage } from "./MessageView";
import { RunPanel } from "./RunPanel";
import { TurnExtras } from "./TurnExtras";
import { effortAfterAccept } from "./effort";
import { placeBySource, placeByTime } from "./placement";
import { buildChatRequest, requestTimeZone } from "./request";
import { finishedReply, liveReplyParts, planStep, runPanelVisible, upsertStep, type RunSteps } from "./run";
import { STARTERS_HINT, chatStarters } from "./starters";
import { readChatStream } from "./stream";
import { appendDictation, useDictation } from "./useDictation";

/** Steps and results of a reply whose written answer failed or was stopped. Shown, not saved. */
interface KeptRun {
  steps: RunSteps;
  results: MessageResult[];
  runKey: number;
}

interface StreamingReply {
  text: string;
  search: { status: Exclude<WebSearchStatus, "off">; sources: SourceRef[]; message?: string } | null;
  /** The tier from the start event, before the first token. */
  tier?: ModelTier;
  /** Step lines by id, in arrival order; the model's plan lines are among them. */
  steps: RunSteps;
  results: MessageResult[];
  /** Changes per request, so each reply gets a fresh run panel. */
  runKey: number;
}

const EFFORT_OPTIONS: { value: Effort; label: string; title: string }[] = [
  { value: "auto", label: "Auto", title: "P-Dot chooses a model for each message." },
  {
    value: "deep",
    label: "Think harder",
    title: "Strongest model for the next message only; slower and uses more of your daily limit.",
  },
];

interface ErrorState {
  message: string;
}

function syncUrl(conversationId: string | null) {
  window.history.replaceState(null, "", conversationId ? `/chat?c=${encodeURIComponent(conversationId)}` : "/chat");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Where keyboard focus is inside the live reply, so the saved reply can take it back. Null when it is elsewhere. */
function focusInside(container: HTMLElement | null): { key: string | null; inSteps: boolean } | null {
  const active = typeof document === "undefined" ? null : document.activeElement;
  if (!container || !(active instanceof HTMLElement) || !container.contains(active)) return null;
  return { key: active.dataset.focusKey ?? null, inSteps: active.closest(".run-steps") !== null };
}

/** The same control in the saved reply, else its run header, else the reply itself. */
function focusSavedReply(list: HTMLElement | null, messageId: string, key: string | null) {
  const article = list?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!article) return;
  const visible = (element: HTMLElement | null) => (element && !element.closest("[hidden]") ? element : null);
  const target =
    visible(key ? article.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`) : null) ??
    visible(article.querySelector<HTMLElement>(".run-header"));
  if (target) {
    target.focus();
    return;
  }
  article.tabIndex = -1;
  article.focus();
}

export function ChatWorkspace({
  initialConversationId,
  initialDraft = null,
}: {
  initialConversationId: string | null;
  /** From `?q=` (a starter on Today): placed in the message box once, never sent on its own. */
  initialDraft?: string | null;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [activeId, setActiveId] = useState<string | null>(initialConversationId);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(initialConversationId !== null);
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [webSearch, setWebSearch] = useState(false);
  const [effort, setEffort] = useState<Effort>("auto");
  // Counts the user's clicks on the effort switch, so a late "start" event cannot undo a newer choice.
  const effortVersion = useRef(0);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState<StreamingReply | null>(null);
  // What a failed or stopped reply had already found, so a paid check does not vanish with the error.
  const [keptRun, setKeptRun] = useState<KeptRun | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [status, setStatus] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  // Bumped after each reply so P-Dot's suggestions reload; a reply may come with new proposals or memories.
  const [suggestionsKey, setSuggestionsKey] = useState(0);
  // "Ask first" or "Auto". Auto acts only on replies to messages sent while it was on (their user message IDs).
  const approvalMode = useApprovalMode();
  const [autoTurns, setAutoTurns] = useState<ReadonlySet<string>>(() => new Set());
  // Turns whose reply read web pages or Google: Auto runs nothing for them (decision 0015).
  // The ref is the latest set, for a reply that ends after a Retry of the same turn.
  const [taintedTurns, setTaintedTurns] = useState<ReadonlySet<string>>(() => new Set());
  const taintedRef = useRef<ReadonlySet<string>>(taintedTurns);
  // The user's open or close of the live run panel, kept for the saved reply. Null: not touched.
  const liveRunChoice = useRef<boolean | null>(null);
  // The live reply, and the saved reply that should take its keyboard focus when it lands.
  const liveReplyRef = useRef<HTMLElement>(null);
  const focusAfterDone = useRef<{ messageId: string; key: string | null } | null>(null);
  // Google: the connection from GET /api/connectors, and the chip's choice on this device.
  const [connectors, setConnectors] = useState<ConnectorsResponse | "loading" | "error">("loading");
  const googleChip = useGoogleChip();
  const google = googleLinkState(connectors);
  const googleOn = googleChip && google.state === "connected";

  const dictation = useDictation(
    useCallback((text: string) => setDraft((current) => appendDictation(current, text, MAX_MESSAGE_CHARS)), []),
  );

  const router = useRouter();
  const abortRef = useRef<AbortController | null>(null);
  // The messages shown, for the summary trigger (read in event handlers, never in the render).
  const messagesRef = useRef<UiMessage[]>([]);
  const loadSeq = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const redirectIfUnauthorized = useCallback(
    (error: unknown): boolean => {
      if (error instanceof ApiError && error.status === 401) {
        router.replace("/login?next=/chat");
        return true;
      }
      return false;
    },
    [router],
  );
  const goToLogin = useCallback(() => router.replace("/login?next=/chat"), [router]);

  // P-Dot's suggestions (actions to approve, memories to keep), shown under the reply they came from.
  const suggestionsRefresh = `${activeId ?? ""}:${suggestionsKey}`;
  const actions = useProposals({ refreshKey: suggestionsRefresh, enabled: activeId !== null, onUnauthorized: goToLogin });
  const memorySuggestions = useMemorySuggestions({
    refreshKey: suggestionsRefresh,
    enabled: activeId !== null,
    onUnauthorized: goToLogin,
  });

  const loadMessages = useCallback(
    (id: string) => {
      const seq = ++loadSeq.current;
      return fetchConversation(id).then(
        (detail) => {
          if (seq !== loadSeq.current) return;
          setMessages(detail.messages);
          setLoadingMessages(false);
        },
        (err: unknown) => {
          if (seq !== loadSeq.current || redirectIfUnauthorized(err)) return;
          setLoadingMessages(false);
          if (err instanceof ApiError && err.status === 404) {
            setActiveId(null);
            syncUrl(null);
            setError({ message: "That conversation was not found; it may have been deleted." });
          } else {
            setError({ message: err instanceof Error ? err.message : "Could not load the conversation." });
          }
        },
      );
    },
    [redirectIfUnauthorized],
  );

  useEffect(() => {
    let cancelled = false;
    fetchConversations()
      .then((list) => {
        if (cancelled) return;
        setConversations(list);
        setListState("ready");
      })
      .catch((err: unknown) => {
        if (!cancelled && !redirectIfUnauthorized(err)) setListState("error");
      });
    if (initialConversationId) void loadMessages(initialConversationId);
    return () => {
      cancelled = true;
    };
  }, [initialConversationId, loadMessages, redirectIfUnauthorized]);

  // Whether Google is connected, once per page load. A failure leaves the Google row disabled.
  useEffect(() => {
    let cancelled = false;
    fetchConnectorsOnce().then(
      (response) => {
        if (!cancelled) setConnectors(response);
      },
      () => {
        if (!cancelled) setConnectors("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // A draft from `?q=` is placed once: the URL drops it, so a reload or Back does not bring it again.
  useEffect(() => {
    if (initialDraft === null) return;
    syncUrl(initialConversationId);
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [initialDraft, initialConversationId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming]);

  useEffect(() => {
    messagesRef.current = messages;
    // The live reply was replaced by the saved one: give focus back where the user had it.
    const pending = focusAfterDone.current;
    if (pending) {
      focusAfterDone.current = null;
      focusSavedReply(listRef.current, pending.messageId, pending.key);
    }
  }, [messages]);

  /**
   * Suggests lasting facts from a conversation as "Remember this?" cards
   * (decision 0009). Best effort and in the background: when the user leaves
   * a conversation with an exchange in it, and every few replies.
   */
  function suggestMemoriesFrom(conversationId: string | null, count: number) {
    if (!conversationId || count < 2) return;
    void summarizeConversation(conversationId).catch(() => {});
  }

  function openConversation(id: string) {
    if (activeId && activeId !== id) suggestMemoriesFrom(activeId, messagesRef.current.length);
    abortRef.current?.abort();
    // Words still being dictated belong to the conversation the user is leaving.
    dictation.cancel();
    setActiveId(id);
    setMessages([]);
    setError(null);
    setKeptRun(null);
    setConfirmDeleteId(null);
    setShowList(false);
    setLoadingMessages(true);
    syncUrl(id);
    void loadMessages(id);
  }

  /** Records a tainted turn: Auto never runs its proposals, from this attempt or a Retry of it. */
  function markTainted(turn: string | null, readOutside: boolean) {
    const next = withTaintedTurn(taintedRef.current, turn, readOutside);
    if (next === taintedRef.current || !turn) return;
    taintedRef.current = next;
    setTaintedTurns(next);
    setAutoTurns((turns) => withoutTurn(turns, turn));
  }

  function startNewConversation() {
    suggestMemoriesFrom(activeId, messagesRef.current.length);
    abortRef.current?.abort();
    dictation.cancel();
    loadSeq.current += 1;
    setActiveId(null);
    setMessages([]);
    setError(null);
    setKeptRun(null);
    setLoadingMessages(false);
    setShowList(false);
    syncUrl(null);
    inputRef.current?.focus();
  }

  /**
   * Sends the draft, retries the last message, or (with `override`) sends a
   * message from a button such as Re-check without touching the draft.
   */
  async function submit(action: "send" | "retry", override?: string) {
    if (sending) return;
    const fromDraft = override === undefined;
    const text = (override ?? draft).trim();
    if (action === "send" && (!text || text.length > MAX_MESSAGE_CHARS)) return;
    const body = buildChatRequest({
      action,
      message: text,
      conversationId: activeId,
      webSearch,
      effort,
      timeZone: requestTimeZone(),
      google: googleOn,
    });
    if (!body) return;

    const sentEffort = { effort, version: effortVersion.current };
    // The mode when the user pressed Send decides whether Auto may act on this reply.
    const sentInAuto = approvalMode === "auto";
    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = Date.now();
    const tempId = `pending-${startedAt}`;
    let accepted = false;
    let finished = false;
    let conversationId = activeId;
    let userMessageId: string | null = null;
    // Kept here as well as in state, so `done` can save them without reading state.
    let liveSteps: RunSteps = new Map();
    let liveResults: MessageResult[] = [];
    let plans = 0;
    const announced = new Set<string>();
    setKeptRun(null);
    /** Keeps what the reply found when its written answer fails or is stopped. */
    const keepRun = () => {
      if (runPanelVisible([...liveSteps.values()], liveResults, false)) {
        setKeptRun({ steps: liveSteps, results: liveResults, runKey: startedAt });
      }
    };
    // Set by the first workflow or Google read, so a reply that ends without `done` still taints its turn.
    let readOutside = false;
    liveRunChoice.current = null;

    const restoreDraft = () => {
      if (action !== "send") return;
      setMessages((current) => current.filter((message) => message.id !== tempId));
      if (fromDraft) setDraft((current) => (current ? current : text));
    };
    const showRun = () =>
      setStreaming((current) => (current ? { ...current, steps: liveSteps, results: liveResults } : current));
    // The live reply is about to go with an error: keep focus in the message box.
    const keepFocusOnError = () => {
      if (focusInside(liveReplyRef.current)) inputRef.current?.focus();
    };

    setSending(true);
    setError(null);
    setStreaming({ text: "", search: null, steps: liveSteps, results: liveResults, runKey: startedAt });
    setStatus("Sending…");
    if (action === "send") {
      if (fromDraft) {
        // Stop dictating, so words heard after Send do not land in the next message.
        dictation.cancel();
        setDraft("");
      }
      setMessages((current) => [
        ...current,
        {
          id: tempId,
          role: "user",
          content: text,
          webSearch: "off",
          sources: [],
          route: null,
          createdAt: new Date(startedAt).toISOString(),
          pending: true,
        },
      ]);
    }

    try {
      const stream = await postChat(body, controller.signal);
      for await (const event of readChatStream(stream)) {
        if (readsOutside(event)) readOutside = true;
        switch (event.type) {
          case "start":
            accepted = true;
            conversationId = event.conversation.id;
            userMessageId = event.userMessage.id;
            // "Think harder" applies to one message, so a forgotten switch does not keep using the heavy tier.
            setEffort((current) => effortAfterAccept(sentEffort, { effort: current, version: effortVersion.current }));
            setActiveId(event.conversation.id);
            syncUrl(event.conversation.id);
            setConversations((list) => [event.conversation, ...list.filter((c) => c.id !== event.conversation.id)]);
            if (action === "send") {
              setMessages((current) => current.map((m) => (m.id === tempId ? event.userMessage : m)));
            }
            setStreaming((current) => (current ? { ...current, tier: event.route.tier } : current));
            setStatus(webSearch ? "Searching the web…" : "P-Dot is replying…");
            break;
          case "search":
            setStreaming((current) =>
              current
                ? { ...current, search: { status: event.status, sources: event.sources, message: event.message } }
                : current,
            );
            setStatus(event.status === "used" ? "Web search done, replying…" : (event.message ?? ""));
            break;
          case "delta":
            setStreaming((current) => (current ? { ...current, text: current.text + event.text } : current));
            break;
          case "thought": {
            // What P-Dot said before using a tool was its plan, not the reply: it becomes a step line.
            const plan = planStep(plans++, event.text);
            if (plan) liveSteps = upsertStep(liveSteps, plan);
            setStreaming((current) => (current ? { ...current, text: "", steps: liveSteps } : current));
            setStatus(event.text);
            break;
          }
          case "step":
            liveSteps = upsertStep(liveSteps, event.step);
            showRun();
            // One announcement per step, never per update.
            if (!announced.has(event.step.id)) {
              announced.add(event.step.id);
              setStatus(event.step.label);
            }
            break;
          case "result":
            liveResults = [...liveResults, event.result];
            showRun();
            break;
          case "title":
            setConversations((list) => list.map((c) => (c.id === conversationId ? { ...c, title: event.title } : c)));
            break;
          case "done": {
            finished = true;
            const count = messagesRef.current.length + 1;
            const focus = focusInside(liveReplyRef.current);
            const message: UiMessage = {
              ...event.message,
              truncated: event.truncated,
              ...finishedReply(event.message.results, {
                steps: liveSteps,
                results: liveResults,
                elapsedMs: Date.now() - startedAt,
                // A step the user had focused stays visible.
                open: liveRunChoice.current ?? (focus?.inSteps ? true : null),
              }),
            };
            if (focus) focusAfterDone.current = { messageId: message.id, key: focus.key };
            setMessages((current) => [...current, message]);
            if (userMessageId) {
              const turn = userMessageId;
              // A reply that read web pages or Google is tainted: Auto never runs its proposals.
              const autoAllowed = event.autoActions !== false;
              markTainted(turn, !autoAllowed);
              // An earlier attempt at this turn (failed or stopped, then retried) may be tainted too.
              const tainted = taintedRef.current;
              setAutoTurns((turns) => autoTurnsAfterDone(turns, turn, { sentInAuto, autoAllowed, tainted }));
            }
            setStreaming(null);
            setSuggestionsKey((key) => key + 1);
            notifyActionsChanged();
            setStatus("Reply complete.");
            // Every sixth message, suggest what is worth remembering so far.
            if (count >= 6 && count % 6 === 0) suggestMemoriesFrom(conversationId, count);
            break;
          }
          case "error":
            finished = true;
            // Proposals made before the failure stay; a Retry must not let Auto run them.
            markTainted(userMessageId, readOutside);
            keepFocusOnError();
            keepRun();
            setStreaming(null);
            setError({ message: event.message });
            setStatus("");
            break;
        }
      }
      if (!finished) {
        markTainted(userMessageId, readOutside);
        keepFocusOnError();
        keepRun();
        setStreaming(null);
        setError({ message: "The reply was interrupted; please retry." });
      }
    } catch (err) {
      // Stopped or cut off: the same rule as an error event.
      if (!finished) markTainted(userMessageId, readOutside);
      keepFocusOnError();
      if (!finished) keepRun();
      setStreaming(null);
      if (isAbort(err)) {
        if (!accepted) restoreDraft();
        setStatus("Stopped.");
      } else if (!redirectIfUnauthorized(err)) {
        if (!accepted) restoreDraft();
        setError({ message: err instanceof Error ? err.message : "Something went wrong; please retry." });
        setStatus("");
      }
    } finally {
      setSending(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  /** A starter suggestion fills the message box; the user sends it. */
  function fillDraft(text: string) {
    setDraft(text);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(text.length, text.length);
    });
  }

  const sendText = (text: string) => void submit("send", text);

  function startRename(conversation: ConversationSummary) {
    setConfirmDeleteId(null);
    setRenamingId(conversation.id);
    setRenameValue(conversation.title);
  }

  async function saveRename(id: string) {
    const title = renameValue.trim();
    if (!title || savingRename) return;
    setSavingRename(true);
    try {
      const renamed = await renameConversation(id, title);
      setConversations((list) => list.map((c) => (c.id === id ? { ...c, title: renamed.title } : c)));
      setRenamingId(null);
      setStatus("Conversation renamed.");
    } catch (err) {
      if (redirectIfUnauthorized(err)) return;
      setError({ message: err instanceof Error ? err.message : "Could not rename the conversation." });
    } finally {
      setSavingRename(false);
    }
  }

  async function confirmDelete(id: string) {
    setDeletingId(id);
    try {
      await deleteConversation(id);
    } catch (err) {
      if (redirectIfUnauthorized(err)) return;
      // 404 means it is already gone; anything else is a real failure.
      if (!(err instanceof ApiError && err.status === 404)) {
        setError({ message: "Could not delete the conversation; please retry." });
        setDeletingId(null);
        return;
      }
    }
    setConversations((list) => list.filter((c) => c.id !== id));
    if (activeId === id) startNewConversation();
    setConfirmDeleteId(null);
    setDeletingId(null);
    setStatus("Conversation deleted.");
  }

  const last = messages.at(-1);
  const canRetry = !sending && !loadingMessages && activeId !== null && last?.role === "user" && !last.pending;
  const activeTitle = conversations.find((c) => c.id === activeId)?.title;

  // Oldest first, so a reply's suggestions read in the order P-Dot made them.
  const conversationProposals = activeId
    ? actions.proposals
        .filter((p) => p.conversationId === activeId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    : [];
  // In Auto, safe actions from replies to messages sent in Auto are approved through the normal decision route.
  const auto = useAutoApprovals({
    mode: approvalMode,
    messages,
    proposals: conversationProposals,
    autoTurns,
    onDecided: actions.decided,
    onStale: actions.stale,
    onUnauthorized: goToLogin,
  });
  const autoRunning = new Set(auto.running.map((p) => p.id));
  // In Auto, a waiting proposal from a tainted reply says why it still asks.
  const askReasons = withTaintedReasons(auto.asks, conversationProposals, messages, taintedTurns, approvalMode);
  const streamingSteps = streaming ? [...streaming.steps.values()] : [];
  const streamingResults = streaming ? markCappedReads(streaming.results, streamingSteps) : [];
  // The first step (a flight check can come before any text) opens the panel and replaces "Thinking…".
  const live = liveReplyParts({ text: streaming?.text ?? "", steps: streamingSteps, results: streamingResults });
  const placedProposals = placeByTime(messages, conversationProposals);
  const placedSuggestions = placeBySource(messages, memorySuggestions.items);
  const showSuggestions = activeId !== null && !loadingMessages;
  const suggestionsFor = (proposals?: ActionProposalDTO[], suggestions?: MemorySuggestion[]) =>
    showSuggestions && (
      <TurnExtras
        proposals={proposals}
        suggestions={suggestions}
        approvalMode={approvalMode}
        autoRunning={autoRunning}
        autoRan={auto.ran}
        askReasons={askReasons}
        decidedHere={actions.decidedHere}
        onDecided={actions.decided}
        onStale={actions.stale}
        onKept={memorySuggestions.kept}
        onDropped={memorySuggestions.dropped}
        onUnauthorized={goToLogin}
      />
    );

  return (
    <div className="chat-layout">
      <aside className={`chat-sidebar${showList ? " is-open" : ""}`} aria-label="Conversations">
        <button type="button" className="button button-primary" onClick={startNewConversation}>
          New conversation
        </button>
        {listState === "loading" && <p className="muted small">Loading conversations…</p>}
        {listState === "error" && (
          <p className="alert alert-error small" role="alert">
            Could not load your conversations.
          </p>
        )}
        {listState === "ready" && conversations.length === 0 && (
          <p className="muted small">No conversations yet.</p>
        )}
        <ul className="conversation-list">
          {conversations.map((conversation) => (
            <li key={conversation.id} className={conversation.id === activeId ? "is-active" : undefined}>
              {renamingId === conversation.id ? (
                <form
                  className="rename-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveRename(conversation.id);
                  }}
                >
                  <label htmlFor={`rename-${conversation.id}`} className="visually-hidden">
                    Conversation name
                  </label>
                  <input
                    id={`rename-${conversation.id}`}
                    type="text"
                    value={renameValue}
                    maxLength={120}
                    autoFocus
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => event.key === "Escape" && setRenamingId(null)}
                  />
                  <button
                    type="submit"
                    className="icon-button"
                    aria-label="Save name"
                    disabled={savingRename || !renameValue.trim()}
                  >
                    ✓
                  </button>
                  <button type="button" className="icon-button" aria-label="Cancel rename" onClick={() => setRenamingId(null)}>
                    ×
                  </button>
                </form>
              ) : confirmDeleteId === conversation.id ? (
                <div className="confirm-delete" role="group" aria-label={`Delete “${conversation.title}”?`}>
                  <span className="small">Delete this conversation permanently?</span>
                  <div className="actions">
                    <button
                      type="button"
                      className="button button-danger button-small"
                      onClick={() => void confirmDelete(conversation.id)}
                      disabled={deletingId === conversation.id}
                    >
                      {deletingId === conversation.id ? "Deleting…" : "Delete"}
                    </button>
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => setConfirmDeleteId(null)}
                      disabled={deletingId === conversation.id}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="conversation-link"
                    onClick={() => openConversation(conversation.id)}
                    aria-current={conversation.id === activeId ? "true" : undefined}
                  >
                    {conversation.title}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => startRename(conversation)}
                    aria-label={`Rename “${conversation.title}”`}
                    title="Rename conversation"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="icon-button icon-button-danger"
                    onClick={() => {
                      setRenamingId(null);
                      setConfirmDeleteId(conversation.id);
                    }}
                    aria-label={`Delete “${conversation.title}”`}
                    title="Delete conversation"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                    </svg>
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </aside>

      <main className="chat-main">
        <div className="chat-toolbar">
          <button
            type="button"
            className="button button-small mobile-only"
            aria-expanded={showList}
            onClick={() => setShowList((open) => !open)}
          >
            Conversations
          </button>
          <h1 className="chat-title">{activeTitle ?? (activeId ? "Conversation" : "New conversation")}</h1>
        </div>

        <div className="message-list" ref={listRef}>
          {loadingMessages && <p className="muted">Loading conversation…</p>}
          {!loadingMessages && messages.length === 0 && !streaming && (
            <div className="empty-state">
              <span className="empty-mark" aria-hidden="true" />
              <ul className="chat-starter-list" aria-label="Starter suggestions">
                {chatStarters(google, googleChip).map((starter) => (
                  <li key={starter}>
                    <button type="button" className="chat-starter" onClick={() => fillDraft(starter)}>
                      {starter}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="muted small">{STARTERS_HINT}</p>
            </div>
          )}
          {messages.map((message) => (
            <Fragment key={message.id}>
              <MessageItem message={message} onSend={sendText} busy={sending} />
              {suggestionsFor(placedProposals.byMessage.get(message.id), placedSuggestions.get(message.id))}
            </Fragment>
          ))}
          {keptRun && !streaming && (
            <article className="message message-assistant">
              <p className="message-author">P-Dot</p>
              <RunPanel
                key={keptRun.runKey}
                steps={[...keptRun.steps.values()]}
                results={keptRun.results}
                streaming={false}
                initialOpen
              />
              <ResultList results={markCappedReads(keptRun.results, [...keptRun.steps.values()])} />
              <p className="hint">The written answer did not finish; these steps and results were not saved.</p>
            </article>
          )}
          {streaming && (
            <article className="message message-assistant" aria-busy="true" ref={liveReplyRef}>
              <p className="message-author">P-Dot</p>
              <RunPanel
                key={streaming.runKey}
                steps={streamingSteps}
                results={streamingResults}
                streaming
                initialOpen
                onToggle={(open) => {
                  liveRunChoice.current = open;
                }}
              />
              <ResultList results={streamingResults} busy />
              {streaming.search && <SearchNotice status={streaming.search.status} message={streaming.search.message} />}
              {(streaming.text || live.thinking) && (
                <div className="message-content">
                  {streaming.text || (
                    <span className="muted thinking">
                      {webSearch && !streaming.search
                        ? "Searching the web…"
                        : streaming.tier === "heavy"
                          ? "Thinking harder…"
                          : "Thinking…"}
                    </span>
                  )}
                </div>
              )}
              {streaming.search?.status === "used" && <SourceList sources={streaming.search.sources} />}
            </article>
          )}
          {suggestionsFor(placedProposals.rest)}
          <div ref={endRef} />
        </div>

        {error && (
          <div className="alert alert-error chat-error" role="alert">
            <span>{error.message}</span>
          </div>
        )}
        {canRetry && (
          <div className="retry-bar">
            <span className="small muted">This message has no reply yet.</span>
            <button type="button" className="button button-small" onClick={() => void submit("retry")}>
              Retry reply
            </button>
          </div>
        )}

        {/* Once per device: choose Ask first or Auto. Outside the form, so Enter on an option cannot send. */}
        <ApprovalModeSetup />

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit("send");
          }}
        >
          <div className="composer-box">
            <label htmlFor="composer-input" className="visually-hidden">
              Message
            </label>
            <textarea
              id="composer-input"
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit("send");
                } else if (event.key === "Escape" && dictation.listening) {
                  dictation.toggle();
                }
              }}
              rows={2}
              maxLength={MAX_MESSAGE_CHARS}
              placeholder="Ask P-Dot anything…"
              aria-describedby="composer-hint"
            />
            {dictation.listening && (
              <p className="dictation-live">
                <span role="status">Listening… tap the microphone or press Esc to stop.</span>
                {/* Not announced: it changes with every word. The settled words go into the message box. */}
                {dictation.interim && <span className="dictation-interim">“{dictation.interim}”</span>}
              </p>
            )}
            <div className="composer-bar">
              <div className="tools-anchor composer-tools-anchor">
                {toolsOpen && (
                  <div
                    id="composer-tools"
                    className="tools-menu"
                    onKeyDown={(event) => event.key === "Escape" && setToolsOpen(false)}
                  >
                    <label className="tool-option">
                      <input type="checkbox" checked={webSearch} onChange={(event) => setWebSearch(event.target.checked)} />
                      <span>
                        <strong>Search the web</strong>
                        <span className="hint">Powered by Tavily</span>
                      </span>
                    </label>
                    <GoogleToolOption link={google} on={googleChip} />
                  </div>
                )}
                <button
                  type="button"
                  className="round-button"
                  aria-label="Add tools"
                  aria-expanded={toolsOpen}
                  aria-controls="composer-tools"
                  onClick={() => setToolsOpen((open) => !open)}
                >
                  +
                </button>
              </div>
              <div role="group" aria-label="Effort" className="mode-toggle effort-toggle">
                {EFFORT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="mode-option"
                    aria-pressed={effort === option.value}
                    title={option.title}
                    onClick={() => {
                      effortVersion.current += 1;
                      setEffort(option.value);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {(webSearch || googleOn) && (
                <span className="composer-chips">
                  {webSearch && (
                    <button
                      type="button"
                      className="chip chip-button composer-chip"
                      onClick={() => setWebSearch(false)}
                      aria-label="Turn off web search (Tavily)"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
                      </svg>
                      Web search <span aria-hidden="true">×</span>
                    </button>
                  )}
                  {googleOn && (
                    <button
                      type="button"
                      className="chip chip-button composer-chip chip-google"
                      onClick={() => setGoogleChip(false)}
                      aria-label="Turn off Google (Calendar and Drive)"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="4" y="5" width="16" height="15" rx="2" />
                        <path d="M4 10h16M9 3v4M15 3v4" />
                      </svg>
                      Google <span aria-hidden="true">×</span>
                    </button>
                  )}
                </span>
              )}
              <span id="composer-hint" className="hint composer-hint">
                {draft.length > MAX_MESSAGE_CHARS * 0.9
                  ? `${draft.length} / ${MAX_MESSAGE_CHARS} characters`
                  : "Enter to send · Shift+Enter for a new line"}
              </span>
              {/* Kept apart from the effort switch, whose "Auto" is about models, not approvals. */}
              <ApprovalModeMenu />
              <button
                type="button"
                className={`round-button${dictation.listening ? " is-listening" : ""}`}
                aria-label={dictation.listening ? "Stop dictating" : "Dictate a message (speech to English text)"}
                aria-pressed={dictation.listening}
                title={
                  dictation.supported
                    ? "Speak and P-Dot writes it as English text"
                    : "Dictation is not supported in this browser"
                }
                disabled={!dictation.supported}
                onClick={dictation.toggle}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="12" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                </svg>
              </button>
              {sending ? (
                <button type="button" className="round-button round-button-solid" aria-label="Stop" onClick={() => abortRef.current?.abort()}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button type="submit" className="round-button round-button-solid" aria-label="Send message" disabled={!draft.trim()}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          {dictation.error && (
            <p className="alert alert-warning small" role="alert">
              {dictation.error}
            </p>
          )}
          {approvalMode === "auto" && (
            <p className="approval-mode-hint small">
              <strong>Auto is on:</strong> tasks and reminders are added with Undo; everything else still asks.{" "}
              <Link href="/settings#approvals">What always asks</Link>
            </p>
          )}
          <p className="disclaimer">P-Dot can make mistakes; double-check anything important.</p>
        </form>

        <p className="visually-hidden" role="status" aria-live="polite">
          {status}
        </p>
      </main>
    </div>
  );
}
