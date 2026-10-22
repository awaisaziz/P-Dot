"use client";

import { promptInstall, usePwa } from "./pwa-store";

/** Header button shown only while the browser offers to install P-Dot. Phones show "Install". */
export function InstallButton() {
  const pwa = usePwa();
  if (!pwa.installable || pwa.standalone) return null;
  return (
    <button type="button" className="button button-small header-install" onClick={() => void promptInstall()}>
      Install<span className="header-install-extra">&nbsp;app</span>
    </button>
  );
}
