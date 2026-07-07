/**
 * Stateless / session-only mode flag.
 *
 * Two activation paths:
 *  - Build-time: NEXT_PUBLIC_STATELESS=true forces the whole deployment stateless.
 *  - Per-tab: sessionStorage flag set by the "Continue without an account"
 *    button on the login page (survives navigation, dies with the tab).
 */

const FLAG_KEY = "rg_stateless";
export const STATELESS_DB_KEY = "rg_stateless_db";

export function isStatelessBuild(): boolean {
  return process.env.NEXT_PUBLIC_STATELESS === "true";
}

export function isStateless(): boolean {
  if (isStatelessBuild()) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function enterStateless(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(FLAG_KEY, "1");
}

export function exitStateless(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(FLAG_KEY);
    window.sessionStorage.removeItem(STATELESS_DB_KEY);
  } catch {
    // best effort — leaving stale data behind is harmless
  }
}
