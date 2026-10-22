import type { Metadata } from "next";
import Link from "next/link";
import { ThisDevice } from "@/features/pwa/ThisDevice";
import { requireAuth } from "@/server/auth/session";

export const metadata: Metadata = { title: "Devices · P-Dot" };

// The planned pairing flow, shown as a preview. See docs/decisions/0010-pwa-and-device-pairing.md.
const PAIRING_STEPS = [
  "Install P-Dot on the laptop or phone you want to pair.",
  "Create a one-time pairing code here; it expires in 10 minutes.",
  "Enter the code on the other device.",
  "Approve the device here; remove it any time.",
];

export default async function DevicesPage() {
  await requireAuth("/devices");

  return (
    <main className="page stack">
      <div className="page-intro">
        <h1>Devices</h1>
        <p className="muted">
          Pair your laptop and phone so P-Dot can act on them, with approval and an{" "}
          <Link href="/action-log">action log</Link> entry for every action.
        </p>
      </div>

      <p className="alert alert-warning" role="status">
        Device pairing is not built yet; the steps below are a preview.
      </p>

      <section className="card stack" aria-labelledby="this-device-heading">
        <h2 id="this-device-heading">This device</h2>
        <ThisDevice />
        <p className="hint">
          Read from this browser; install and allow notifications in <Link href="/settings">Settings</Link>.
        </p>
      </section>

      <section className="card stack" aria-labelledby="pair-heading">
        <div className="panel-heading">
          <h2 id="pair-heading">Pair a laptop or phone</h2>
          <span className="status-pill">Coming soon</span>
        </div>
        <ol className="plain-list">
          {PAIRING_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <div className="actions">
          <button type="button" className="button button-primary" disabled aria-describedby="pair-unavailable">
            Create pairing code
          </button>
          <span id="pair-unavailable" className="hint">
            Not available yet.
          </span>
        </div>
      </section>

      <section className="card stack" aria-labelledby="paired-heading">
        <h2 id="paired-heading">Paired devices</h2>
        <p className="muted">No paired devices yet.</p>
      </section>
    </main>
  );
}
