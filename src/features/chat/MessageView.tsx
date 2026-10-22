import { markCappedReads } from "@/features/results/format";
import { ResultList } from "@/features/results/ResultList";
import { routeSummary } from "@/lib/routing";
import { toSafeHttpUrl } from "@/lib/safe-url";
import type { MessageDTO, SourceRef, WebSearchStatus } from "@/types/api";
import { RunPanel } from "./RunPanel";
import type { LiveRun } from "./run";
import { WhatWasSent } from "./WhatWasSent";

export interface UiMessage extends MessageDTO {
  /** Shown optimistically before the server confirms it was saved. */
  pending?: boolean;
  truncated?: boolean;
  /**
   * Only for a reply streamed on this page: its steps with the model's plan
   * lines, how long it took, and whether the user opened or closed its panel.
   * A reload shows the saved steps instead.
   */
  run?: LiveRun;
}

const SEARCH_NOTICES: Partial<Record<WebSearchStatus, string>> = {
  failed: "Web search failed, so this answer uses no web sources.",
  no_results: "Web search found nothing usable, so this answer uses no web sources.",
};

export function SearchNotice({ status, message }: { status: WebSearchStatus; message?: string }) {
  const text = message ?? SEARCH_NOTICES[status];
  if (!text || status === "used" || status === "off") return null;
  return <p className="alert alert-warning small">{text}</p>;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function SourceList({ sources }: { sources: SourceRef[] }) {
  const safe = sources.flatMap((source) => {
    const url = toSafeHttpUrl(source.url);
    return url ? [{ title: source.title, url }] : [];
  });
  if (safe.length === 0) return null;

  return (
    <aside className="sources" aria-label="Web sources">
      <p className="sources-title">Web sources</p>
      <p className="hint">Sources given to P-Dot as context; the answer is its own reading of them.</p>
      <ol>
        {safe.map((source) => (
          <li key={source.url}>
            <a href={source.url} target="_blank" rel="noopener noreferrer nofollow">
              {source.title}
            </a>{" "}
            <span className="hint">{hostname(source.url)}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

export function MessageItem({
  message,
  onSend,
  busy = false,
}: {
  message: UiMessage;
  /** Sends a new message, for a result card's Re-check button. */
  onSend?: (text: string) => void;
  /** A reply is streaming. */
  busy?: boolean;
}) {
  const isUser = message.role === "user";
  const steps = message.run?.steps ?? message.results?.steps ?? [];
  // A Drive read cut by the server's byte cap says "more than" its length.
  const results = markCappedReads(message.results?.results ?? [], steps);
  // What was sent reads Google use only from the saved payload; without one there is no record.
  // A payload the server trimmed to fit says so, so its counts are not shown as exact.
  const sent = message.results
    ? { results, steps: message.results.steps ?? [], trimmed: message.results.trimmed === true }
    : undefined;
  return (
    <article className={`message ${isUser ? "message-user" : "message-assistant"}`} data-message-id={message.id}>
      <p className="message-author">{isUser ? "You" : "P-Dot"}</p>
      {!isUser && (
        <RunPanel
          steps={steps}
          results={results}
          streaming={false}
          elapsedMs={message.run?.elapsedMs}
          initialOpen={message.run?.open ?? false}
        />
      )}
      {!isUser && <ResultList results={results} onRecheck={onSend} busy={busy} />}
      {!isUser && <SearchNotice status={message.webSearch} />}
      {/* Rendered as text, never as HTML. */}
      <div className="message-content">{message.content}</div>
      {message.pending && <p className="hint">Sending…</p>}
      {message.truncated && (
        <p className="hint">
          Reply cut at the length limit; send <strong>&quot;continue&quot;</strong> to resume.
        </p>
      )}
      {!isUser && message.webSearch === "used" && <SourceList sources={message.sources} />}
      {!isUser && (
        <div className="message-footer">
          {message.route && (
            <p className="message-route" title={`Model tier: ${message.route.tier}`}>
              {routeSummary(message.route)}
            </p>
          )}
          <WhatWasSent messageId={message.id} createdAt={message.createdAt} payload={sent} />
        </div>
      )}
    </article>
  );
}
