// When Today shows its "Coming up" panel (decision 0016). Pure and free of
// React, so the server page can call it and tests can import it
// (tests/unit/connectors-directory.test.ts).
import type { ConnectorsResponse } from "@/types/connectors";

/**
 * Only where Google can be used: the server has a Google client and token
 * keys, and this user is allowed. Elsewhere (previews, users not on the allow
 * list) Connect is disabled, so the panel and its Connect link stay hidden.
 */
export function comingUpVisible(google: Pick<ConnectorsResponse, "available" | "allowed">): boolean {
  return google.available && google.allowed;
}
