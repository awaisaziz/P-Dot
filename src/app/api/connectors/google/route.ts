import { getConnectorConfig } from "@/server/connectors/config";
import { createKeyring, decryptToken } from "@/server/connectors/crypto";
import { revokeToken } from "@/server/connectors/google/oauth";
import { noContent } from "@/server/connectors/route-helpers";
import { createConnectorGrantRepository } from "@/server/db/connector-grants";
import { jsonResponse } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { logEvent } from "@/server/log";
import type { ConnectorDisconnectResponse } from "@/types/connectors";

/**
 * DELETE /api/connectors/google: revokes the refresh token at Google (in a
 * form body), then deletes the grant, in any status. 204 when Google
 * confirmed; 200 with { revoked: false } when it did not, so the page can
 * point to myaccount.google.com/permissions. Without a grant it answers 204.
 */
export async function DELETE(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "connectors.google.delete", sameOrigin: true }, async ({ auth, requestId }) => {
    const config = getConnectorConfig();
    const repo = createConnectorGrantRepository(auth.supabase);
    const grant = await repo.getGrant(auth.userId, "google");
    if (!grant) return noContent(requestId);

    let revoked = false;
    // Without the keys the token cannot be read, but the grant can still be deleted.
    if (config) {
      try {
        const secrets = await repo.readSecrets(auth.userId, grant.id);
        if (secrets) {
          const token = await decryptToken(createKeyring(config), secrets.refreshCiphertext, {
            userId: auth.userId,
            provider: "google",
            accountSub: grant.accountSub,
            purpose: "refresh",
          });
          revoked = await revokeToken(token);
        }
      } catch {
        revoked = false;
      }
    }

    await repo.deleteGrant(auth.userId, grant.id);
    logEvent("info", "connector_disconnect", { requestId, provider: "google", revoked });
    if (revoked) return noContent(requestId);
    const body: ConnectorDisconnectResponse = { revoked: false };
    return jsonResponse(body, requestId);
  });
}
