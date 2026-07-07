"use client";

/**
 * GenerateReportsPanel — "Generate Reports" tab content.
 *
 * Two paths for generating reports:
 *   A. API Path    — calls the existing bulk-generate endpoint
 *   B. Free Model  — copies a batch prompt to clipboard for use in
 *                    ChatGPT/Gemini/Grok, then parses + saves the response
 *
 * Props:
 *   sessionId  — the current report session ID
 *   students   — full student list from the session
 */

import { useState, useEffect, useCallback } from "react";
import { apiFetch, APIError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Student {
  id: string;
  first_name: string;
  last_name: string | null;
  student_ref_id: string | null;
  gender: string | null;
}

interface ParseResult {
  studentId: string;
  name: string;
  success: boolean;
  error?: string;
}

interface ParseSummary {
  saved: number;
  failed: number;
}

interface GenerateReportsPanelProps {
  sessionId: string;
  students: Student[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function studentDisplayName(s: Student): string {
  return s.last_name ? `${s.first_name} ${s.last_name}` : s.first_name;
}

/** Fisher-Yates shuffle — returns a new shuffled array. */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function GenerateReportsPanel({
  sessionId,
  students,
}: GenerateReportsPanelProps) {
  // Session-only mode has no server-side LLM key — only the free-model path
  const { isStatelessMode } = useAuth();

  // Which students already have a saved report
  const [generatedStudentIds, setGeneratedStudentIds] = useState<Set<string>>(
    new Set()
  );

  // Current batch of 5 for the free-model path
  const [batchStudents, setBatchStudents] = useState<Student[]>([]);

  // Free-model paste area
  const [pasteValue, setPasteValue] = useState("");

  // Copy-to-clipboard state
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");

  // Parsing state
  const [parseStatus, setParseStatus] = useState<
    "idle" | "parsing" | "success" | "error"
  >("idle");
  const [parseResults, setParseResults] = useState<ParseResult[]>([]);
  const [parseSummary, setParseSummary] = useState<ParseSummary | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // Bulk API generation state
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkBatchId, setBulkBatchId] = useState<string | null>(null);

  // ── Load existing reports on mount ─────────────────────────────────────────

  const loadExisting = useCallback(async () => {
    try {
      interface ReportsResponse {
        reports: Array<{ student_id: string }>;
      }
      const result = await apiFetch<ReportsResponse>(
        `/api/v1/sessions/${sessionId}/reports`
      );
      setGeneratedStudentIds(
        new Set(result.reports.map((r) => r.student_id))
      );
    } catch {
      // Non-fatal — empty set means all need generating
    }
  }, [sessionId]);

  useEffect(() => {
    const t = setTimeout(() => { void loadExisting(); }, 0);
    return () => clearTimeout(t);
  }, [loadExisting]);

  // ── Build initial batch whenever generatedStudentIds or students change ─────

  useEffect(() => {
    const remaining = students
      .filter((s) => !generatedStudentIds.has(s.id))
      .sort((a, b) =>
        studentDisplayName(a).localeCompare(studentDisplayName(b))
      );
    const t = setTimeout(() => { setBatchStudents(remaining.slice(0, 5)); }, 0);
    return () => clearTimeout(t);
  }, [students, generatedStudentIds]);

  // ── New Batch — pick a different 5 from the remaining pool ─────────────────

  function handleNewBatch() {
    const remaining = students.filter((s) => !generatedStudentIds.has(s.id));
    const shuffled = shuffle(remaining);
    setBatchStudents(shuffled.slice(0, 5));
  }

  // ── Bulk API generation ─────────────────────────────────────────────────────

  async function handleApiGenerate() {
    const targets = students.filter((s) => !generatedStudentIds.has(s.id));
    if (targets.length === 0) return;

    setBulkRunning(true);
    setBulkError(null);

    try {
      interface BulkResponse {
        batchId: string;
      }
      const result = await apiFetch<BulkResponse>(
        `/api/v1/sessions/${sessionId}/generate/bulk`,
        {
          method: "POST",
          body: {
            studentIds: targets.map((s) => s.id),
          },
        }
      );
      setBulkBatchId(result.batchId);
    } catch (err) {
      setBulkError(
        err instanceof APIError ? err.message : "Failed to start generation."
      );
      setBulkRunning(false);
    }
  }

  // ── Copy batch prompt to clipboard ─────────────────────────────────────────

  async function handleCopyPrompt() {
    if (batchStudents.length === 0) return;

    try {
      interface PromptResponse {
        prompt: string;
      }
      const params = new URLSearchParams();
      for (const s of batchStudents) {
        params.append("studentIds", s.id);
      }
      const result = await apiFetch<PromptResponse>(
        `/api/v1/sessions/${sessionId}/batch-prompt?${params.toString()}`
      );

      await navigator.clipboard.writeText(result.prompt);
      setCopyStatus("copied");
      setTimeout(() => setCopyStatus("idle"), 2000);
    } catch (err) {
      setBulkError(
        err instanceof APIError ? err.message : "Failed to fetch prompt."
      );
    }
  }

  // ── Parse + save pasted LLM response ───────────────────────────────────────

  async function handleParse() {
    if (!pasteValue.trim()) return;

    setParseStatus("parsing");
    setParseError(null);
    setParseResults([]);
    setParseSummary(null);

    try {
      interface ParseResponse {
        results: ParseResult[];
        saved: number;
        failed: number;
      }
      const result = await apiFetch<ParseResponse>(
        `/api/v1/sessions/${sessionId}/parse-reports`,
        {
          method: "POST",
          body: {
            raw: pasteValue,
            studentIds: batchStudents.map((s) => s.id),
          },
        }
      );

      setParseResults(result.results);
      // Use server-reported saved/failed counts — these reflect actual DB writes,
      // not a local count derived from the response array length.
      setParseSummary({ saved: result.saved, failed: result.failed });
      setParseStatus("success");

      // Mark successfully saved students as generated (driven by server results)
      const savedIds = new Set(
        result.results.filter((r) => r.success).map((r) => r.studentId)
      );
      setGeneratedStudentIds((prev) => {
        const next = new Set(prev);
        for (const id of savedIds) next.add(id);
        return next;
      });

      // Clear paste area only when all reports saved without error
      if (result.failed === 0) {
        setPasteValue("");
      }
    } catch (err) {
      setParseStatus("error");
      setParseError(
        err instanceof APIError ? err.message : "Failed to parse response."
      );
    }
  }

  // ── Derived counts ──────────────────────────────────────────────────────────

  const totalStudents = students.length;
  const generatedCount = generatedStudentIds.size;
  const remainingCount = Math.max(0, totalStudents - generatedCount);
  const progressPct =
    totalStudents > 0 ? Math.round((generatedCount / totalStudents) * 100) : 0;
  const ungeneratedForBulk = students.filter(
    (s) => !generatedStudentIds.has(s.id)
  );

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Progress bar */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm px-5 py-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-700">
            Reports generated: {generatedCount} / {totalStudents}
          </span>
          <span className="text-xs text-gray-400">{progressPct}%</span>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
          <div
            className="h-2 rounded-full bg-indigo-600 transition-all duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Section A — API Path + divider (hidden in session-only mode: no server LLM key) */}
      {!isStatelessMode && (
      <>
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm px-6 py-5">
        <h2 className="text-base font-semibold text-gray-900 mb-1">
          Generate with API
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          Uses your configured LLM API key to generate all remaining reports
          automatically.
        </p>

        {bulkError && (
          <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {bulkError}
          </div>
        )}

        {bulkBatchId && (
          <div className="mb-3 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">
            Bulk generation started (batch {bulkBatchId.slice(0, 8)}...). Reports
            will appear in the Reports tab as they complete.
          </div>
        )}

        <button
          onClick={handleApiGenerate}
          disabled={bulkRunning || ungeneratedForBulk.length === 0}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition shadow-sm"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
          {bulkRunning
            ? "Starting..."
            : ungeneratedForBulk.length === 0
            ? "All reports generated"
            : `Generate All Remaining (${ungeneratedForBulk.length})`}
        </button>
      </div>

      {/* Divider */}
      <div className="relative flex items-center">
        <div className="flex-1 border-t border-gray-200" />
        <span className="mx-4 text-sm text-gray-400 bg-gray-50 px-2">or</span>
        <div className="flex-1 border-t border-gray-200" />
      </div>
      </>
      )}

      {/* Section B — Free Model Path */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm px-6 py-5">
        <h2 className="text-base font-semibold text-gray-900 mb-1">
          Free Model
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          Use ChatGPT, Gemini, or Grok. Copy the prompt below, paste it into
          your preferred AI tool, then paste the response back here.
        </p>

        {remainingCount === 0 ? (
          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-4 py-3">
            <svg
              className="w-4 h-4 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 13l4 4L19 7"
              />
            </svg>
            All reports generated
          </div>
        ) : (
          <>
            {/* Current batch chips */}
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  Current batch ({batchStudents.length} students)
                </span>
                <button
                  onClick={handleNewBatch}
                  className="text-xs text-indigo-600 hover:text-indigo-800 font-medium transition"
                >
                  New Batch
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {batchStudents.map((s) => (
                  <span
                    key={s.id}
                    className="inline-flex items-center px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 text-xs font-medium"
                  >
                    {studentDisplayName(s)}
                  </span>
                ))}
                {batchStudents.length === 0 && (
                  <span className="text-xs text-gray-400">
                    No students remaining.
                  </span>
                )}
              </div>
            </div>

            {/* Copy prompt button */}
            <button
              onClick={handleCopyPrompt}
              disabled={batchStudents.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition mb-3"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
              {copyStatus === "copied"
                ? "Copied!"
                : "Copy Prompt for this Batch"}
            </button>

            <p className="text-xs text-gray-400 mb-4">
              Paste this into ChatGPT, Gemini, or Grok. Copy the full response
              and paste it below.
            </p>

            <p className="text-xs text-indigo-600 bg-indigo-50 border border-indigo-100 rounded-md px-3 py-2 mb-4">
              Student names are replaced with temporary aliases for privacy during AI generation.
            </p>

            {/* Paste area */}
            <textarea
              value={pasteValue}
              onChange={(e) => setPasteValue(e.target.value)}
              rows={10}
              placeholder="Paste the LLM response here..."
              className="w-full rounded-md border border-gray-300 px-3 py-2.5 text-sm font-mono text-gray-800 placeholder:text-gray-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition mb-3 resize-y"
            />

            {/* Parse button */}
            <button
              onClick={handleParse}
              disabled={
                parseStatus === "parsing" || !pasteValue.trim()
              }
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition shadow-sm mb-4"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                />
              </svg>
              {parseStatus === "parsing" ? "Parsing..." : "Parse & Save Reports"}
            </button>

            {/* Parse error */}
            {parseStatus === "error" && parseError && (
              <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                {parseError}
              </div>
            )}

            {/* Parse results — summary banner (server counts) + per-row detail */}
            {parseSummary !== null && (
              <div
                className={`mb-3 flex items-center gap-3 px-4 py-2.5 rounded-md text-sm font-medium border ${
                  parseSummary.failed === 0
                    ? "bg-green-50 border-green-200 text-green-800"
                    : parseSummary.saved === 0
                    ? "bg-red-50 border-red-200 text-red-800"
                    : "bg-yellow-50 border-yellow-200 text-yellow-800"
                }`}
              >
                <span>Saved: {parseSummary.saved}</span>
                {parseSummary.failed > 0 && (
                  <span className="text-red-700">Failed: {parseSummary.failed}</span>
                )}
              </div>
            )}
            {parseResults.length > 0 && (
              <div className="space-y-1">
                {parseResults.map((r) => (
                  <div
                    key={r.studentId}
                    className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded-md ${
                      r.success
                        ? "bg-green-50 text-green-700"
                        : "bg-red-50 text-red-700"
                    }`}
                  >
                    <span className="font-medium">{r.success ? "Saved" : "Failed"}:</span>
                    <span>{r.name}</span>
                    {r.error && (
                      <span className="text-xs opacity-70 ml-1">({r.error})</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
