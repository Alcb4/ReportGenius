/**
 * API client for ReportGenius frontend.
 *
 * All requests use same-origin relative URLs (Next.js API routes under /api/v1).
 * JWT is read from localStorage on each request so token changes take effect
 * immediately without needing a page reload.
 *
 * In stateless / session-only mode (see lib/stateless/mode.ts) requests are
 * intercepted before hitting the network and served by an in-browser router
 * backed by sessionStorage (lib/stateless/localApi.ts).
 */

import { isStateless } from "./stateless/mode";

const API_BASE = "";
const TOKEN_KEY = "rg_token";

// ── Error type ─────────────────────────────────────────────────────────────────

export class APIError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "APIError";
    this.code = code;
    this.status = status;
  }
}

// ── Token helpers (safe for SSR — guarded by typeof window) ───────────────────

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

// ── Core fetch wrapper ─────────────────────────────────────────────────────────

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
}

export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {}
): Promise<T> {
  // Session-only mode: serve /api/v1/* from the in-browser store. The
  // dynamic import keeps the stateless bundle out of normal-mode pages.
  // Auth routes are never intercepted — a user in a session-only tab must
  // still be able to sign in / register (which exits stateless mode).
  if (
    isStateless() &&
    typeof window !== "undefined" &&
    path.startsWith("/api/v1/") &&
    !path.startsWith("/api/v1/stateless/") &&
    !path.startsWith("/api/v1/auth/")
  ) {
    const { handleLocal } = await import("./stateless/localApi");
    const method = (options.method ?? "GET").toUpperCase();
    const result = await handleLocal(method, path, options.body);
    if (result.status >= 400) {
      const errBody = result.json as { error?: string; code?: string };
      throw new APIError(
        errBody.error ?? `HTTP ${result.status}`,
        errBody.code ?? "HTTP_ERROR",
        result.status
      );
    }
    return result.json as T;
  }

  const token = getToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const { body, ...rest } = options;

  const response = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;
    let errorCode = "HTTP_ERROR";

    try {
      const errorBody = (await response.json()) as {
        error?: string;
        code?: string;
      };
      if (errorBody.error) errorMessage = errorBody.error;
      if (errorBody.code) errorCode = errorBody.code;
    } catch {
      // Response body was not JSON — use the status text.
      errorMessage = response.statusText || errorMessage;
    }

    throw new APIError(errorMessage, errorCode, response.status);
  }

  // 204 No Content — return empty object cast to T.
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}
