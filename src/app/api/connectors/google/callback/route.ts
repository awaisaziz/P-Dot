import { ConfigError } from "@/lib/supabase-config";
import { getAuthContext } from "@/server/auth/session";
import { getSiteUrl } from "@/server/config";
import { getConnectorConfig } from "@/server/connectors/config";
import { completeGoogleConnection } from "@/server/connectors/google/callback";
import { clearStateCookieHeader, readCookie, redirectResponse, STATE_COOKIE } from "@/server/connectors/route-helpers";
import { newRequestId } from "@/server/http/responses";
import { logEvent } from "@/server/log";
import type { ConnectorErrorCode } from "@/types/connectors";

function siteOrigin(): string {
  try {
    return new URL(getSiteUrl()).origin;
  } catch {
    return "";
  }
}

/**
 * GET /api/connectors/google/callback?code&state: Google sends the browser
 * here. A top-level navigation, so it answers with redirects, not JSON: to
 * the login page without a session, otherwise only to
 * `${SITE_URL}/connectors?connected=google` or `?error=<code>`. The state
 * cookie is cleared on every outcome.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const startedAt = Date.now();
  const site = siteOrigin();
  const finish = (location: string) => {
    const response = redirectResponse(location, requestId, clearStateCookieHeader());
    logEvent("info", "api_request", {
      requestId,
      route: "connectors.google.callback",
      method: request.method,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return response;
  };
  const failed = (code: ConnectorErrorCode) => finish(`${site}/connectors?error=${code}`);

  let code: ConnectorErrorCode | null;
  try {
    const auth = await getAuthContext();
    if (!auth) return finish(`${site}/login?next=/connectors`);
    const config = getConnectorConfig();
    if (!config) return failed("exchange_failed");
    const result = await completeGoogleConnection({
      userId: auth.userId,
      supabase: auth.supabase,
      config,
      params: new URL(request.url).searchParams,
      cookie: readCookie(request, STATE_COOKIE),
      requestId,
    });
    code = result.ok ? null : result.code;
  } catch (error) {
    logEvent("error", error instanceof ConfigError ? "config_missing" : "unhandled_route_error", {
      requestId,
      route: "connectors.google.callback",
      errorName: error instanceof Error ? error.name : "unknown",
    });
    code = "exchange_failed";
  }
  return code === null ? finish(`${site}/connectors?connected=google`) : failed(code);
}
