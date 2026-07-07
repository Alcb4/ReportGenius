"use client";

import { useState, useEffect, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch, APIError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { isStatelessBuild } from "@/lib/stateless/mode";

interface LoginResponse {
  token: string;
}

export default function LoginPage() {
  const router = useRouter();
  const { login, enterStatelessMode } = useAuth();
  const statelessOnly = isStatelessBuild();

  // Only offer session-only entry when the deployment enabled it —
  // STATELESS_ENABLED is server-only, so ask the status endpoint.
  const [statelessAvailable, setStatelessAvailable] = useState(statelessOnly);
  useEffect(() => {
    if (statelessOnly) return;
    let cancelled = false;
    fetch("/api/v1/stateless/status")
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d: { enabled?: boolean }) => {
        if (!cancelled && d.enabled) setStatelessAvailable(true);
      })
      .catch(() => {
        // status unreachable — keep the button hidden
      });
    return () => {
      cancelled = true;
    };
  }, [statelessOnly]);

  function handleStatelessEntry() {
    enterStatelessMode();
    router.push("/dashboard");
  }

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const data = await apiFetch<LoginResponse>("/api/v1/auth/login", {
        method: "POST",
        body: { email, password },
      });
      login(data.token);
      router.push("/dashboard");
    } catch (err) {
      if (err instanceof APIError && err.status === 401) {
        setError("Invalid email or password.");
      } else if (err instanceof APIError) {
        setError(err.message);
      } else {
        setError("An unexpected error occurred. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">ReportGenius</h1>
          <p className="mt-2 text-gray-600">
            {statelessOnly ? "Session-only mode" : "Sign in to your account"}
          </p>
        </div>

        <div className="bg-white rounded-lg shadow-sm p-8 border border-gray-200">
          {!statelessOnly && (
          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
                placeholder="you@school.edu"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
                placeholder="Your password"
              />
            </div>

            {error && (
              <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>
          )}

          {statelessAvailable && (
          <div className={statelessOnly ? "" : "mt-6 pt-6 border-t border-gray-200"}>
            <button
              type="button"
              onClick={handleStatelessEntry}
              className="w-full rounded-md border border-indigo-600 bg-white px-4 py-2.5 text-sm font-semibold text-indigo-600 shadow-sm hover:bg-indigo-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 transition"
            >
              Continue without an account (session-only)
            </button>
            <p className="mt-2 text-center text-xs text-gray-500">
              Your data lives only in this browser tab and is gone when you close it.
            </p>
          </div>
          )}

          {!statelessOnly && (
          <p className="mt-6 text-center text-sm text-gray-600">
            Don&apos;t have an account?{" "}
            <Link
              href="/register"
              className="font-medium text-indigo-600 hover:text-indigo-500 transition"
            >
              Create one
            </Link>
          </p>
          )}
        </div>
      </div>
    </div>
  );
}
