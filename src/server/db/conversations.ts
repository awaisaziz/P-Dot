import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isModelTier, isRouteReason, type MessageRoute } from "@/lib/routing";
import { toSafeHttpUrl } from "@/lib/safe-url";
import type {
  ConversationSummary,
  MessageDTO,
  Mode,
  MessageRole,
  SourceRef,
  WebSearchStatus,
} from "@/types/api";

export class RepositoryError extends Error {
  constructor(operation: string) {
    // Never include database error details: they can echo row content.
    super(`Database operation failed: ${operation}`);
    this.name = "RepositoryError";
  }
}

export interface NewMessage {
  conversationId: string;
  role: MessageRole;
  content: string;
  webSearch?: WebSearchStatus;
  sources?: SourceRef[];
  /** Assistant replies only: which model answered and why. */
  route?: MessageRoute;
}

/**
 * Persistence for conversations and messages. Every method takes the
 * authenticated user's ID and filters by it explicitly; RLS enforces the same
 * rule in the database, so ownership is checked twice.
 */
export interface ConversationRepository {
  getConversation(userId: string, conversationId: string): Promise<ConversationSummary | null>;
  /** Newest first. `mode`, when given, keeps only the rows saved with it (decision 0014: the app passes none). */
  listConversations(userId: string, limit: number, mode?: Mode): Promise<ConversationSummary[]>;
  createConversation(userId: string, title: string, mode: Mode): Promise<ConversationSummary>;
  /** Returns null when no conversation with that ID belongs to the user. */
  renameConversation(userId: string, conversationId: string, title: string): Promise<ConversationSummary | null>;
  /** Returns false when no conversation with that ID belongs to the user. */
  deleteConversation(userId: string, conversationId: string): Promise<boolean>;
  /** The most recent `limit` messages, oldest first. */
  listRecentMessages(userId: string, conversationId: string, limit: number): Promise<MessageDTO[]>;
  insertMessage(userId: string, message: NewMessage): Promise<MessageDTO>;
}

const conversationRow = z.object({
  id: z.string(),
  title: z.string(),
  mode: z.enum(["personal", "work"]),
  updated_at: z.string(),
});

const sourceRow = z.object({ title: z.string(), url: z.string() });

const messageRow = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  web_search: z.enum(["off", "used", "no_results", "failed"]),
  sources: z.array(z.unknown()),
  // Null for user messages and for replies saved before model routing.
  model: z.string().nullish(),
  model_tier: z.string().nullish(),
  route_reason: z.string().nullish(),
  model_fallback: z.boolean().nullish(),
  created_at: z.string(),
});

const CONVERSATION_COLUMNS = "id, title, mode, updated_at";
const LEGACY_MESSAGE_COLUMNS = "id, role, content, web_search, sources, created_at";
const MESSAGE_COLUMNS =
  "id, role, content, web_search, sources, model, model_tier, route_reason, model_fallback, created_at";

const ROUTE_COLUMNS = new Set(["model", "model_tier", "route_reason", "model_fallback"]);

/**
 * The exact error messages for a missing column of `public.messages`. Each one
 * captures the column name. Any other text (another table, extra words) does
 * not match.
 */
const MISSING_COLUMN_MESSAGES: Record<string, RegExp[]> = {
  // Postgres, as PostgREST returns it for a select, and for a direct insert.
  "42703": [
    /^column (?:public\.)?messages\.([a-z_]+) does not exist$/,
    /^column "([a-z_]+)" of relation "messages" does not exist$/,
  ],
  // PostgREST schema cache, for an insert.
  PGRST204: [/^Could not find the '([a-z_]+)' column of 'messages' in the schema cache$/],
};

/**
 * True only when a database error says that one of the four model routing
 * columns of `messages` does not exist yet. This happens when new code runs
 * before the additive routing migration. Every other error returns false.
 */
export function isMissingRouteColumn(error: { code?: string; message?: string } | null): boolean {
  const patterns = error?.code ? MISSING_COLUMN_MESSAGES[error.code] : undefined;
  if (!patterns) return false;
  const message = (error?.message ?? "").trim();
  return patterns.some((pattern) => {
    const column = pattern.exec(message)?.[1];
    return column !== undefined && ROUTE_COLUMNS.has(column);
  });
}

function toConversation(row: unknown): ConversationSummary {
  const parsed = conversationRow.parse(row);
  return { id: parsed.id, title: parsed.title, mode: parsed.mode, updatedAt: parsed.updated_at };
}

function toSources(values: unknown[]): SourceRef[] {
  const sources: SourceRef[] = [];
  for (const value of values) {
    const parsed = sourceRow.safeParse(value);
    const url = parsed.success ? toSafeHttpUrl(parsed.data.url) : null;
    if (parsed.success && url) sources.push({ title: parsed.data.title, url });
  }
  return sources;
}

/** The route of an assistant reply, or null when any part is missing or unknown. */
function toRoute(row: z.infer<typeof messageRow>): MessageRoute | null {
  if (row.role !== "assistant" || !row.model) return null;
  if (!isModelTier(row.model_tier) || !isRouteReason(row.route_reason)) return null;
  return { model: row.model, tier: row.model_tier, reason: row.route_reason, fallback: row.model_fallback === true };
}

function toMessage(row: unknown): MessageDTO {
  const parsed = messageRow.parse(row);
  return {
    id: parsed.id,
    role: parsed.role,
    content: parsed.content,
    webSearch: parsed.web_search,
    sources: toSources(parsed.sources),
    route: toRoute(parsed),
    createdAt: parsed.created_at,
  };
}

export function createConversationRepository(supabase: SupabaseClient): ConversationRepository {
  // False after the database said the routing columns do not exist yet. Then
  // messages are read and written without them, and `route` is null. Each
  // request makes a new repository, so this ends when the migration is applied.
  let routeColumns = true;

  return {
    async getConversation(userId, conversationId) {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_COLUMNS)
        .eq("id", conversationId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new RepositoryError("getConversation");
      return data ? toConversation(data) : null;
    },

    async listConversations(userId, limit, mode) {
      let query = supabase
        .from("conversations")
        .select(CONVERSATION_COLUMNS)
        .eq("user_id", userId);
      if (mode) query = query.eq("mode", mode);
      const { data, error } = await query.order("updated_at", { ascending: false }).limit(limit);
      if (error) throw new RepositoryError("listConversations");
      return (data ?? []).map(toConversation);
    },

    async createConversation(userId, title, mode) {
      const { data, error } = await supabase
        .from("conversations")
        .insert({ user_id: userId, title, mode })
        .select(CONVERSATION_COLUMNS)
        .single();
      if (error || !data) throw new RepositoryError("createConversation");
      return toConversation(data);
    },

    async renameConversation(userId, conversationId, title) {
      const { data, error } = await supabase
        .from("conversations")
        .update({ title })
        .eq("id", conversationId)
        .eq("user_id", userId)
        .select(CONVERSATION_COLUMNS)
        .maybeSingle();
      if (error) throw new RepositoryError("renameConversation");
      return data ? toConversation(data) : null;
    },

    async deleteConversation(userId, conversationId) {
      const { count, error } = await supabase
        .from("conversations")
        .delete({ count: "exact" })
        .eq("id", conversationId)
        .eq("user_id", userId);
      if (error) throw new RepositoryError("deleteConversation");
      return (count ?? 0) > 0;
    },

    async listRecentMessages(userId, conversationId, limit) {
      const query = (columns: string) =>
        supabase
          .from("messages")
          .select(columns)
          .eq("conversation_id", conversationId)
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(limit);
      let result = await query(routeColumns ? MESSAGE_COLUMNS : LEGACY_MESSAGE_COLUMNS);
      if (result.error && routeColumns && isMissingRouteColumn(result.error)) {
        routeColumns = false;
        result = await query(LEGACY_MESSAGE_COLUMNS);
      }
      if (result.error) throw new RepositoryError("listRecentMessages");
      return ((result.data ?? []) as unknown[]).map(toMessage).reverse();
    },

    async insertMessage(userId, message) {
      const base = {
        conversation_id: message.conversationId,
        user_id: userId,
        role: message.role,
        content: message.content,
        web_search: message.webSearch ?? "off",
        sources: message.sources ?? [],
      };
      const route = message.route
        ? {
            model: message.route.model,
            model_tier: message.route.tier,
            route_reason: message.route.reason,
            model_fallback: message.route.fallback,
          }
        : {};
      const insert = (withRoute: boolean) =>
        supabase
          .from("messages")
          .insert(withRoute ? { ...base, ...route } : base)
          .select(withRoute ? MESSAGE_COLUMNS : LEGACY_MESSAGE_COLUMNS)
          .single();
      // A missing column fails the statement before any row is written, so
      // the second insert cannot make a duplicate.
      let result = await insert(routeColumns);
      if (result.error && routeColumns && isMissingRouteColumn(result.error)) {
        routeColumns = false;
        result = await insert(false);
      }
      if (result.error || !result.data) throw new RepositoryError("insertMessage");
      return toMessage(result.data);
    },
  };
}
