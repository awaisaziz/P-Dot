import Link from "next/link";
import { ConfigError } from "@/lib/supabase-config";
import { getAuthContext } from "@/server/auth/session";
import { DynamicAgentCard } from "@/features/landing/DynamicAgentCard";

async function isSignedIn(): Promise<boolean> {
  try {
    return (await getAuthContext()) !== null;
  } catch (error) {
    // Auth not configured yet: show the signed-out page. Rethrow anything else
    // (including Next.js's internal dynamic-rendering signal).
    if (error instanceof ConfigError) return false;
    throw error;
  }
}

// What P-Dot does today, one line each.
const FEATURES = [
  { title: "Verified flight checks", line: "Fares quoted from travel pages, each with its source and the time it was read." },
  { title: "Google Calendar and Drive", line: "Reads your calendar, Docs, Slides and Sheets only while you turn Google on." },
  { title: "Memory you control", line: "See, edit or delete everything it remembers." },
  { title: "Approvals and a full log", line: "Asks before it acts by default, and every action is logged." },
];

const CONNECT = [
  { name: "Google Calendar", chip: "calendar" },
  { name: "Docs", chip: "docs" },
  { name: "Slides", chip: "slides" },
  { name: "Sheets", chip: "sheets" },
];

export default async function LandingPage() {
  const signedIn = await isSignedIn();

  return (
    <div className="landing">
      <header className="landing-header">
        <Link href="/" className="brand">
          P-Dot
        </Link>
        <nav className="actions" aria-label="Account">
          {signedIn ? (
            <Link className="button button-primary" href="/chat">
              Open your workspace
            </Link>
          ) : (
            <>
              <Link className="button" href="/login">
                Sign in
              </Link>
              <Link className="button button-primary" href="/signup">
                Create an account
              </Link>
            </>
          )}
        </nav>
      </header>

      <main className="landing-body">
        <section className="landing-copy">
          <p className="pill">Your personal assistant bot</p>
          <h1>
            Don&apos;t just chat.
            <br />
            <span className="gradient-text">Get it done.</span>
          </h1>
          <p className="lead">A private assistant that quotes fares and facts from their sources, asks before it acts, and logs every action.</p>
          <ul className="landing-features">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="landing-feature">
                <span className="landing-feature-mark" aria-hidden="true" />
                <span className="landing-feature-body">
                  <strong>{feature.title}</strong>
                  <span className="muted">{feature.line}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="actions">
            {signedIn ? (
              <Link className="button button-primary button-large" href="/chat">
                Open your workspace
              </Link>
            ) : (
              <>
                <Link className="button button-primary button-large" href="/signup">
                  Get started free
                </Link>
                <Link className="button button-large" href="/login">
                  I have an account
                </Link>
              </>
            )}
          </div>
          <div className="connect-row">
            <span className="connect-label">Connect Google</span>
            {CONNECT.map((item) => (
              <span key={item.name} className={`chip chip-${item.chip}`}>
                {item.name}
              </span>
            ))}
            <Link className="button button-primary button-small" href="/connectors">
              Connect
            </Link>
          </div>
          <p className="muted small landing-note">
            Runs on Nebius Token Factory with Tavily web search; Gmail, messaging and device actions are still being built.
          </p>
        </section>

        <DynamicAgentCard />
      </main>
    </div>
  );
}
