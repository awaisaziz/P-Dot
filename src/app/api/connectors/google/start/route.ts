import { z } from "zod";
import { getConnectorConfig, isConnectorUserAllowed, siteHost } from "@/server/connectors/config";
import { createKeyring, createPkceVerifier, pkceChallenge, randomState, signState } from "@/server/connectors/crypto";
import { buildAuthorizationUrl } from "@/server/connectors/google/oauth";
import { requestHost, stateCookieHeader } from "@/server/connectors/route-helpers";
import { readJsonBody } from "@/server/http/request";
import { errorResponse, jsonResponse, notConfigured } from "@/server/http/responses";
import { withAuthenticatedRoute } from "@/server/http/route";
import { CONNECTOR_NOT_ALLOWED_MESSAGE, type ConnectorStartResponse } from "@/types/connectors";

const MAX_BODY_BYTES = 1024;

/** The body is optional; when sent it must be an empty JSON object. Scopes are a server constant. */
const startSchema = z.object({}).strict();

/**
 * POST /api/connectors/google/start: sets the signed, HTTP-only state cookie
 * (state and PKCE verifier, 10 minutes) and returns Google's authorization
 * URL for the browser to open (decision 0016, amendments of 2026-10-21).
 */
export async function POST(request: Request): Promise<Response> {
  return withAuthenticatedRoute(request, { route: "connectors.google.start", sameOrigin: true }, async ({ auth, requestId }) => {
    if (request.headers.get("content-type") !== null || Number(request.headers.get("content-length") ?? "0") > 0) {
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      if (!body.ok) return errorResponse(body.status, body.code, body.message, requestId);
      if (!startSchema.safeParse(body.value).success) {
        return errorResponse(400, "invalid_request", "Send an empty request body.", requestId);
      }
    }

    const config = getConnectorConfig();
    if (!config) return notConfigured(requestId);
    if (!isConnectorUserAllowed(config, auth.userId)) {
      return errorResponse(403, "forbidden", CONNECTOR_NOT_ALLOWED_MESSAGE, requestId);
    }
    // Previews share the production database; only the site's own host may start a connection.
    if (requestHost(request) !== siteHost(config)) {
      return errorResponse(403, "forbidden", "Connect Google from P-Dot's main address.", requestId);
    }

    const keyring = createKeyring(config);
    const state = randomState();
    const verifier = createPkceVerifier();
    const cookie = await signState(keyring, { v: 1, uid: auth.userId, state, verifier, iat: Math.floor(Date.now() / 1000) });
    const body: ConnectorStartResponse = {
      url: buildAuthorizationUrl(config.google, { state, codeChallenge: await pkceChallenge(verifier) }),
    };
    return jsonResponse(body, requestId, { headers: { "Set-Cookie": stateCookieHeader(cookie) } });
  });
}
