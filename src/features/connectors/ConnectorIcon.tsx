// Small line icons for the connector directory. Decorative only: every card names its connector in text.

export type ConnectorIconName =
  | "google"
  | "calendar"
  | "docs"
  | "slides"
  | "sheets"
  | "drive"
  | "tasks"
  | "reminders"
  | "memory"
  | "documents"
  | "gmail"
  | "telegram"
  | "github"
  | "whatsapp"
  | "phone"
  | "devices";

const PATHS: Record<Exclude<ConnectorIconName, "google">, React.ReactNode> = {
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  docs: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </>
  ),
  slides: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M12 17v4M8 21h8" />
    </>
  ),
  sheets: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 10h16M4 15h16M10 4v16" />
    </>
  ),
  drive: (
    <>
      <path d="M9 4h6l6 10-3 6H6l-3-6z" />
      <path d="M3 14h18" />
    </>
  ),
  tasks: <path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />,
  reminders: <path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 21h4" />,
  memory: <path d="M6 3h12v18l-6-4-6 4z" />,
  documents: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </>
  ),
  gmail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </>
  ),
  telegram: <path d="M21 3L3 11l7 3 3 7zM10 14L21 3" />,
  github: <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />,
  whatsapp: <path d="M4 20l1.5-4A8 8 0 1 1 9 19.5z" />,
  phone: (
    <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
  ),
  devices: (
    <>
      <rect x="4" y="5" width="16" height="11" rx="1" />
      <path d="M2 19h20" />
    </>
  ),
};

export function ConnectorIcon({ name }: { name: ConnectorIconName }) {
  return (
    <span className="connector-icon" data-icon={name} aria-hidden="true">
      {name === "google" ? (
        <span className="connector-icon-letter">G</span>
      ) : (
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          focusable="false"
        >
          {PATHS[name]}
        </svg>
      )}
    </span>
  );
}
