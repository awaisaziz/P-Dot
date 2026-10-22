"use server";

import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { z } from "zod";
import { emailSchema, newPasswordSchema } from "@/lib/schemas";
import { ConfigError } from "@/lib/supabase-config";
import { safeNextPath } from "@/lib/safe-url";
import { getSiteUrl } from "@/server/config";
import { createSupabaseServerClient } from "@/server/db/supabase";
import { logEvent } from "@/server/log";
import type { AuthFormState } from "./types";

// Auth messages never reveal whether an account exists for an email address.

const UNAVAILABLE: AuthFormState = {
  error: "The account service is unavailable; try again later.",
};
const RATE_LIMITED: AuthFormState = { error: "Too many attempts; wait a few minutes and try again." };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function firstError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the form and try again.";
}

function isRateLimit(error: { code?: string; status?: number }): boolean {
  return error.status === 429 || (error.code?.startsWith("over_") ?? false);
}

/** Network failures and Auth server errors are outages, not bad credentials. */
function isOutage(error: { status?: number }): boolean {
  return isAuthRetryableFetchError(error) || !error.status || error.status >= 500;
}

async function supabaseOrNull() {
  try {
    return await createSupabaseServerClient();
  } catch (error) {
    if (error instanceof ConfigError) {
      logEvent("error", "config_missing", { route: "auth", missing: error.missing.join(",") });
      return null;
    }
    throw error;
  }
}

export async function signInAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = z
    .object({ email: emailSchema, password: z.string().min(1, "Enter your password.") })
    .safeParse({ email: field(formData, "email").trim(), password: field(formData, "password") });
  const email = field(formData, "email").trim();
  if (!parsed.success) return { error: firstError(parsed.error), email };

  const supabase = await supabaseOrNull();
  if (!supabase) return { ...UNAVAILABLE, email };

  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    if (isRateLimit(error)) return { ...RATE_LIMITED, email };
    if (isOutage(error)) return { ...UNAVAILABLE, email };
    return { error: "Wrong email or password, or the email is not confirmed yet.", email };
  }
  redirect(safeNextPath(field(formData, "next")));
}

export async function signUpAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = z
    .object({ email: emailSchema, password: newPasswordSchema, confirm: z.string() })
    .refine((value) => value.password === value.confirm, { message: "Passwords do not match." })
    .safeParse({
      email: field(formData, "email").trim(),
      password: field(formData, "password"),
      confirm: field(formData, "confirm"),
    });
  const email = field(formData, "email").trim();
  if (!parsed.success) return { error: firstError(parsed.error), email };

  const supabase = await supabaseOrNull();
  if (!supabase) return { ...UNAVAILABLE, email };

  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { emailRedirectTo: `${getSiteUrl()}/auth/confirm?next=/chat` },
  });

  const checkEmail: AuthFormState = {
    notice: "Check your email for a confirmation link to finish creating your account.",
  };
  if (error) {
    if (isRateLimit(error)) return { ...RATE_LIMITED, email };
    if (isOutage(error)) return { ...UNAVAILABLE, email };
    if (error.code === "weak_password") return { error: "Choose a stronger password.", email };
    // Same response whether or not the address is already registered.
    if (error.code === "user_already_exists" || error.code === "email_exists") return checkEmail;
    return { error: "Could not create your account; try again.", email };
  }
  // With email confirmation disabled in Supabase, sign-up returns a session.
  if (data.session) redirect("/chat");
  return checkEmail;
}

export async function requestPasswordResetAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = field(formData, "email").trim();
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return { error: firstError(parsed.error), email };

  const supabase = await supabaseOrNull();
  if (!supabase) return { ...UNAVAILABLE, email };

  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data, {
    redirectTo: `${getSiteUrl()}/auth/confirm?next=/reset-password`,
  });
  if (error && isRateLimit(error)) return { ...RATE_LIMITED, email };
  if (error && isOutage(error)) return { ...UNAVAILABLE, email };
  return { notice: "If an account exists for that email, we sent a link to reset the password." };
}

export async function updatePasswordAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = z
    .object({ password: newPasswordSchema, confirm: z.string() })
    .refine((value) => value.password === value.confirm, { message: "Passwords do not match." })
    .safeParse({ password: field(formData, "password"), confirm: field(formData, "confirm") });
  if (!parsed.success) return { error: firstError(parsed.error) };

  const supabase = await supabaseOrNull();
  if (!supabase) return UNAVAILABLE;

  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) {
    return { error: "Your reset link expired; request a new one." };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    if (isOutage(error)) return UNAVAILABLE;
    if (error.code === "same_password") return { error: "Choose a password you have not used before." };
    if (error.code === "weak_password") return { error: "Choose a stronger password." };
    if (error.code === "reauthentication_needed") {
      return { error: "For security, request a new reset link and try again." };
    }
    return { error: "Could not update your password; try again." };
  }
  redirect("/chat");
}

export async function signOutAction(): Promise<void> {
  const supabase = await supabaseOrNull();
  // "local" ends this browser's session only; other devices stay signed in.
  if (supabase) await supabase.auth.signOut({ scope: "local" });
  redirect("/");
}
