"use client";

import { useId } from "react";
import type { CalendarResult, DriveFileKind, DriveResult } from "@/types/workflows";
import { ExternalLink } from "./ExternalLink";
import { DRIVE_KIND_LABELS, driveReadLine, eventTimeText, googleLink, modifiedText } from "./format";

/** Events read from the user's Google Calendar for this reply (decision 0016). */
export function CalendarResults({ result }: { result: CalendarResult }) {
  const titleId = useId();
  const events = result.events ?? [];

  return (
    <section className="result-card result-calendar" aria-labelledby={titleId}>
      <p id={titleId} className="result-title">
        From your Google Calendar
      </p>
      {events.length === 0 ? (
        <p className="result-empty">No events in this window.</p>
      ) : (
        <ul className="row-list">
          {events.map((event, index) => {
            const link = googleLink(event.link, "calendar");
            const title = event.title.trim() || "Untitled event";
            return (
              <li key={`${event.start}-${index}`} className="account-row event-row">
                <span className="event-time">{eventTimeText(event)}</span>
                <span className="account-row-main">
                  <span className="account-row-title">{title}</span>
                  <span className="hint">
                    {event.calendar}
                    {event.location ? ` · ${event.location}` : ""}
                  </span>
                </span>
                {event.fromOthers && <span className="result-chip">Invitation</span>}
                {link && (
                  <ExternalLink href={link} className="account-row-link" label={`Open ${title} in Google Calendar`}>
                    Open
                  </ExternalLink>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function FileIcon({ kind }: { kind: DriveFileKind }) {
  return (
    <svg className={`file-icon file-icon-${kind}`} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6z" />
      {kind === "sheet" ? (
        <path d="M9 11h6M9 14h6M9 17h6M12 11v6" />
      ) : kind === "slides" ? (
        <path d="M9 11h6v5H9z" />
      ) : (
        <path d="M9 12h6M9 15h6M9 18h4" />
      )}
    </svg>
  );
}

/** Files found in, or read from, the user's Google Drive for this reply (decision 0016). */
export function DriveResults({ result }: { result: DriveResult }) {
  const titleId = useId();
  const files = result.files ?? [];

  return (
    <section className="result-card result-drive" aria-labelledby={titleId}>
      <p id={titleId} className="result-title">
        From your Google Drive
      </p>
      {result.read && <p className="result-kicker">{driveReadLine(result.read)}</p>}
      {files.length > 0 && (
        <ul className="row-list">
          {files.map((file) => {
            const link = googleLink(file.link, "drive");
            const name = file.name.trim() || "Untitled file";
            const modified = modifiedText(file.modified);
            return (
              <li key={file.id} className="account-row file-row">
                <FileIcon kind={file.kind} />
                <span className="account-row-main">
                  <span className="account-row-title">{name}</span>
                  <span className="hint">
                    {DRIVE_KIND_LABELS[file.kind] ?? DRIVE_KIND_LABELS.other}
                    {modified ? ` · ${modified}` : ""}
                  </span>
                </span>
                {link && (
                  <ExternalLink href={link} className="account-row-link" label={`Open ${name} in Google Drive`}>
                    Open
                  </ExternalLink>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {files.length === 0 && !result.read && <p className="result-empty">No match for these words in Drive.</p>}
    </section>
  );
}
