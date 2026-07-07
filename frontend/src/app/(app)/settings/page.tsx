"use client";

import { useEffect, useState, FormEvent, useRef } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, APIError } from "@/lib/api";
import { clearToken } from "@/lib/auth";
import { useAuth } from "@/context/AuthContext";

type Provider = "openai" | "claude" | "grok" | "ollama";

interface SettingsResponse {
  org_name: string;
  llm_provider: Provider;
  model: string;
  has_api_key: boolean;
  masked_key?: string;
  ollama_url?: string;
}

interface TestResponse {
  success: boolean;
  provider: string;
  model: string;
  error?: string;
}

const PROVIDER_DEFAULTS: Record<Provider, string> = {
  openai: "gpt-4o-mini",
  claude: "claude-3-5-haiku-latest",
  grok: "grok-beta",
  ollama: "llama3.1:8b",
};

const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  claude: "Claude (Anthropic)",
  grok: "Grok (xAI)",
  ollama: "Ollama (Local)",
};

function SettingsSkeleton() {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 space-y-5 animate-pulse">
      <div className="h-5 bg-gray-200 rounded w-1/4" />
      <div className="h-10 bg-gray-100 rounded" />
      <div className="h-10 bg-gray-100 rounded" />
      <div className="h-10 bg-gray-100 rounded" />
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { logout, isStatelessMode } = useAuth();
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [provider, setProvider] = useState<Provider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(PROVIDER_DEFAULTS["openai"]);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [maskedKey, setMaskedKey] = useState<string | undefined>(undefined);
  const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showRestartBanner, setShowRestartBanner] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResponse | null>(null);

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    async function loadSettings() {
      try {
        const data = await apiFetch<SettingsResponse>("/api/v1/settings");
        setProvider(data.llm_provider);
        setModel(data.model);
        setHasApiKey(data.has_api_key);
        setMaskedKey(data.masked_key);
        if (data.ollama_url) setOllamaUrl(data.ollama_url);
      } catch (err) {
        if (err instanceof APIError) {
          setLoadError(err.message);
        } else {
          setLoadError("Failed to load settings.");
        }
      } finally {
        setLoadingSettings(false);
      }
    }

    loadSettings();
  }, []);

  // When provider changes, update the default model only if the current model
  // looks like a default from a different provider.
  function handleProviderChange(newProvider: Provider) {
    setProvider(newProvider);
    const currentDefault = Object.values(PROVIDER_DEFAULTS).find((m) => m === model);
    if (currentDefault !== undefined) {
      setModel(PROVIDER_DEFAULTS[newProvider]);
    }
    setTestResult(null);
  }

  async function handleSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaveError(null);
    setSaveSuccess(false);

    if (provider !== "ollama" && !apiKey.trim()) {
      setSaveError("Please enter an API key.");
      return;
    }

    setSaving(true);

    try {
      const body: Record<string, string> = { llm_provider: provider, model };
      if (provider === "ollama") {
        body.ollama_url = ollamaUrl.trim() || "http://localhost:11434";
      } else {
        body.api_key = apiKey;
      }
      await apiFetch("/api/v1/settings", { method: "PUT", body });
      setHasApiKey(true);
      setApiKey(""); // Clear after save — never show again.
      // Reload to get updated masked key from server
      const updated = await apiFetch<SettingsResponse>("/api/v1/settings");
      setMaskedKey(updated.masked_key);
      setSaveSuccess(true);
      setShowRestartBanner(true);
      setTimeout(() => setSaveSuccess(false), 4000);
    } catch (err) {
      if (err instanceof APIError) {
        setSaveError(err.message);
      } else {
        setSaveError("Failed to save settings.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);

    try {
      const result = await apiFetch<TestResponse>("/api/v1/settings/test");
      setTestResult(result);
    } catch (err) {
      if (err instanceof APIError) {
        setTestResult({
          success: false,
          provider,
          model,
          error: err.message,
        });
      } else {
        setTestResult({
          success: false,
          provider,
          model,
          error: "Connection test failed.",
        });
      }
    } finally {
      setTesting(false);
    }
  }

  async function handleDeleteAccount() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiFetch("/api/v1/account", { method: "DELETE" });
      clearToken();
      logout();
      router.replace("/login");
    } catch (err) {
      if (err instanceof APIError) {
        setDeleteError(err.message);
      } else {
        setDeleteError("Failed to delete account. Please try again.");
      }
      setDeleting(false);
    }
  }

  // Session-only mode: no per-org settings and no API keys — reports are
  // written via the free AI flow (copy prompt → paste response back).
  if (isStatelessMode) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        </div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 text-sm text-gray-600 space-y-2">
          <p className="font-medium text-gray-900">Session-only mode</p>
          <p>
            No API key is needed. Reports are written with the free AI flow: copy the
            prompt from the Generate tab, paste it into ChatGPT (or any AI tool), then
            paste the response back and the app saves the reports.
          </p>
          <p>
            Your classes, ratings, and reports live only in this browser tab. Export
            anything you want to keep before closing it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Configure your LLM provider to generate student reports.
        </p>
      </div>

      {loadError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 mb-6">
          {loadError}
        </div>
      )}

      {showRestartBanner && (
        <div className="rounded-lg bg-amber-50 border border-amber-300 px-4 py-3 text-sm text-amber-800 mb-6 flex items-center justify-between gap-3">
          <span>
            <strong>Restart required.</strong> Restart the backend worker for LLM changes to take effect.
          </span>
          <button
            onClick={() => setShowRestartBanner(false)}
            className="text-amber-600 hover:text-amber-800 transition shrink-0"
            aria-label="Dismiss"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {loadingSettings ? (
        <SettingsSkeleton />
      ) : (
        <>
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-5">
              LLM Configuration
            </h2>

            <form onSubmit={handleSave} noValidate className="space-y-5">
              {/* Provider */}
              <div>
                <label
                  htmlFor="provider"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  LLM Provider
                </label>
                <select
                  id="provider"
                  value={provider}
                  onChange={(e) => handleProviderChange(e.target.value as Provider)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition bg-white"
                >
                  {(Object.entries(PROVIDER_LABELS) as [Provider, string][]).map(
                    ([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    )
                  )}
                </select>
              </div>

              {/* API Key — hidden for Ollama */}
              {provider !== "ollama" ? (
                <div>
                  <label
                    htmlFor="api_key"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    API Key
                    {maskedKey && (
                      <span className="ml-2 text-xs font-normal text-green-600 font-mono">
                        {maskedKey}
                      </span>
                    )}
                  </label>
                  <input
                    id="api_key"
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
                    placeholder={
                      hasApiKey ? "Enter new key to replace saved key" : "sk-..."
                    }
                  />
                  <p className="mt-1 text-xs text-gray-400">
                    Encrypted at rest. Only the last 4 characters are shown above.
                  </p>
                </div>
              ) : (
                <div>
                  <label
                    htmlFor="ollama_url"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Ollama URL
                  </label>
                  <input
                    id="ollama_url"
                    type="text"
                    value={ollamaUrl}
                    onChange={(e) => setOllamaUrl(e.target.value)}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
                    placeholder="http://localhost:11434"
                  />
                  <p className="mt-1 text-xs text-gray-400">
                    No API key required. Make sure Ollama is running locally.
                  </p>
                </div>
              )}

              {/* Model */}
              <div>
                <label
                  htmlFor="model"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Model
                </label>
                <input
                  id="model"
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
                  placeholder={PROVIDER_DEFAULTS[provider]}
                />
                <p className="mt-1 text-xs text-gray-400">
                  Default: {PROVIDER_DEFAULTS[provider]}
                </p>
              </div>

              {saveError && (
                <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                  {saveError}
                </p>
              )}

              {saveSuccess && (
                <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">
                  Settings saved successfully.
                </p>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  {saving ? "Saving..." : "Save settings"}
                </button>

                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testing || (!hasApiKey && provider !== "ollama")}
                  className="px-5 py-2.5 rounded-md border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  {testing ? "Testing..." : "Test connection"}
                </button>
              </div>
            </form>
          </div>

          {/* Test result */}
          {testResult && (
            <div
              className={`rounded-lg border px-4 py-3 text-sm mb-6 ${
                testResult.success
                  ? "bg-green-50 border-green-200 text-green-800"
                  : "bg-red-50 border-red-200 text-red-800"
              }`}
            >
              {testResult.success ? (
                <span>
                  Connected to <strong>{PROVIDER_LABELS[testResult.provider as Provider] ?? testResult.provider}</strong> ({testResult.model}) successfully.
                </span>
              ) : (
                <span>
                  Connection failed: {testResult.error ?? "Unknown error."}
                </span>
              )}
            </div>
          )}

          {!hasApiKey && provider !== "ollama" && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
              No API key configured yet. Save your settings above to enable report generation.
            </div>
          )}

          {/* Danger Zone */}
          <div className="mt-8 rounded-lg border border-red-200 p-6">
            <h2 className="text-sm font-semibold text-red-700 uppercase tracking-wide mb-2">
              Danger Zone
            </h2>
            <p className="text-sm text-gray-600 mb-4">
              Permanently delete your account and all associated data including students, sessions, and reports.
              This action cannot be undone.
            </p>
            <button
              type="button"
              onClick={() => {
                setDeleteConfirm("");
                setDeleteError(null);
                setShowDeleteModal(true);
                setTimeout(() => deleteInputRef.current?.focus(), 50);
              }}
              className="px-4 py-2 rounded-md border border-red-300 bg-white text-sm font-medium text-red-600 hover:bg-red-50 transition"
            >
              Delete my account
            </button>
          </div>
        </>
      )}

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Delete account</h2>
            <p className="text-sm text-gray-600 mb-4">
              This will permanently delete your account, organisation, all students, sessions, reports, and settings.
              <strong className="text-gray-900"> This cannot be undone.</strong>
            </p>
            <p className="text-sm text-gray-700 mb-2">
              Type <strong>DELETE</strong> to confirm:
            </p>
            <input
              ref={deleteInputRef}
              type="text"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono text-gray-900 focus:border-red-500 focus:ring-1 focus:ring-red-500 outline-none transition mb-4"
              placeholder="DELETE"
            />
            {deleteError && (
              <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded-md px-3 py-2 mb-4">
                {deleteError}
              </p>
            )}
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
                className="px-4 py-2 rounded-md border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteAccount}
                disabled={deleteConfirm !== "DELETE" || deleting}
                className="px-4 py-2 rounded-md bg-red-600 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                {deleting ? "Deleting..." : "Delete account"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
