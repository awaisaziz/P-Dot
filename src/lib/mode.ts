import type { Mode } from "@/types/api";

/**
 * One workspace (decision 0014): the `mode` column stays in the database, but
 * this is the only value the app writes. Lists show every row whatever mode it
 * was saved with, and the user never sees a mode.
 */
export const WORKSPACE_MODE: Mode = "personal";
