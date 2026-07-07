"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
} from "react";
import { getToken, setToken, clearToken } from "@/lib/auth";
import { isStateless, enterStateless, exitStateless } from "@/lib/stateless/mode";

interface AuthContextValue {
  token: string | null;
  login: (token: string) => void;
  logout: () => void;
  isAuthenticated: boolean;
  /** True when running in stateless / session-only mode (no account, no DB). */
  isStatelessMode: boolean;
  /** Enter session-only mode without an account (sets the per-tab flag). */
  enterStatelessMode: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Safely read localStorage at call time. Returns null on the server or when
 * localStorage is unavailable.
 */
function readTokenOnce(): string | null {
  if (typeof window === "undefined") return null;
  return getToken();
}

function readStatelessOnce(): boolean {
  if (typeof window === "undefined") return false;
  return isStateless();
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Lazy initialisers run once on first render, client-side only.
  // This avoids both SSR mismatches and synchronous setState-in-effect.
  const [token, setTokenState] = useState<string | null>(readTokenOnce);
  const [statelessMode, setStatelessMode] = useState<boolean>(readStatelessOnce);

  const login = useCallback((newToken: string) => {
    setToken(newToken);
    setTokenState(newToken);
  }, []);

  const logout = useCallback(() => {
    if (statelessMode) {
      // "End session": wipe only this tab's session-only flag and store.
      // Do NOT clear the token — rg_token lives in localStorage shared
      // across tabs, and the user may be signed in to their real account
      // in another tab.
      exitStateless();
      setStatelessMode(isStateless()); // stays true for NEXT_PUBLIC_STATELESS builds
      return;
    }
    clearToken();
    setTokenState(null);
  }, [statelessMode]);

  const enterStatelessMode = useCallback(() => {
    enterStateless();
    setStatelessMode(true);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        token,
        login,
        logout,
        isAuthenticated: Boolean(token) || statelessMode,
        isStatelessMode: statelessMode,
        enterStatelessMode,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}
