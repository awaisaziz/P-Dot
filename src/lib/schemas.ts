import { z } from "zod";
import {
  MAX_ACTION_SUMMARY_CHARS,
  MAX_DOCUMENT_CHARS,
  MAX_DOCUMENT_TITLE_CHARS,
  MAX_MEMORY_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_REMINDER_TITLE_CHARS,
  MAX_TASK_CHARS,
  MAX_TITLE_CHARS,
} from "./limits";
import { EFFORTS } from "./routing";
import type { ChatRequest } from "@/types/api";

const conversationId = z.uuid();

/**
 * The stored mode (decision 0014: one workspace). Request bodies may still send
 * it, for older tabs; the server writes WORKSPACE_MODE when it is absent.
 */
export const modeSchema = z.enum(["personal", "work"]);

/** "auto" lets the router choose; "deep" asks for the heavy tier. */
const effortSchema = z.enum(EFFORTS).optional();

/** An IANA time zone name from the browser. The server checks it again before use. */
const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_+\-/]+$/)
  .optional();

/** The composer's connector chips (decision 0011 amendment). Missing means off. */
const connectorsSchema = z.object({ google: z.boolean().optional() }).strict().optional();

// `.strict()` rejects unknown keys, so a client cannot smuggle in fields such
// as a user ID. Identity always comes from the verified session.
const sendSchema = z
  .object({
    action: z.literal("send"),
    conversationId: conversationId.optional(),
    mode: modeSchema.optional(),
    message: z
      .string()
      .trim()
      .min(1, "Message cannot be empty.")
      .max(MAX_MESSAGE_CHARS, `Message must be at most ${MAX_MESSAGE_CHARS} characters.`),
    webSearch: z.boolean(),
    effort: effortSchema,
    timeZone: timeZoneSchema,
    connectors: connectorsSchema,
  })
  .strict();

const retrySchema = z
  .object({
    action: z.literal("retry"),
    conversationId,
    webSearch: z.boolean(),
    effort: effortSchema,
    timeZone: timeZoneSchema,
    connectors: connectorsSchema,
  })
  .strict();

export const chatRequestSchema: z.ZodType<ChatRequest> = z.discriminatedUnion("action", [
  sendSchema,
  retrySchema,
]);

export const renameConversationSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "Name cannot be empty.")
      .max(MAX_TITLE_CHARS, `Name must be at most ${MAX_TITLE_CHARS} characters.`),
  })
  .strict();

const taskTitle = z
  .string()
  .trim()
  .min(1, "Task cannot be empty.")
  .max(MAX_TASK_CHARS, `Task must be at most ${MAX_TASK_CHARS} characters.`);

export const createTaskSchema = z.object({ mode: modeSchema.optional(), title: taskTitle }).strict();

export const updateTaskSchema = z
  .object({ title: taskTitle.optional(), done: z.boolean().optional() })
  .strict()
  .refine((value) => value.title !== undefined || value.done !== undefined, {
    message: "Nothing to update.",
  });

export const emailSchema = z.email("Enter a valid email address.").max(254);

// Supabase Auth (bcrypt) ignores bytes past 72, so cap there to avoid surprises.
export const newPasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .refine((value) => new TextEncoder().encode(value).length <= 72, {
    message: "Password must be at most 72 bytes.",
  });

// ---------------------------------------------------------------------------
// Memory, documents, action proposals and reminders (decision 0009).
// ---------------------------------------------------------------------------

const memoryContent = z
  .string()
  .trim()
  .min(1, "Memory cannot be empty.")
  .max(MAX_MEMORY_CHARS, `Memory must be at most ${MAX_MEMORY_CHARS} characters.`);

export const createMemorySchema = z.object({ mode: modeSchema.optional(), content: memoryContent }).strict();

/** Edit the text or mode, or approve a proposed memory (status "active"). */
export const updateMemorySchema = z
  .object({ content: memoryContent.optional(), mode: modeSchema.optional(), status: z.literal("active").optional() })
  .strict()
  .refine((v) => v.content !== undefined || v.mode !== undefined || v.status !== undefined, {
    message: "Nothing to update.",
  });

export const createDocumentSchema = z
  .object({
    mode: modeSchema.optional(),
    title: z
      .string()
      .trim()
      .min(1, "Title cannot be empty.")
      .max(MAX_DOCUMENT_TITLE_CHARS, `Title must be at most ${MAX_DOCUMENT_TITLE_CHARS} characters.`),
    mediaType: z.enum(["text/plain", "text/markdown"]),
    text: z
      .string()
      .min(1, "The document is empty.")
      .max(MAX_DOCUMENT_CHARS, `The document must be at most ${MAX_DOCUMENT_CHARS} characters.`)
      .refine((t) => t.trim().length > 0, { message: "The document is empty." }),
  })
  .strict();

const reminderTitle = z
  .string()
  .trim()
  .min(1, "Reminder cannot be empty.")
  .max(MAX_REMINDER_TITLE_CHARS, `Reminder must be at most ${MAX_REMINDER_TITLE_CHARS} characters.`);

/** An ISO 8601 date-time with a time zone offset, for example 2026-10-30T17:00:00Z. */
const dueAt = z.iso.datetime({ offset: true, message: "Use a date and time, for example 2026-10-30T17:00:00Z." });

export const createReminderSchema = z.object({ mode: modeSchema.optional(), title: reminderTitle, dueAt }).strict();

export const updateReminderSchema = z
  .object({
    title: reminderTitle.optional(),
    dueAt: dueAt.optional(),
    status: z.enum(["scheduled", "done", "cancelled"]).optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.dueAt !== undefined || v.status !== undefined, {
    message: "Nothing to update.",
  });

/**
 * The payload of an action proposal. Also used to validate an edited payload on approval.
 * `mode` stays required: normalize_action_payload in the database requires the key.
 */
export const actionPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create_task"), mode: modeSchema, title: taskTitle }).strict(),
  z.object({ kind: z.literal("create_reminder"), mode: modeSchema, title: reminderTitle, dueAt }).strict(),
  z.object({ kind: z.literal("save_memory"), mode: modeSchema, content: memoryContent }).strict(),
]);

/** POST /api/actions/:id/decision. An edited payload must keep the same kind. */
export const actionDecisionSchema = z
  .object({ decision: z.enum(["approve", "reject"]), payload: actionPayloadSchema.optional() })
  .strict()
  .refine((v) => v.decision === "approve" || v.payload === undefined, {
    message: "Only an approval can change the payload.",
  });

export const actionSummarySchema = z.string().trim().min(1).max(MAX_ACTION_SUMMARY_CHARS);
