"use client";

/**
 * Session detail page.
 *
 * Tabs:
 *   1. Ratings — full filter panel (tone, disciplines, tests, progression, class overview)
 *                above the RatingsGrid.
 *   2. Reports  — table of per-student report statuses with Generate / Edit / View links.
 *   3. Generate — BullMQ bulk generation panel.
 *
 * All filter state is auto-saved to the session via PUT /api/v1/sessions/:sessionId
 * (debounced 600 ms).
 *
 * Multi-tenant: all requests carry JWT; API enforces org isolation.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch, APIError } from "@/lib/api";
import { downloadExport as downloadWithAuth } from "@/lib/download";
import RatingsGrid, {
  GridDiscipline,
  GridStudent,
  GridReport,
} from "@/components/RatingsGrid";
import GenerateReportsPanel from "@/components/GenerateReportsPanel";
import CompactFilterBar, {
  FilterBarSession,
  FilterBarPatch,
  ClassTest as FilterBarClassTest,
  ProgressionData as FilterBarProgressionData,
} from "@/components/CompactFilterBar";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Discipline {
  id: string;
  name: string;
  category: string | null;
  is_custom: boolean;
  created_at: string;
}

interface TestFilterState {
  includeMark: boolean;
  includePercentage: boolean;
  includeGrade: boolean;
  includeLowMention: boolean;
}

interface SessionDetail {
  id: string;
  class_id: string;
  name: string;
  topics_covered: string[];
  tone: string;
  length: string;
  status: string;
  is_template: boolean;
  source_template_id: string | null;
  test_filters: Record<string, TestFilterState> | null;
  progression_filters: string[];
  enable_progression: boolean;
  allow_negative_progression: boolean;
  class_overview: string | null;
  created_at: string;
  updated_at: string;
}

interface ClassTest {
  id: string;
  name: string;
  max_mark: number;
  topics: string[];
  _count: { results: number };
}

interface MatchedDisciplineProgression {
  name: string;
  currentScore: number;
  previousScore: number;
  trend: "improved" | "declined" | "maintained";
}

interface ProgressionData {
  previousSession: { id: string; name: string; completed_at: string } | null;
  matchedDisciplines: MatchedDisciplineProgression[];
}

interface SessionDetailResponse {
  data: {
    session: SessionDetail;
    students: GridStudent[];
    disciplines: Discipline[];
  };
}

interface ClassMeta {
  id: string;
  name: string;
  year_group: string | null;
  subject: string | null;
}

interface ClassDetailResponse {
  data: ClassMeta;
}

interface OrgClass {
  id: string;
  name: string;
  year_group: string | null;
  subject: string | null;
  archived: boolean;
  _count: { students: number; sessions: number };
}

interface ClassesListResponse {
  data: OrgClass[];
}

// ── DuplicateToClassModal ─────────────────────────────────────────────────────

function DuplicateToClassModal({
  sessionName,
  currentClassId,
  onConfirm,
  onCancel,
}: {
  sessionName: string;
  currentClassId: string;
  onConfirm: (targetClassId: string, targetClassName: string) => void;
  onCancel: () => void;
}) {
  const [classes, setClasses] = useState<OrgClass[]>([]);
  const [loadingClasses, setLoadingClasses] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchClasses() {
      try {
        const result = await apiFetch<ClassesListResponse>("/api/v1/classes");
        if (!cancelled) {
          // Show non-archived classes; keep current class in the list
          setClasses(result.data.filter((c) => !c.archived));
        }
      } catch (err) {
        if (!cancelled) {
          setFetchError(
            err instanceof APIError ? err.message : "Failed to load classes."
          );
        }
      } finally {
        if (!cancelled) setLoadingClasses(false);
      }
    }
    fetchClasses();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedClass = classes.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">
            Duplicate Session
          </h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Copying &ldquo;{sessionName}&rdquo;
          </p>
        </div>

        {/* Class list */}
        <div className="flex-1 overflow-y-auto px-6 py-3">
          {loadingClasses && (
            <div className="space-y-2 animate-pulse py-2">
              {[1, 2, 3].map((n) => (
                <div key={n} className="h-12 bg-gray-100 rounded-md" />
              ))}
            </div>
          )}
          {fetchError && (
            <p className="text-sm text-red-600 py-3">{fetchError}</p>
          )}
          {!loadingClasses && !fetchError && classes.length === 0 && (
            <p className="text-sm text-gray-400 py-3">No classes found.</p>
          )}
          {!loadingClasses && !fetchError && classes.length > 0 && (
            <ul className="space-y-1">
              {classes.map((cls) => {
                const isCurrentClass = cls.id === currentClassId;
                const isSelected = cls.id === selectedId;
                return (
                  <li key={cls.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(cls.id)}
                      className={`w-full text-left px-4 py-3 rounded-lg border transition ${
                        isSelected
                          ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500"
                          : "border-gray-200 hover:bg-gray-50"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-gray-900 truncate">
                            {cls.name}
                          </span>
                          {isCurrentClass && (
                            <span className="ml-2 text-xs text-indigo-500 font-medium">
                              (this class)
                            </span>
                          )}
                          <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-400">
                            {cls.year_group && (
                              <span>Year {cls.year_group}</span>
                            )}
                            {cls.year_group && cls.subject && (
                              <span>·</span>
                            )}
                            {cls.subject && <span>{cls.subject}</span>}
                          </div>
                        </div>
                        <span className="text-xs text-gray-400 whitespace-nowrap">
                          {cls._count.students}{" "}
                          {cls._count.students === 1 ? "student" : "students"}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (selectedClass) onConfirm(selectedClass.id, selectedClass.name);
            }}
            disabled={!selectedId}
            className="px-4 py-2 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {selectedClass
              ? `Duplicate to ${selectedClass.name}`
              : "Duplicate to \u2026"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── EditSessionModal ──────────────────────────────────────────────────────────

function EditSessionModal({
  session,
  reportCount,
  onSave,
  onCancel,
  onRequestDelete,
}: {
  session: SessionDetail;
  reportCount: number;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
  onRequestDelete: () => void;
}) {
  const [name, setName] = useState(session.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Session name is required.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save changes.");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 flex flex-col">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Edit Session</h2>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Session name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSave();
                }
              }}
              autoFocus
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
            />
            {error && <p className="mt-1.5 text-sm text-red-600">{error}</p>}
          </div>
        </div>

        {/* Footer buttons */}
        <div className="px-6 pb-4 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="px-4 py-2 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>

        {/* Danger zone */}
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Danger Zone
          </p>
          <button
            type="button"
            onClick={onRequestDelete}
            className="w-full px-4 py-2 rounded-md border border-red-300 text-sm font-medium text-red-600 hover:bg-red-50 transition"
          >
            Delete Session
          </button>
          <p className="mt-1.5 text-xs text-gray-400">
            Permanently deletes this session and all {reportCount}{" "}
            {reportCount === 1 ? "report" : "reports"}.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── DeleteSessionConfirmModal ─────────────────────────────────────────────────

function DeleteSessionConfirmModal({
  sessionName,
  reportCount,
  deleting,
  onConfirm,
  onCancel,
}: {
  sessionName: string;
  reportCount: number;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
        <h2 className="text-base font-semibold text-gray-900 mb-3">
          Delete Session?
        </h2>
        <p className="text-sm text-gray-600 mb-6">
          This will permanently delete &ldquo;{sessionName}&rdquo; and all{" "}
          {reportCount} {reportCount === 1 ? "report" : "reports"}. This cannot
          be undone.
        </p>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="px-4 py-2 rounded-md bg-red-600 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 transition"
          >
            {deleting ? "Deleting..." : "Delete Session"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface RatingsResponse {
  students: GridStudent[];
  disciplines: GridDiscipline[];
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ExportButton({
  label,
  url,
  filename,
  icon,
}: {
  label: string;
  url: string;
  filename: string;
  icon: "download" | "spreadsheet";
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleClick() {
    setBusy(true);
    setErr(null);
    try {
      await downloadWithAuth(url, filename);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={handleClick}
        disabled={busy}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition"
      >
        {icon === "download" ? (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        )}
        {busy ? "Exporting..." : label}
      </button>
      {err && <span className="text-xs text-red-600">{err}</span>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: "bg-gray-100 text-gray-600",
    in_progress: "bg-yellow-100 text-yellow-700",
    complete: "bg-green-100 text-green-700",
  };
  const cls = map[status] ?? "bg-gray-100 text-gray-600";
  const label =
    status === "in_progress"
      ? "In Progress"
      : status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}
    >
      {label}
    </span>
  );
}

function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  confirmLabel = "Confirm",
  danger = false,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  danger?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
        <p className="text-sm text-gray-700 mb-5">{message}</p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-md text-sm font-semibold text-white transition ${
              danger ? "bg-red-600 hover:bg-red-700" : "bg-indigo-600 hover:bg-indigo-700"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddDisciplineModal({
  sessionId,
  onClose,
  onAdded,
}: {
  sessionId: string;
  onClose: () => void;
  onAdded: (discipline: Discipline) => void;
}) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Discipline name is required.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      interface AddDisciplineResponse {
        data: Discipline;
      }
      const result = await apiFetch<AddDisciplineResponse>(
        `/api/v1/sessions/${sessionId}/disciplines`,
        { method: "POST", body: { name: trimmed } }
      );
      onAdded(result.data);
    } catch (err) {
      setError(
        err instanceof APIError ? err.message : "Failed to add discipline."
      );
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-4">
          Add Discipline
        </h2>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder="e.g. Drama"
          autoFocus
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition mb-3"
        />
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={loading || !name.trim()}
            className="px-4 py-2 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition"
          >
            {loading ? "Adding..." : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionSkeleton() {
  return (
    <div className="max-w-6xl mx-auto animate-pulse space-y-6">
      <div className="h-4 bg-gray-200 rounded w-64 mb-2" />
      <div className="h-8 bg-gray-200 rounded w-1/3" />
      <div className="flex gap-2">
        {[1, 2, 3].map((n) => (
          <div key={n} className="h-6 bg-gray-100 rounded-full w-20" />
        ))}
      </div>
      <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-3">
        <div className="h-5 bg-gray-200 rounded w-1/4" />
        {[1, 2, 3, 4].map((n) => (
          <div key={n} className="h-12 bg-gray-100 rounded" />
        ))}
      </div>
    </div>
  );
}

// ── Reports Tab component ──────────────────────────────────────────────────────

function ReportsTab({
  classId,
  sessionId,
  gridStudents,
  reports,
  apiUrl,
}: {
  classId: string;
  sessionId: string;
  gridStudents: GridStudent[];
  reports: Map<string, GridReport>;
  apiUrl: string;
}) {
  const [exportError, setExportError] = useState<string | null>(null);

  async function handleExport(type: "pdf" | "csv") {
    setExportError(null);
    try {
      const ext = type === "pdf" ? "zip" : "xlsx";
      await downloadWithAuth(
        `${apiUrl}/api/v1/sessions/${sessionId}/export/${type}`,
        `session_reports.${ext}`
      );
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed.");
    }
  }

  // Find first student whose report is not final, fall back to first student.
  const firstNonFinalStudentId =
    gridStudents.find((s) => {
      const r = reports.get(s.id);
      return !r || r.status !== "final";
    })?.id ?? gridStudents[0]?.id;

  function reportStatusLabel(status: string | undefined): {
    label: string;
    cls: string;
  } {
    if (!status) return { label: "No Report", cls: "text-gray-400" };
    if (status === "final") return { label: "Final", cls: "text-green-600 font-medium" };
    if (status === "draft") return { label: "Draft", cls: "text-yellow-600 font-medium" };
    if (status === "edited") return { label: "Edited", cls: "text-blue-600 font-medium" };
    return { label: status, cls: "text-gray-500" };
  }

  function actionLabel(status: string | undefined): string {
    if (!status) return "Generate";
    if (status === "final") return "View";
    return "Edit";
  }

  return (
    <div className="space-y-4">
      {/* Bulk actions bar */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm px-5 py-3 flex items-center gap-3 flex-wrap">
        {firstNonFinalStudentId && (
          <Link
            href={`/classes/${classId}/sessions/${sessionId}/review?student=${firstNonFinalStudentId}`}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 transition"
          >
            Review All Reports
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        )}
        <button
          onClick={() => handleExport("pdf")}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
        >
          Export PDF
        </button>
        <button
          onClick={() => handleExport("csv")}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
        >
          Export XLSX
        </button>
        {exportError && (
          <span className="text-xs text-red-600">{exportError}</span>
        )}
      </div>

      {/* Reports table */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        {gridStudents.length === 0 ? (
          <p className="px-5 py-8 text-sm text-gray-400 text-center">No students in this session.</p>
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Student</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Words</th>
                <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {gridStudents.map((student) => {
                const report = reports.get(student.id);
                const { label, cls } = reportStatusLabel(report?.status);
                const action = actionLabel(report?.status);
                const reviewHref = `/classes/${classId}/sessions/${sessionId}/review?student=${student.id}`;
                return (
                  <tr key={student.id} className="hover:bg-gray-50 transition">
                    <td className="px-5 py-3 font-medium text-gray-800">
                      {student.first_name}
                      {student.last_name ? ` ${student.last_name}` : ""}
                      {student.student_ref_id && (
                        <span className="ml-2 text-xs text-gray-400">#{student.student_ref_id}</span>
                      )}
                    </td>
                    <td className={`px-5 py-3 ${cls}`}>{label}</td>
                    <td className="px-5 py-3 text-gray-500">
                      {report?.word_count != null ? report.word_count : "—"}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={reviewHref}
                        className="inline-flex items-center px-3 py-1 rounded border border-indigo-300 text-xs font-medium text-indigo-600 hover:bg-indigo-50 transition"
                      >
                        {action}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SessionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const classId =
    typeof params.id === "string" ? params.id : (params.id?.[0] ?? "");
  const sessionId =
    typeof params.sessionId === "string"
      ? params.sessionId
      : (params.sessionId?.[0] ?? "");

  // Session / class metadata
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [disciplines, setDisciplines] = useState<Discipline[]>([]);
  const [classMeta, setClassMeta] = useState<ClassMeta | null>(null);

  // Grid data (loaded separately from ratings endpoint)
  const [gridStudents, setGridStudents] = useState<GridStudent[]>([]);
  const [gridDisciplines, setGridDisciplines] = useState<GridDiscipline[]>([]);

  // Reports map (student_id → report)
  const [reports, setReports] = useState<Map<string, GridReport>>(new Map());

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [activeTab, setActiveTab] = useState<"ratings" | "reports" | "generate">("ratings");
  const [showAddDiscipline, setShowAddDiscipline] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [showStatusConfirm, setShowStatusConfirm] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  // Edit / Delete modal state
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Tests (class-level)
  const [classTests, setClassTests] = useState<ClassTest[]>([]);

  // Historical progression data
  const [progressionData, setProgressionData] = useState<ProgressionData | null>(null);

  // ── Initial load ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!sessionId || !classId) return;
    let cancelled = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 800;

    async function load() {
      try {
        const [sessionResult, classResult, testsResult] = await Promise.all([
          apiFetch<SessionDetailResponse>(`/api/v1/sessions/${sessionId}`),
          apiFetch<ClassDetailResponse>(`/api/v1/classes/${classId}`),
          apiFetch<{ data: ClassTest[] }>(`/api/v1/classes/${classId}/tests`).catch(() => ({ data: [] as ClassTest[] })),
        ]);
        if (cancelled) return;

        // Handle case where session is not found (race condition - session may not be ready yet)
        if (!sessionResult.data?.session) {
          if (retryCount < MAX_RETRIES) {
            retryCount++;
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
            if (!cancelled) load();
            return;
          }
          // Max retries exceeded - redirect to class page
          if (!cancelled) router.replace(`/classes/${classId}`);
          return;
        }

        setSession(sessionResult.data.session);
        setDisciplines(sessionResult.data?.disciplines ?? []);
        setClassMeta(classResult.data);
        setClassTests(testsResult.data);

        // Fetch progression data (non-fatal if it fails)
        apiFetch<ProgressionData>(`/api/v1/sessions/${sessionId}/progression-data`)
          .then((pd) => {
            if (!cancelled) setProgressionData(pd);
          })
          .catch(() => {
            // Non-fatal — progression card is simply not shown
          });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof APIError && err.status === 404) {
          router.replace(`/classes/${classId}`);
        } else {
          setError(
            err instanceof APIError ? err.message : "Failed to load session."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [sessionId, classId, router]);

  // ── Load ratings grid ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!sessionId || loading) return;
    let cancelled = false;

    async function loadRatings() {
      try {
        const result = await apiFetch<RatingsResponse>(
          `/api/v1/sessions/${sessionId}/ratings`
        );
        if (!cancelled) {
          setGridStudents(result.students ?? []);
          setGridDisciplines(result.disciplines ?? []);
        }
      } catch {
        // Non-fatal: grid will show 0/0 state
      }
    }

    loadRatings();
    return () => {
      cancelled = true;
    };
  }, [sessionId, loading]);

  // ── Load reports ───────────────────────────────────────────────────────────

  const loadReports = useCallback(async () => {
    if (!sessionId) return;
    try {
      interface ReportsResponse {
        reports: GridReport[];
      }
      const result = await apiFetch<ReportsResponse>(
        `/api/v1/sessions/${sessionId}/reports`
      );
      const map = new Map<string, GridReport>();
      for (const r of result.reports) {
        map.set(r.student_id, r);
      }
      setReports(map);
    } catch {
      // Non-fatal
    }
  }, [sessionId]);

  useEffect(() => {
    if (!loading) loadReports();
  }, [loading, loadReports]);

  // ── Filter save (debounced) ────────────────────────────────────────────────

  const filterSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleFilterSave = useCallback(
    (patch: FilterBarPatch) => {
      // Optimistically update session state so derived UI is consistent
      setSession((prev) => (prev ? { ...prev, ...patch } : prev));

      if (filterSaveTimerRef.current) clearTimeout(filterSaveTimerRef.current);
      filterSaveTimerRef.current = setTimeout(async () => {
        try {
          interface UpdateSessionResponse {
            data: SessionDetail;
          }
          const result = await apiFetch<UpdateSessionResponse>(
            `/api/v1/sessions/${sessionId}`,
            { method: "PUT", body: patch }
          );
          setSession(result.data);
        } catch {
          // Non-fatal — filter state is still local; user can re-save
        }
      }, 600);
    },
    [sessionId]
  );

  // ── Report created callback ────────────────────────────────────────────────

  function handleReportCreated(report: GridReport) {
    setReports((prev) => {
      const next = new Map(prev);
      next.set(report.student_id, report);
      return next;
    });
  }

  function handleBulkBatchStarted(_batchId: string) {
    void _batchId;
    setTimeout(loadReports, 5000);
  }

  // ── Discipline added ───────────────────────────────────────────────────────

  function handleDisciplineAdded(discipline: Discipline) {
    setDisciplines((prev) => [...prev, discipline]);
    setGridDisciplines((prev) => [...prev, discipline]);
    setGridStudents((prev) =>
      prev.map((student) => ({
        ...student,
        ratings: [
          ...student.ratings,
          {
            session_discipline_id: discipline.id,
            score: null,
            comment: null,
          },
        ],
      }))
    );
    setShowAddDiscipline(false);
  }

  // ── Session status ─────────────────────────────────────────────────────────

  async function handleStatusChange(newStatus: string) {
    setShowStatusConfirm(null);
    setStatusUpdating(true);
    try {
      interface UpdateSessionResponse {
        data: SessionDetail;
      }
      const result = await apiFetch<UpdateSessionResponse>(
        `/api/v1/sessions/${sessionId}`,
        { method: "PUT", body: { status: newStatus } }
      );
      setSession(result.data);
    } catch (err) {
      setActionError(
        err instanceof APIError ? err.message : "Failed to update status."
      );
    } finally {
      setStatusUpdating(false);
    }
  }

  // ── Duplicate ──────────────────────────────────────────────────────────────

  async function handleDuplicateConfirm(targetClassId: string, targetClassName: string) {
    setShowDuplicateModal(false);
    setDuplicating(true);
    try {
      interface DuplicateResponse {
        data: { id: string; class_id: string };
      }
      const result = await apiFetch<DuplicateResponse>(
        `/api/v1/sessions/${sessionId}/duplicate`,
        { method: "POST", body: { targetClassId } }
      );
      setSuccessToast(`Session duplicated to ${targetClassName}.`);
      setTimeout(() => setSuccessToast(null), 4000);
      router.push(
        `/classes/${result.data.class_id}/sessions/${result.data.id}`
      );
    } catch (err) {
      setActionError(
        err instanceof APIError ? err.message : "Failed to duplicate session."
      );
      setDuplicating(false);
    }
  }

  // ── Edit session name ──────────────────────────────────────────────────────

  async function handleSaveSessionName(newName: string) {
    try {
      interface UpdateSessionResponse {
        data: SessionDetail;
      }
      const result = await apiFetch<UpdateSessionResponse>(
        `/api/v1/sessions/${sessionId}`,
        { method: "PUT", body: { name: newName } }
      );
      setSession(result.data);
      setShowEditModal(false);
    } catch (err) {
      throw err instanceof APIError ? err : new Error("Failed to save changes.");
    }
  }

  // ── Delete session ─────────────────────────────────────────────────────────

  async function handleDeleteSession() {
    setDeleting(true);
    try {
      await apiFetch(`/api/v1/sessions/${sessionId}`, { method: "DELETE" });
      router.push(`/classes/${classId}`);
    } catch (err) {
      setActionError(
        err instanceof APIError ? err.message : "Failed to delete session."
      );
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return <SessionSkeleton />;

  if (error) {
    return (
      <div className="max-w-6xl mx-auto">
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="max-w-6xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-4 bg-gray-200 rounded w-32" />
          <div className="h-8 bg-gray-200 rounded w-64" />
        </div>
      </div>
    );
  }

  const isComplete = session.status === "complete";

  const classLabel = classMeta
    ? [
        classMeta.name,
        classMeta.year_group && `Year ${classMeta.year_group}`,
        classMeta.subject,
      ]
        .filter(Boolean)
        .join(" — ")
    : "";

  // Use empty-string base so all export URLs are relative (same-origin).
  // This avoids CSP violations from calling the Express backend on port 3001 directly.
  const API_URL = "";

  return (
    <div className="w-full space-y-6">
      {/* Modals */}
      {showAddDiscipline && (
        <AddDisciplineModal
          sessionId={sessionId}
          onClose={() => setShowAddDiscipline(false)}
          onAdded={handleDisciplineAdded}
        />
      )}
      {showStatusConfirm && (
        <ConfirmDialog
          message={
            showStatusConfirm === "complete"
              ? "Mark this session as complete? Editing will be locked for all students."
              : `Change status to "${showStatusConfirm}"?`
          }
          confirmLabel="Confirm"
          onConfirm={() => handleStatusChange(showStatusConfirm)}
          onCancel={() => setShowStatusConfirm(null)}
        />
      )}
      {showDuplicateModal && session && (
        <DuplicateToClassModal
          sessionName={session.name}
          currentClassId={classId}
          onConfirm={handleDuplicateConfirm}
          onCancel={() => setShowDuplicateModal(false)}
        />
      )}
      {showEditModal && session && (
        <EditSessionModal
          session={session}
          reportCount={reports.size}
          onSave={handleSaveSessionName}
          onCancel={() => setShowEditModal(false)}
          onRequestDelete={() => {
            setShowEditModal(false);
            setShowDeleteConfirm(true);
          }}
        />
      )}
      {showDeleteConfirm && session && (
        <DeleteSessionConfirmModal
          sessionName={session.name}
          reportCount={reports.size}
          deleting={deleting}
          onConfirm={handleDeleteSession}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {/* Success toast */}
      {successToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white text-sm font-medium px-5 py-3 rounded-lg shadow-lg flex items-center gap-3">
          <svg className="w-4 h-4 text-green-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          {successToast}
        </div>
      )}

      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-gray-500 flex-wrap">
        <Link href="/dashboard" className="hover:text-indigo-600 transition">
          Dashboard
        </Link>
        <span>/</span>
        <Link
          href={`/classes/${classId}`}
          className="hover:text-indigo-600 transition truncate max-w-[180px]"
        >
          {classLabel || "Class"}
        </Link>
        <span>/</span>
        <span className="text-gray-800 font-medium truncate">
          {session.name}
        </span>
      </nav>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-gray-900">{session.name}</h1>
            <StatusBadge status={session.status} />
            {session.is_template && (
              <span className="inline-flex items-center rounded-full bg-amber-100 text-amber-700 px-2.5 py-0.5 text-xs font-medium">
                Template
              </span>
            )}
            {!session.is_template && session.source_template_id && (
              <span className="inline-flex items-center rounded-full bg-sky-100 text-sky-700 px-2.5 py-0.5 text-xs font-medium">
                Copied from template
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
            <span className="capitalize">{session.tone} tone</span>
            <span>·</span>
            <span className="capitalize">{session.length} length</span>
            <span>·</span>
            <span>{new Date(session.created_at).toLocaleDateString()}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {!isComplete && session.status === "draft" && (
            <button
              onClick={() => setShowStatusConfirm("in_progress")}
              disabled={statusUpdating}
              className="px-3 py-1.5 rounded-md border border-yellow-400 text-sm font-medium text-yellow-700 hover:bg-yellow-50 transition disabled:opacity-50"
            >
              Mark In Progress
            </button>
          )}
          {!isComplete && session.status === "in_progress" && (
            <button
              onClick={() => setShowStatusConfirm("complete")}
              disabled={statusUpdating}
              className="px-3 py-1.5 rounded-md border border-green-400 text-sm font-medium text-green-700 hover:bg-green-50 transition disabled:opacity-50"
            >
              Mark Complete
            </button>
          )}
          <button
            onClick={() => setShowDuplicateModal(true)}
            disabled={duplicating}
            className="px-3 py-1.5 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition disabled:opacity-50"
          >
            {duplicating ? "Duplicating..." : "Duplicate Session"}
          </button>
          <button
            onClick={() => setShowEditModal(true)}
            className="px-3 py-1.5 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
          >
            Edit
          </button>
        </div>
      </div>

      {/* Action error */}
      {actionError && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-5 py-3 text-sm text-red-700 flex items-center justify-between">
          <span>{actionError}</span>
          <button
            onClick={() => setActionError(null)}
            className="text-red-400 hover:text-red-600 ml-4 transition"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Tab toggle */}
      <div className="flex border-b border-gray-200">
        <button
          onClick={() => setActiveTab("ratings")}
          className={`px-5 py-2.5 text-sm font-medium transition border-b-2 -mb-px ${
            activeTab === "ratings"
              ? "border-indigo-600 text-indigo-700"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Ratings
        </button>
        <button
          onClick={() => setActiveTab("reports")}
          className={`px-5 py-2.5 text-sm font-medium transition border-b-2 -mb-px ${
            activeTab === "reports"
              ? "border-indigo-600 text-indigo-700"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Reports
          {reports.size > 0 && (
            <span className="ml-1.5 inline-flex items-center rounded-full bg-indigo-100 px-1.5 py-0.5 text-xs font-medium text-indigo-700">
              {reports.size}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab("generate")}
          className={`px-5 py-2.5 text-sm font-medium transition border-b-2 -mb-px ${
            activeTab === "generate"
              ? "border-indigo-600 text-indigo-700"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Generate Reports
        </button>
      </div>

      {/* Ratings tab — compact filter bar above grid */}
      {activeTab === "ratings" && (
        <div className="w-full space-y-4">
          <CompactFilterBar
            session={session as unknown as FilterBarSession}
            disciplines={disciplines}
            classTests={classTests as FilterBarClassTest[]}
            progressionData={progressionData as FilterBarProgressionData | null}
            onSave={handleFilterSave}
            onAddDiscipline={isComplete ? undefined : () => setShowAddDiscipline(true)}
            isReadOnly={isComplete}
          />

          <RatingsGrid
            sessionId={sessionId}
            students={gridStudents}
            disciplines={gridDisciplines}
            reports={reports}
            isReadOnly={isComplete}
            onReportCreated={handleReportCreated}
            onBulkBatchStarted={handleBulkBatchStarted}
            topics={session.topics_covered}
          />
        </div>
      )}

      {/* Reports tab */}
      {activeTab === "reports" && (
        <ReportsTab
          classId={classId}
          sessionId={sessionId}
          gridStudents={gridStudents}
          reports={reports}
          apiUrl={API_URL}
        />
      )}

      {/* Generate Reports tab */}
      {activeTab === "generate" && (
        <GenerateReportsPanel
          sessionId={sessionId}
          students={gridStudents}
        />
      )}

      {/* Export section */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm px-6 py-4">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
          Export
        </h2>
        <div className="flex items-center gap-3 flex-wrap">
          <ExportButton
            label="Export All PDF (ZIP)"
            url={`${API_URL}/api/v1/sessions/${sessionId}/export/pdf`}
            filename="session_reports.zip"
            icon="download"
          />
          <ExportButton
            label="Export XLSX"
            url={`${API_URL}/api/v1/sessions/${sessionId}/export/csv`}
            filename="session_reports.xlsx"
            icon="spreadsheet"
          />
        </div>
      </div>
    </div>
  );
}
