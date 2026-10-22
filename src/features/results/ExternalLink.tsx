import type { ReactNode } from "react";

/**
 * A link to a page outside P-Dot. Pass only a URL that went through
 * toSafeHttpUrl (and, where it applies, a host allow list).
 */
export function ExternalLink({
  href,
  children,
  className,
  label,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  /** A fuller accessible name when the visible text is short. */
  label?: string;
}) {
  return (
    <a
      href={href}
      className={className}
      target="_blank"
      rel="noopener noreferrer nofollow"
      aria-label={label ? `${label} (opens in a new tab)` : undefined}
    >
      {children}
      {!label && <span className="visually-hidden"> (opens in a new tab)</span>}
    </a>
  );
}
