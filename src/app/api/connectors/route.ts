import { getConnectorConfig, isConnectorUserAllowed } from "@/server/connectors/config";
import { toConnectorGrantDTO } from "@/server/connectors/route-helpers";
import { createConnectorGrantRepository } from "@/server/db/connector-grants";
import { jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import type { ConnectorsResponse } from "@/types/connectors";

/**
 * GET /api/connectors: the user's Google grant without any token, whether
 * connectors are configured, and whether this user may connect (decision 0016).
 */
export async function GET(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "connectors.list" }, async ({ auth, requestId }) => {
    const config = getConnectorConfig();
    const grant = await createConnectorGrantRepository(auth.supabase).getGrant(auth.userId, "google");
    const body: ConnectorsResponse = {
      google: grant ? toConnectorGrantDTO(grant) : null,
      available: config !== null,
      allowed: config !== null && isConnectorUserAllowed(config, auth.userId),
    };
    return jsonResponse(body, requestId);
  });
}
