// Browser-side helpers for calling P-Dot's own API routes. No secrets here.
import type { ApiErrorBody, ApiErrorCode } from "@/types/api";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode | "network_error",
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (body.error?.message) return new ApiError(response.status, body.error.code, body.error.message);
  } catch {
    // Non-JSON error page (e.g. a platform timeout).
  }
  return new ApiError(response.status, "internal_error", "Something went wrong. Please retry.");
}

/** Same-origin fetch that throws ApiError for network failures and non-2xx responses. */
export async function apiRequest(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "network_error", "Could not reach the server; check your connection and retry.");
  }
  if (!response.ok) throw await toApiError(response);
  return response;
}

/** Sends `body` as JSON with the given method and returns the parsed JSON reply. */
export async function sendJson<T>(path: string, method: "POST" | "PATCH", body: unknown): Promise<T> {
  const response = await apiRequest(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as T;
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await apiRequest(path, { signal });
  return (await response.json()) as T;
}

export async function deleteResource(path: string): Promise<void> {
  await apiRequest(path, { method: "DELETE" });
}

/** A user-facing message for any error thrown by these helpers. */
export function errorMessage(error: unknown, fallback = "Something went wrong. Please retry."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
