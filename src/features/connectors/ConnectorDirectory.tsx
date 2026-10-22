"use client";

// The searchable Connectors directory: Google (one sign-in, five products),
// P-Dot's built-in lists, and accounts that are coming later (decision 0016).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError, errorMessage, getJson } from "@/lib/api-client";
import { CONNECTOR_REVOKE_FAILED_MESSAGE, type ConnectorsResponse } from "@/types/connectors";
import { ConnectorIcon, type ConnectorIconName } from "./ConnectorIcon";
import { GOOGLE_PRODUCTS, GoogleAccount, PILL_CLASSES, productStatus, type PillTone } from "./GoogleAccount";

export interface BuiltInConnector {
  icon: ConnectorIconName;
  name: string;
  description: string;
  /** Live count line, for example "2 open tasks". */
  status: string;
  href: string;
  link: string;
}

export interface DirectoryNotice {
  tone: "success" | "warning" | "error";
  text: string;
}

const NOTICE_CLASSES: Record<DirectoryNotice["tone"], string> = {
  success: "alert-notice",
  warning: "alert-warning",
  error: "alert-error",
};

interface ComingSoon {
  icon: ConnectorIconName;
  name: string;
  description: string;
  href?: string;
}

const COMING_SOON: readonly ComingSoon[] = [
  { icon: "gmail", name: "Gmail", description: "Read and draft mail; asks before sending." },
  { icon: "telegram", name: "Telegram", description: "Send your brief to your own chat." },
  { icon: "github", name: "GitHub", description: "Read pull requests and issues; asks before changing anything." },
  { icon: "whatsapp", name: "WhatsApp", description: "Send you briefs and reminders; asks before messaging anyone else." },
  { icon: "phone", name: "Phone calls", description: "Call to book appointments; asks before every call." },
  { icon: "devices", name: "Your devices", description: "Act on your own laptop and phone, with approval each time.", href: "/devices" },
];

/** Every word of the query must appear in the card's group, name or description. */
export function matches(query: string, ...fields: string[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields.join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

interface CardProps {
  icon: ConnectorIconName;
  name: string;
  description: string;
  pill: { label: string; tone: PillTone };
  children?: React.ReactNode;
}

function ConnectorCard({ icon, name, description, pill, children }: CardProps) {
  return (
    <article className="connector-card">
      <div className="connector-card-head">
        <ConnectorIcon name={icon} />
        <h3 className="connector-card-name">{name}</h3>
        <span className={`status-pill ${PILL_CLASSES[pill.tone]}`}>{pill.label}</span>
      </div>
      <p className="connector-card-line">{description}</p>
      {children}
    </article>
  );
}

interface ConnectorDirectoryProps {
  /** Null when the page could not read the Google connection. */
  initialGoogle: ConnectorsResponse | null;
  builtIn: BuiltInConnector[];
  initialNotice: DirectoryNotice | null;
}

export function ConnectorDirectory({ initialGoogle, builtIn, initialNotice }: ConnectorDirectoryProps) {
  const router = useRouter();
  const [google, setGoogle] = useState(initialGoogle);
  const [notice, setNotice] = useState(initialNotice);
  const [query, setQuery] = useState("");
  const [retrying, setRetrying] = useState(false);

  // A successful Retry removes its own button, so focus moves to the Google group; a failed one keeps it on Retry.
  const googleRef = useRef<HTMLElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<"google" | "retry" | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    (target === "google" ? googleRef : retryRef).current?.focus();
  });

  // Drop ?connected= and ?error= so a reload does not show the notice again.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("connected") && !url.searchParams.has("error")) return;
    url.searchParams.delete("connected");
    url.searchParams.delete("error");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  async function retry() {
    setRetrying(true);
    try {
      const loaded = await getJson<ConnectorsResponse>("/api/connectors");
      pendingFocus.current = "google";
      setGoogle(loaded);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) router.replace("/login?next=/connectors");
      else {
        pendingFocus.current = "retry";
        setNotice({ tone: "error", text: errorMessage(err, "Could not load your Google connection.") });
      }
    } finally {
      setRetrying(false);
    }
  }

  function disconnected(revoked: boolean) {
    setGoogle((current) => (current ? { ...current, google: null } : current));
    setNotice(
      revoked
        ? { tone: "success", text: "Google is disconnected." }
        : { tone: "warning", text: CONNECTOR_REVOKE_FAILED_MESSAGE },
    );
  }

  const products = GOOGLE_PRODUCTS.filter((product) => matches(query, "Google", product.name, product.description));
  const builtInShown = builtIn.filter((tool) => matches(query, "Built in", tool.name, tool.description));
  const comingShown = COMING_SOON.filter((tool) => matches(query, "Coming soon", tool.name, tool.description));
  const shown = products.length + builtInShown.length + comingShown.length;

  return (
    <div className="stack connector-directory">
      {notice && (
        <p className={`alert ${NOTICE_CLASSES[notice.tone]} small`} role="status">
          {notice.text}{" "}
          <button type="button" className="link-button" aria-label="Dismiss notice" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}

      <div className="connector-search">
        <label htmlFor="connector-search" className="visually-hidden">
          Search connectors
        </label>
        <input
          id="connector-search"
          className="form-control"
          type="search"
          placeholder="Search connectors"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {products.length > 0 && (
        <section ref={googleRef} className="connector-group" tabIndex={-1} aria-labelledby="google-heading">
          <div className="connector-group-head">
            <h2 id="google-heading">Google</h2>
            <p className="muted small">One sign-in for all five; P-Dot reads them only while Google is on in chat.</p>
          </div>
          {google ? (
            <GoogleAccount state={google} onDisconnected={disconnected} />
          ) : (
            <p className="alert alert-error small" role="alert">
              Could not load your Google connection ·{" "}
              <button ref={retryRef} type="button" className="link-button" disabled={retrying} onClick={() => void retry()}>
                {retrying ? "Retrying…" : "Retry"}
              </button>
            </p>
          )}
          <div className="connector-grid">
            {products.map((product) => (
              <ConnectorCard
                key={product.name}
                icon={product.icon}
                name={product.name}
                description={product.description}
                pill={google ? productStatus(google, product.scope) : { label: "Not loaded", tone: "muted" }}
              />
            ))}
          </div>
        </section>
      )}

      {builtInShown.length > 0 && (
        <section className="connector-group" aria-labelledby="built-in-heading">
          <div className="connector-group-head">
            <h2 id="built-in-heading">Built in</h2>
            <p className="muted small">P-Dot&apos;s own lists and files; chat changes them only as your approval mode allows.</p>
          </div>
          <div className="connector-grid">
            {builtInShown.map((tool) => (
              <ConnectorCard
                key={tool.name}
                icon={tool.icon}
                name={tool.name}
                description={tool.description}
                pill={{ label: "Ready", tone: "success" }}
              >
                <p className="connector-card-meta">
                  <span className="connector-status">{tool.status}</span>
                  <Link href={tool.href}>{tool.link}</Link>
                </p>
              </ConnectorCard>
            ))}
          </div>
        </section>
      )}

      {comingShown.length > 0 && (
        <section className="connector-group" aria-labelledby="coming-heading">
          <div className="connector-group-head">
            <h2 id="coming-heading">Coming soon</h2>
            <p className="muted small">Previews only; none of these can be connected yet.</p>
          </div>
          <div className="connector-grid">
            {comingShown.map((tool) => (
              <ConnectorCard
                key={tool.name}
                icon={tool.icon}
                name={tool.name}
                description={tool.description}
                pill={{ label: "Coming soon", tone: "muted" }}
              >
                {tool.href && (
                  <p className="connector-card-meta">
                    <Link href={tool.href}>Open devices</Link>
                  </p>
                )}
              </ConnectorCard>
            ))}
          </div>
        </section>
      )}

      {shown === 0 && <p className="muted">No connector matches &ldquo;{query.trim()}&rdquo;.</p>}

      <p className="visually-hidden" role="status" aria-live="polite">
        {query.trim() ? `${shown} ${shown === 1 ? "connector" : "connectors"} shown` : ""}
      </p>
    </div>
  );
}
