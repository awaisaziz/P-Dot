import type { Metadata } from "next";
import Link from "next/link";
import { signInAction } from "@/features/auth/actions";
import { AuthForm } from "@/features/auth/AuthForm";
import { safeNextPath } from "@/lib/safe-url";

export const metadata: Metadata = { title: "Sign in · P-Dot" };

interface LoginPageProps {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : undefined);
  const linkInvalid = params.error === "link_invalid";

  return (
    <>
      <h1>Sign in</h1>
      {linkInvalid && (
        <p className="alert alert-error" role="alert">
          That link is invalid or expired; sign in or request a new one.
        </p>
      )}
      <AuthForm
        action={signInAction}
        submitLabel="Sign in"
        pendingLabel="Signing in…"
        hidden={{ next }}
        fields={[
          { name: "email", label: "Email", type: "email", autoComplete: "email" },
          { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
        ]}
      />
      <p className="muted">
        <Link href="/forgot-password">Forgot your password?</Link>
      </p>
      <p className="muted">
        New to P-Dot? <Link href="/signup">Create an account</Link>
      </p>
    </>
  );
}
