"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { WaitingApprovalsBadge } from "@/features/actions/WaitingApprovalsBadge";

const LINKS = [
  { href: "/today", label: "Today" },
  { href: "/chat", label: "Chat" },
  { href: "/memory", label: "Memory" },
  { href: "/workflows", label: "Workflows" },
  { href: "/connectors", label: "Connectors" },
  { href: "/action-log", label: "Action log" },
  { href: "/settings", label: "Settings" },
];

/** Must match the compact header rules in src/app/styles/pages.css. */
const COMPACT_QUERY = "(max-width: 960px)";

function subscribeCompact(onChange: () => void) {
  const query = window.matchMedia(COMPACT_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True on narrow screens, where the links fold into a menu. False on the server. */
function useCompactHeader(): boolean {
  return useSyncExternalStore(
    subscribeCompact,
    () => window.matchMedia(COMPACT_QUERY).matches,
    () => false,
  );
}

export function NavLinks() {
  const pathname = usePathname();
  const compact = useCompactHeader();
  // The menu belongs to the page it was opened on, so it closes after a navigation.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = compact && openOn === pathname;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const current = LINKS.find((link) => link.href === pathname);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (toggleRef.current?.contains(target) || navRef.current?.contains(target))) return;
      setOpenOn(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenOn(null);
      toggleRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      {/* Shown only on narrow screens (pages.css). The waiting count moves here so it stays visible. */}
      <button
        ref={toggleRef}
        type="button"
        className="nav-toggle"
        aria-expanded={open}
        aria-controls="workspace-nav"
        onClick={() => setOpenOn(open ? null : pathname)}
      >
        <span className="nav-toggle-icon" aria-hidden="true" />
        <span className="visually-hidden">Pages: </span>
        <span>{current?.label ?? "Menu"}</span>
        {compact && <WaitingApprovalsBadge />}
      </button>
      <nav ref={navRef} id="workspace-nav" aria-label="Workspace" className="main-nav" data-open={open ? "true" : undefined}>
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="nav-link"
            aria-current={pathname === link.href ? "page" : undefined}
            onClick={() => setOpenOn(null)}
          >
            {link.label}
            {/* Today holds the approval panel, so the waiting count goes there. */}
            {link.href === "/today" && !compact && <WaitingApprovalsBadge />}
          </Link>
        ))}
      </nav>
    </>
  );
}
