import { isSupabaseConfigured } from "@/lib/supabase-config";
import { getAssistantConfig } from "@/server/config";
import { getConnectorConfig } from "@/server/connectors/config";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — liveness plus which integrations are configured (booleans
 * only; never values). It does not call the providers, so "configured" does
 * not mean "reachable".
 */
export function GET(): Response {
  let inference = false;
  let webSearch = false;
  try {
    const config = getAssistantConfig();
    inference = true;
    webSearch = config.tavily !== null;
  } catch {
    // Not configured.
  }
  let google = false;
  try {
    google = getConnectorConfig() !== null;
  } catch {
    // Malformed: reported as not configured.
  }

  return Response.json(
    {
      status: "ok",
      time: new Date().toISOString(),
      configured: { auth: isSupabaseConfigured(), inference, webSearch, connectors: { google } },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
