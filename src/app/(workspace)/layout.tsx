import { WorkspaceHeader } from "@/components/layout/WorkspaceHeader";
import { requireAuth } from "@/server/auth/session";

// Server-side guard for every workspace page (the proxy redirect is only a convenience).
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth();

  return (
    <div className="workspace">
      <WorkspaceHeader email={auth.email} />
      {children}
    </div>
  );
}
