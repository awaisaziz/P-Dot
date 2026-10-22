import { z } from "zod";
import { getConnectorConfig } from "@/server/connectors/config";
import { createGoogleConnector } from "@/server/connectors/google/connector";
import { errorResponse, jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import type { UpcomingEventsResponse } from "@/types/connectors";

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/)
  .refine(isTimeZone);

/**
 * GET /api/connectors/google/upcoming?tz=<IANA>: the Today "Coming up" panel.
 * The next 24 hours, at most 5 events, all-day first. One read per page
 * load; a failure is a state, never made-up events.
 */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "connectors.google.upcoming" }, async ({ auth, requestId }) => {
    const tz = timeZoneSchema.safeParse(new URL(request.url).searchParams.get("tz"));
    if (!tz.success) {
      return errorResponse(400, "invalid_request", "Send tz as an IANA time zone, for example Europe/London.", requestId);
    }
    const config = getConnectorConfig();
    if (!config) return jsonResponse({ state: "not_connected" } satisfies UpcomingEventsResponse, requestId);
    const connector = createGoogleConnector({ supabase: auth.supabase, userId: auth.userId, config });
    const body: UpcomingEventsResponse = await connector.upcoming({ timeZone: tz.data }, request.signal);
    return jsonResponse(body, requestId);
  });
}
