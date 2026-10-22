import type { Metadata } from "next";
import Link from "next/link";
import { ApprovalModeOptions } from "@/features/actions/ApprovalModePicker";
import { KIND_LABELS } from "@/features/actions/format";
import { signOutAction } from "@/features/auth/actions";
import { AppSettings } from "@/features/pwa/AppSettings";
import { ACTION_EFFECTS, ALWAYS_ASK_REASONS, MAX_AUTO_ACTIONS_PER_REPLY } from "@/lib/approval-policy";
import { requireAuth } from "@/server/auth/session";
import type { ActionKind } from "@/types/api";

// Read from the shared policy, so this page always matches what Auto mode does.
const RUNS_ON_ITS_OWN = (Object.keys(ACTION_EFFECTS) as ActionKind[])
  .filter((kind) => ACTION_EFFECTS[kind] === "create_own")
  .map((kind) => KIND_LABELS[kind]);

export const metadata: Metadata = { title: "Settings · P-Dot" };

export default async function SettingsPage() {
  const auth = await requireAuth("/settings");

  return (
    <main className="page stack">
      <div className="page-intro">
        <h1>Settings</h1>
        <p className="muted">Your account, how P-Dot asks before it acts, and what it does with your data.</p>
      </div>

      <section className="card stack" aria-labelledby="account-heading">
        <h2 id="account-heading">Account</h2>
        <p>
          Signed in as <strong>{auth.email ?? "your account"}</strong>
        </p>
        <div className="actions">
          <Link className="button" href="/reset-password">
            Change password
          </Link>
          <form action={signOutAction}>
            <button type="submit" className="button">
              Sign out
            </button>
          </form>
        </div>
      </section>

      <section id="approvals" className="card stack" aria-labelledby="approvals-heading">
        <h2 id="approvals-heading">Approvals</h2>
        <p>Choose how P-Dot acts on what it suggests in chat; you can also switch next to the message box.</p>
        <ApprovalModeOptions />
        <p className="muted small">
          Auto does these on its own with Undo: {RUNS_ON_ITS_OWN.join(", ").toLowerCase()} (at most{" "}
          {MAX_AUTO_ACTIONS_PER_REPLY} per reply, and none after a Google read or a checked search).
        </p>
        <div className="stack">
          <h3>Always asks, even in Auto</h3>
          <ul className="plain-list">
            {Object.values(ALWAYS_ASK_REASONS).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
        <p className="hint">
          Saved on this device; every action appears in the <Link href="/action-log">action log</Link>.
        </p>
      </section>

      <AppSettings />

      <section className="card stack" aria-labelledby="devices-heading">
        <h2 id="devices-heading">Devices</h2>
        <p>
          See how this device is set up and how pairing will work. <Link href="/devices">Open devices</Link>
        </p>
      </section>

      <section className="card stack" aria-labelledby="data-heading">
        <h2 id="data-heading">How your data is used</h2>
        <ul className="plain-list data-use-list">
          <li>
            <strong>Inference (Nebius Token Factory):</strong> each message and recent messages from that chat go to
            Nebius to write the reply.
          </li>
          <li>
            <strong>Web search (Tavily):</strong> search queries P-Dot writes, flight checks and, with search on, your
            message go to Tavily; excerpts go to Nebius as context.
          </li>
          <li>
            <strong>Flight checks</strong> read travel pages through Tavily; fares shown are quoted from those pages with
            their source and time, never booked.
          </li>
          <li>
            <strong>Google (read only):</strong> P-Dot reads your calendar and Drive only while Google is on in chat,
            and keeps its access encrypted. Content read for a reply is sent to Nebius to write that reply. The reply,
            and anything it quotes, is saved in your conversation and sent again as context in later messages there.
            Disconnecting stops new reads but does not delete past conversations.{" "}
            <Link href="/connectors">Manage Google</Link>
          </li>
          <li>
            <strong>Voice dictation:</strong> your browser&apos;s own speech service turns speech into text; P-Dot only
            receives the text you send.
          </li>
          <li>
            <strong>Memory:</strong> memory text is embedded once on Nebius and relevant memories are used in replies;
            see, change or delete them on the <Link href="/memory">Memory</Link> page.
          </li>
          <li>
            <strong>Documents:</strong> file text is embedded once on Nebius and relevant parts are used in replies;
            list or delete them on the <Link href="/memory#documents">Memory</Link> page.
          </li>
          <li>
            <strong>Approvals:</strong> nothing P-Dot proposes happens until you approve it, except what Auto adds with
            Undo.
          </li>
          <li>
            <strong>What was sent:</strong> each reply records which model answered and what context it got (counts and
            IDs only), shown under the reply.
          </li>
          <li>
            <strong>Action log:</strong> decisions, runs and data changes are recorded without their text and cannot be
            edited; see the <Link href="/action-log">action log</Link>.
          </li>
          <li>
            <strong>Storage (Supabase):</strong> your account and everything you save are stored in Supabase, visible
            only to your account.
          </li>
          <li>
            <strong>Logs:</strong> the server logs timing, status and error type, never your messages or search queries.
          </li>
        </ul>
      </section>

      <section className="card stack" aria-labelledby="retention-heading">
        <h2 id="retention-heading">Retention and deletion</h2>
        <ul className="plain-list">
          <li>Conversations stay until you delete them; backups may keep a copy until they expire.</li>
          <li>Deleting a memory or document removes it at once; proposals and the action log stay as an audit record.</li>
          <li>Disconnecting Google deletes its stored access at once and asks Google to revoke it.</li>
          <li className="muted">Account deletion and the final retention policy are still to come.</li>
        </ul>
      </section>
    </main>
  );
}
