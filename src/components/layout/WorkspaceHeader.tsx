import Link from "next/link";
import { InstallButton } from "@/features/pwa/InstallButton";
import { AccountMenu } from "./AccountMenu";
import { NavLinks } from "./NavLinks";

/** Brand, the page links (a menu on narrow screens), the install button and the account menu. */
export function WorkspaceHeader({ email }: { email: string | null }) {
  return (
    <header className="workspace-header">
      <Link href="/chat" className="brand">
        P-Dot
      </Link>
      <NavLinks />
      <div className="header-account">
        <InstallButton />
        <AccountMenu email={email} />
      </div>
    </header>
  );
}
