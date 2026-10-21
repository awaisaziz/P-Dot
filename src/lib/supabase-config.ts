// Supabase project URL and publishable key. Both are designed to be public
// (row-level security protects the data); keep the service-role/secret key out
// of this app entirely. Read lazily so builds do not require configuration.
//
// Only the server reads them. Next.js inlines NEXT_PUBLIC_* values at build
// time, so a container built once for many environments can set SUPABASE_URL
// and SUPABASE_PUBLISHABLE_KEY at runtime instead; they win when present.

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

export class ConfigError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing or invalid configuration: ${missing.join(", ")}`);
    this.name = "ConfigError";
  }
}

export function getSupabaseConfig(): SupabaseConfig {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const missing: string[] = [];
  if (!url || !/^https?:\/\//.test(url)) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!publishableKey) missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  if (missing.length > 0 || !url || !publishableKey) throw new ConfigError(missing);
  return { url, publishableKey };
}

export function isSupabaseConfigured(): boolean {
  try {
    getSupabaseConfig();
    return true;
  } catch {
    return false;
  }
}
