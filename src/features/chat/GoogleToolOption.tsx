"use client";

import Link from "next/link";
import { GOOGLE_ROW_HINTS, googleToggleHint, setGoogleChip, type GoogleLinkState } from "./connectors";

export const GOOGLE_TOOL_NAME = "Google (Calendar, Docs, Slides, Sheets)";

/**
 * The Google row of the composer's "+" menu: a switch when Google is
 * connected, a link to the Connectors page when it is not, and a disabled row
 * with one line of why in every other case.
 */
export function GoogleToolOption({ link, on }: { link: GoogleLinkState; on: boolean }) {
  if (link.state === "not_connected" || link.state === "needs_reconnect") {
    return (
      <Link href="/connectors" className="tool-option tool-link">
        <span>
          <strong>{link.state === "needs_reconnect" ? "Reconnect Google" : "Connect Google"}</strong>
          <span className="hint">Calendar, Docs, Slides and Sheets</span>
        </span>
      </Link>
    );
  }

  const enabled = link.state === "connected";
  const hint = link.state === "connected" ? googleToggleHint(link.products) : GOOGLE_ROW_HINTS[link.state];
  return (
    <label className={`tool-option${enabled ? "" : " is-disabled"}`}>
      <input
        type="checkbox"
        checked={enabled && on}
        disabled={!enabled}
        onChange={(event) => setGoogleChip(event.target.checked)}
      />
      <span>
        <strong>{GOOGLE_TOOL_NAME}</strong>
        <span className="hint">{hint}</span>
      </span>
    </label>
  );
}
