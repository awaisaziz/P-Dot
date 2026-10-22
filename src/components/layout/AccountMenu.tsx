"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { signOutAction } from "@/features/auth/actions";

/** The account button in the header: who is signed in, Settings, Devices and Sign out. */
export function AccountMenu({ email }: { email: string | null }) {
  const pathname = usePathname();
  // Opened on one page; a navigation closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpenOn(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenOn(null);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initial = email?.trim().charAt(0).toUpperCase() ?? "";
  const close = () => setOpenOn(null);

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="account-button"
        aria-expanded={open}
        aria-controls="account-panel"
        onClick={() => setOpenOn(open ? null : pathname)}
      >
        <span className="account-avatar" aria-hidden="true">
          {initial || "•"}
        </span>
        <span className="visually-hidden">Account</span>
      </button>
      <div id="account-panel" className="account-panel" hidden={!open}>
        <p className="account-who">
          <span className="muted small">Signed in as</span>
          <span className="account-address">{email ?? "your account"}</span>
        </p>
        <Link href="/settings" className="account-item" onClick={close}>
          Settings
        </Link>
        <Link href="/devices" className="account-item" onClick={close}>
          Devices
        </Link>
        <form action={signOutAction}>
          <button type="submit" className="account-item">
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
