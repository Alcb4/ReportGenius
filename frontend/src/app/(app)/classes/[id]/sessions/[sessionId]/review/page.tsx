"use client";

/**
 * Review page — focused student cycling view for report editing.
 *
 * Allows a teacher to cycle through students one at a time, viewing ratings,
 * editing the generated report, and marking it as final before moving on.
 *
 * URL params: classId (params.id), sessionId (params.sessionId)
 * Query param: student — the currently-focused student ID
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiFetch, APIError } from "@/lib/api";
import { downloadExport as downloadWithAuth } from "@/lib/download";
import { useAuth } from "@/context/AuthContext";
import CompactFilterBar, {
  FilterBarSession,
  FilterBarPatch,
  ClassTest,
  ProgressionData,
} from "@/components/CompactFilterBar";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ReviewStudent {
  id: string;
  first_name: string;
  last_name: string | null;
  gender: string | null;
  student_ref_id: string | null;
  ratings: Array<{
    session_discipline_id: string;
    score: number | null;
    comment: string | null;
  }>;
}

interface ReviewDiscipline {
  id: string;
  name: string;
}

interface ReviewSessionDetail {
  id: string;
  name: string;
  class_id: string;
  tone: string;
  length: string;
  status: string;
  test_filters: Record<string, { includeMark: boolean; includePercentage: boolean; includeGrade: boolean; includeLowMention: boolean }> | null;
  progression_filters: string[];
  enable_progression: boolean;
  allow_negative_progression: boolean;
  class_overview: string | null;
}

interface FullReport {
  id: string;
  student_id: string;
  session_id: string;
  status: string;
  edited_content: string;
  word_count: number | null;
  llm_raw_response: string;
  created_at: string;
}

interface SessionReport {
  id: string;
  student_id: string;
  status: string;
  word_count: number | null;
}

interface HistoryReport {
  id: string;
  status: string;
  word_count: number | null;
  llm_raw_response: string;
  created_at: string;
  session: { id: string; name: string; class: { id: string; name: string } };
}

interface RatingsHistoryEntry {
  sessionId: string;
  sessionName: string;
  className: string;
  createdAt: string;
  disciplines: Array<{ name: string; score: number | null }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function statusDot(status: string | undefined): string {
  if (!status) return "○";
  if (status === "final") return "✓";
  return "●";
}

function StatusDot({ status }: { status: string | undefined }) {
  if (!status) {
    return <span className="inline-block w-2 h-2 rounded-full bg-gray-300" title="No report" />;
  }
  if (status === "final") {
    return <span className="inline-block w-2 h-2 rounded-full bg-green-500" title="Final" />;
  }
  return <span className="inline-block w-2 h-2 rounded-full bg-yellow-400" title={status} />;
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function ReviewPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Session-only mode: no server LLM key — the free AI panel is the generation path
  const { isStatelessMode } = useAuth();

  const classId =
    typeof params.id === "string" ? params.id : (params.id?.[0] ?? "");
  const sessionId =
    typeof params.sessionId === "string"
      ? params.sessionId
      : (params.sessionId?.[0] ?? "");

  // ── State ──────────────────────────────────────────────────────────────────

  const [sessionMeta, setSessionMeta] = useState<ReviewSessionDetail | null>(null);
  const [classMeta, setClassMeta] = useState<{ id: string; name: string } | null>(null);
  const [students, setStudents] = useState<ReviewStudent[]>([]);
  const [disciplines, setDisciplines] = useState<ReviewDiscipline[]>([]);
  const [sessionReports, setSessionReports] = useState<Map<string, SessionReport>>(new Map());
  const [currentReport, setCurrentReport] = useState<FullReport | null>(null);
  const [editedContent, setEditedContent] = useState("");
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const [historyReports, setHistoryReports] = useState<HistoryReport[]>([]);
  const [historyExpanded, setHistoryExpanded] = useState(true);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [showMoreHistory, setShowMoreHistory] = useState(false);
  const [isEditable, setIsEditable] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const [showRedoConfirm, setShowRedoConfirm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [studentLoading, setStudentLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [ratingsHistory, setRatingsHistory] = useState<RatingsHistoryEntry[]>([]);
  const [ratingsHistoryExpanded, setRatingsHistoryExpanded] = useState(false);
  const [showMoreRatingsHistory, setShowMoreRatingsHistory] = useState(false);
  const [classTests, setClassTests] = useState<ClassTest[]>([]);
  const [progressionData, setProgressionData] = useState<ProgressionData | null>(null);
  const [filtersChangedSinceGenerate, setFiltersChangedSinceGenerate] = useState(false);

  // Free AI Model panel state (open by default in session-only mode — it is
  // the only generation path there)
  const [freeModelExpanded, setFreeModelExpanded] = useState(isStatelessMode);
  const [freeModelPaste, setFreeModelPaste] = useState("");
  const [freeModelCopyStatus, setFreeModelCopyStatus] = useState<"idle" | "copied">("idle");
  const [freeModelParseStatus, setFreeModelParseStatus] = useState<"idle" | "parsing" | "success" | "error">("idle");
  const [freeModelError, setFreeModelError] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevStudentIdRef = useRef<string | null>(null);

  // ── Derived values ─────────────────────────────────────────────────────────

  const currentStudentId = searchParams.get("student") ?? students[0]?.id;
  const currentStudent = students.find((s) => s.id === currentStudentId) ?? null;
  const currentIndex = students.findIndex((s) => s.id === currentStudentId);
  const prevStudent = currentIndex > 0 ? students[currentIndex - 1] : null;
  const nextStudent =
    currentIndex < students.length - 1 ? students[currentIndex + 1] : null;

  // ── Navigation ─────────────────────────────────────────────────────────────

  const navigate = useCallback(
    (studentId: string) => {
      router.replace(
        `/classes/${classId}/sessions/${sessionId}/review?student=${studentId}`
      );
    },
    [router, classId, sessionId]
  );

  // ── Initial load: session meta + students + reports ────────────────────────

  useEffect(() => {
    if (!sessionId || !classId) return;
    let cancelled = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 800;

    async function loadAll() {
      try {
        interface SessionDetailResponse {
          data: {
            session: ReviewSessionDetail & { class_id: string };
            students: ReviewStudent[];
            disciplines: ReviewDiscipline[];
          };
        }
        interface RatingsResponse {
          students: ReviewStudent[];
          disciplines: ReviewDiscipline[];
        }
        interface ReportsListResponse {
          reports: SessionReport[];
        }

        const [sessionRes, ratingsRes, reportsRes] = await Promise.all([
          apiFetch<SessionDetailResponse>(`/api/v1/sessions/${sessionId}`),
          apiFetch<RatingsResponse>(`/api/v1/sessions/${sessionId}/ratings`),
          apiFetch<ReportsListResponse>(`/api/v1/sessions/${sessionId}/reports`),
        ]);

        if (cancelled) return;

        const sessionData = sessionRes.data?.session;
        if (!sessionData) {
          if (retryCount < MAX_RETRIES) {
            retryCount++;
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
            if (!cancelled) loadAll();
            return;
          }
          setError("Failed to load session data.");
          setLoading(false);
          return;
        }

        setSessionMeta(sessionData);

        const fetchedClassId = sessionData.class_id;

        // Fetch class meta, tests, and progression in parallel (all non-fatal)
        await Promise.all([
          apiFetch<{ data: { id: string; name: string } }>(`/api/v1/classes/${fetchedClassId}`)
            .then((r) => { if (!cancelled) setClassMeta(r.data); })
            .catch(() => {}),
          apiFetch<{ data: ClassTest[] }>(`/api/v1/classes/${fetchedClassId}/tests`)
            .then((r) => { if (!cancelled) setClassTests(r.data); })
            .catch(() => {}),
          apiFetch<ProgressionData>(`/api/v1/sessions/${sessionId}/progression-data`)
            .then((pd) => { if (!cancelled) setProgressionData(pd); })
            .catch(() => {}),
        ]);

        // Use ratings response for students (has per-discipline scores)
        setStudents(ratingsRes.students ?? []);
        setDisciplines(ratingsRes.disciplines ?? []);

        const map = new Map<string, SessionReport>();
        for (const r of reportsRes.reports) {
          map.set(r.student_id, r);
        }
        setSessionReports(map);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof APIError ? err.message : "Failed to load session.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadAll();
    return () => {
      cancelled = true;
    };
  }, [sessionId, classId]);

  // ── Student change: load report + history ──────────────────────────────────

  useEffect(() => {
    if (!currentStudentId || !students.length) return;
    if (prevStudentIdRef.current === currentStudentId) return;
    prevStudentIdRef.current = currentStudentId;

    // Clear stale data immediately
    setCurrentReport(null);
    setEditedContent("");
    setHistoryReports([]);
    setExpandedHistoryId(null);
    setShowMoreHistory(false);
    setRatingsHistory([]);
    setShowMoreRatingsHistory(false);
    setSaveStatus("saved");
    setStudentLoading(true);
    // Reset free model panel (kept open in session-only mode — it is the
    // only generation path there)
    setFreeModelPaste("");
    setFreeModelParseStatus("idle");
    setFreeModelError(null);
    setFreeModelExpanded(isStatelessMode);

    const sessionReport = sessionReports.get(currentStudentId);

    async function loadStudent() {
      try {
        // Pass excludeReportId so the backend omits the current report from history.
        const excludeParam = sessionReport ? `?excludeReportId=${sessionReport.id}` : "";
        const fetches: Promise<void>[] = [
          apiFetch(`/api/v1/students/${currentStudentId}/ratings-history`)
            .then((r: unknown) => {
              setRatingsHistory(
                (r as { history: RatingsHistoryEntry[] }).history ?? []
              );
            })
            .catch(() => {
              // 404 (student has no ratings history) — leave state as reset []
            }),
          apiFetch(`/api/v1/students/${currentStudentId}/reports${excludeParam}`)
            .then((r: unknown) => {
              // Route returns { data: [...] } — the old `.reports` read meant
              // this history panel was always empty.
              const all = (r as { data?: HistoryReport[] }).data ?? [];
              // Belt-and-braces client-side filter in case the report was just created.
              const filtered = sessionReport
                ? all.filter((h) => h.id !== sessionReport.id)
                : all;
              setHistoryReports(filtered);
            })
            .catch(() => {
              // Non-fatal — leave state as reset []
            }),
        ];

        if (sessionReport) {
          fetches.push(
            apiFetch<{ report: FullReport }>(
              `/api/v1/reports/${sessionReport.id}`
            ).then((r) => {
              setCurrentReport(r.report);
              setEditedContent(r.report.edited_content);
              setIsEditable(r.report.status !== "final");
            })
          );
        }

        await Promise.all(fetches);
      } catch {
        // Non-fatal — show empty state
      } finally {
        setStudentLoading(false);
      }
    }

    loadStudent();
  }, [currentStudentId, students.length, sessionReports, isStatelessMode]);

  // ── Word count live update ─────────────────────────────────────────────────

  useEffect(() => {
    const count = editedContent.trim().split(/\s+/).filter(Boolean).length;
    setWordCount(editedContent.trim() ? count : 0);
  }, [editedContent]);

  // ── Auto-save (debounced 800ms) ────────────────────────────────────────────

  useEffect(() => {
    if (!currentReport) return;
    if (editedContent === currentReport.edited_content) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus("unsaved");
    saveTimerRef.current = setTimeout(async () => {
      await saveContent(editedContent);
    }, 800);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editedContent]);

  // ── Save helpers ───────────────────────────────────────────────────────────

  async function saveContent(
    content: string,
    statusOverride?: "draft" | "edited" | "final"
  ) {
    if (!currentReport) return;
    setSaveStatus("saving");
    try {
      const body: Record<string, unknown> = { edited_content: content };
      if (statusOverride) body.status = statusOverride;

      interface UpdateResponse {
        report: FullReport;
      }
      const result = await apiFetch<UpdateResponse>(
        `/api/v1/reports/${currentReport.id}`,
        { method: "PUT", body }
      );
      setCurrentReport(result.report);
      setSessionReports((prev) => {
        const next = new Map(prev);
        next.set(result.report.student_id, {
          id: result.report.id,
          student_id: result.report.student_id,
          status: result.report.status,
          word_count: result.report.word_count,
        });
        return next;
      });
      setSaveStatus("saved");
      if (statusOverride) setIsEditable(statusOverride !== "final");
    } catch {
      setSaveStatus("unsaved");
    }
  }

  // ── Mark final + advance ───────────────────────────────────────────────────

  async function handleMarkFinal() {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    await saveContent(editedContent, "final");
    if (nextStudent) {
      navigate(nextStudent.id);
    } else {
      router.push(`/classes/${classId}/sessions/${sessionId}`);
    }
  }

  // ── Unlock (revert to draft) ───────────────────────────────────────────────

  async function handleUnlock() {
    if (!currentReport) return;
    setIsEditable(true);
    try {
      await apiFetch(`/api/v1/reports/${currentReport.id}`, {
        method: "PUT",
        body: { status: "draft" },
      });
      setCurrentReport((prev) =>
        prev ? { ...prev, status: "draft" } : null
      );
      setSessionReports((prev) => {
        const next = new Map(prev);
        const r = next.get(currentReport.student_id);
        if (r) next.set(currentReport.student_id, { ...r, status: "draft" });
        return next;
      });
    } catch {
      // Non-fatal — UI already unlocked optimistically
    }
  }

  // ── Generate report ────────────────────────────────────────────────────────

  async function handleGenerate() {
    if (!currentStudentId) return;
    setGenerating(true);
    try {
      interface GenerateResponse {
        report: FullReport;
      }
      const result = await apiFetch<GenerateResponse>(
        `/api/v1/sessions/${sessionId}/students/${currentStudentId}/generate`,
        { method: "POST", body: {} }
      );
      setCurrentReport(result.report);
      setEditedContent(result.report.edited_content);
      setIsEditable(true);
      setSaveStatus("saved");
      setFiltersChangedSinceGenerate(false);
      setSessionReports((prev) => {
        const next = new Map(prev);
        next.set(result.report.student_id, {
          id: result.report.id,
          student_id: result.report.student_id,
          status: result.report.status,
          word_count: result.report.word_count,
        });
        return next;
      });
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  // ── Filter save (debounced 600ms) ─────────────────────────────────────────

  const handleFilterSave = useCallback(
    (patch: FilterBarPatch) => {
      setSessionMeta((prev) => (prev ? { ...prev, ...patch } : prev));
      setFiltersChangedSinceGenerate(true);

      if (filterSaveTimerRef.current) clearTimeout(filterSaveTimerRef.current);
      filterSaveTimerRef.current = setTimeout(async () => {
        try {
          interface UpdateSessionResponse {
            data: ReviewSessionDetail;
          }
          const result = await apiFetch<UpdateSessionResponse>(
            `/api/v1/sessions/${sessionId}`,
            { method: "PUT", body: patch }
          );
          setSessionMeta(result.data);
        } catch {
          // Non-fatal — filter state is still local
        }
      }, 600);
    },
    [sessionId]
  );

  // ── Redo ───────────────────────────────────────────────────────────────────

  async function handleRedo() {
    if (!currentReport) return;
    setShowRedoConfirm(false);
    setRedoing(true);
    try {
      interface RedoResponse {
        report: FullReport;
      }
      const result = await apiFetch<RedoResponse>(
        `/api/v1/reports/${currentReport.id}/redo`,
        { method: "POST", body: {} }
      );
      setCurrentReport(result.report);
      setEditedContent(result.report.edited_content);
      setIsEditable(true);
      setSaveStatus("saved");
      setFiltersChangedSinceGenerate(false);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Redo failed");
    } finally {
      setRedoing(false);
    }
  }

  // ── Free AI Model: copy prompt ─────────────────────────────────────────────

  async function handleFreeModelCopy() {
    if (!currentStudentId) return;
    try {
      interface PromptResponse { prompt: string }
      const result = await apiFetch<PromptResponse>(
        `/api/v1/sessions/${sessionId}/batch-prompt?studentIds=${encodeURIComponent(currentStudentId)}`
      );
      await navigator.clipboard.writeText(result.prompt);
      setFreeModelCopyStatus("copied");
      setTimeout(() => setFreeModelCopyStatus("idle"), 2000);
    } catch (err) {
      setFreeModelError(err instanceof APIError ? err.message : "Failed to copy prompt.");
    }
  }

  // ── Free AI Model: parse & apply ───────────────────────────────────────────

  async function handleFreeModelParse() {
    if (!freeModelPaste.trim() || !currentStudentId) return;
    setFreeModelParseStatus("parsing");
    setFreeModelError(null);

    try {
      interface ParseResponse {
        results: Array<{ studentId: string; name: string; success: boolean; error?: string }>;
        saved: number;
        failed: number;
      }
      const result = await apiFetch<ParseResponse>(
        `/api/v1/sessions/${sessionId}/parse-reports`,
        {
          method: "POST",
          body: { raw: freeModelPaste, studentIds: [currentStudentId] },
        }
      );

      if (result.saved === 0 || result.results[0]?.success === false) {
        const errMsg = result.results[0]?.error ?? "Report could not be saved.";
        setFreeModelParseStatus("error");
        setFreeModelError(errMsg);
        return;
      }

      setFreeModelParseStatus("success");
      setFreeModelPaste("");
      setFreeModelExpanded(false);

      // Reload the report for this student from the session list, then fetch full report
      interface ReportsListResponse { reports: SessionReport[] }
      const reportsRes = await apiFetch<ReportsListResponse>(`/api/v1/sessions/${sessionId}/reports`);
      const updatedMap = new Map<string, SessionReport>();
      for (const r of reportsRes.reports) updatedMap.set(r.student_id, r);
      setSessionReports(updatedMap);

      const savedReport = updatedMap.get(currentStudentId);
      if (savedReport) {
        const fullRes = await apiFetch<{ report: FullReport }>(`/api/v1/reports/${savedReport.id}`);
        setCurrentReport(fullRes.report);
        setEditedContent(fullRes.report.edited_content);
        setIsEditable(fullRes.report.status !== "final");
        setSaveStatus("saved");
      }
    } catch (err) {
      setFreeModelParseStatus("error");
      setFreeModelError(err instanceof APIError ? err.message : "Failed to parse response.");
    }
  }

  // ── Loading / error states ─────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="h-8 w-8 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-red-50 border border-red-200 rounded-lg px-5 py-4 text-sm text-red-700 max-w-md w-full">
          <p className="font-medium mb-2">Error loading review</p>
          <p>{error}</p>
          <Link
            href={`/classes/${classId}/sessions/${sessionId}`}
            className="mt-3 inline-block text-indigo-600 hover:text-indigo-800 text-sm font-medium"
          >
            Back to Session
          </Link>
        </div>
      </div>
    );
  }

  if (!sessionMeta) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-pulse space-y-4">
          <div className="h-4 bg-gray-200 rounded w-32" />
          <div className="h-6 bg-gray-200 rounded w-48" />
        </div>
      </div>
    );
  }

  if (!students.length) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="text-center">
          <p className="text-gray-500 text-sm mb-3">No students found in this session.</p>
          <Link
            href={`/classes/${classId}/sessions/${sessionId}`}
            className="text-indigo-600 hover:text-indigo-800 text-sm font-medium"
          >
            Back to Session
          </Link>
        </div>
      </div>
    );
  }

  // ── Derived: current session scores by discipline name (for delta) ─────────

  const currentScoreByName = new Map<string, number>();
  if (currentStudent) {
    for (const disc of disciplines) {
      const rating = currentStudent.ratings.find(
        (r) => r.session_discipline_id === disc.id
      );
      if (rating?.score !== null && rating?.score !== undefined) {
        currentScoreByName.set(disc.name, rating.score);
      }
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between gap-4 sticky top-0 z-10">
        <Link
          href={`/classes/${classId}/sessions/${sessionId}`}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-indigo-600 transition shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </Link>

        <div className="text-center hidden sm:block">
          <div className="text-sm font-medium text-gray-700 truncate max-w-xs">
            {sessionMeta?.name}
          </div>
          {classMeta && (
            <div className="text-xs text-gray-400 truncate">{classMeta.name}</div>
          )}
        </div>

        {/* Jump dropdown */}
        <select
          value={currentStudentId ?? ""}
          onChange={(e) => navigate(e.target.value)}
          className="text-sm border border-gray-300 rounded-md px-2 py-1.5 text-gray-700 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none max-w-[180px]"
        >
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {statusDot(sessionReports.get(s.id)?.status)}{" "}
              {s.first_name}
              {s.last_name ? ` ${s.last_name}` : ""}
            </option>
          ))}
        </select>
      </div>

      {/* ── Student nav bar ──────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between gap-4">
        <button
          onClick={() => prevStudent && navigate(prevStudent.id)}
          disabled={!prevStudent}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-md text-gray-600 hover:bg-gray-50 disabled:opacity-30 transition"
        >
          Prev
        </button>

        <div className="text-center">
          <div className="text-sm font-semibold text-gray-800">
            {currentStudent?.first_name}{" "}
            {currentStudent?.last_name ?? ""}
          </div>
          <div className="flex items-center gap-2 justify-center mt-0.5">
            <StatusDot status={sessionReports.get(currentStudentId ?? "")?.status} />
            <span className="text-xs text-gray-400">
              {currentIndex + 1} / {students.length}
            </span>
          </div>
        </div>

        <button
          onClick={() => nextStudent && navigate(nextStudent.id)}
          disabled={!nextStudent}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-md text-gray-600 hover:bg-gray-50 disabled:opacity-30 transition"
        >
          Next
        </button>
      </div>

      {/* ── Filter bar ───────────────────────────────────────────────────── */}
      {sessionMeta && (
        <div className="max-w-6xl mx-auto w-full px-4 pt-4 border-b border-gray-200">
          <CompactFilterBar
            session={sessionMeta as FilterBarSession}
            disciplines={disciplines}
            classTests={classTests}
            progressionData={progressionData}
            onSave={handleFilterSave}
          />
        </div>
      )}

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <div className="flex-1 max-w-6xl mx-auto w-full px-4 py-6 grid grid-cols-1 lg:grid-cols-[30%_70%] gap-6">
        {/* Left column */}
        <div className="space-y-4">
          {/* Ratings summary */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Ratings Summary</h3>
            {disciplines.length === 0 ? (
              <p className="text-xs text-gray-400">No disciplines configured.</p>
            ) : (
              disciplines.map((disc) => {
                const rating = currentStudent?.ratings.find(
                  (r) => r.session_discipline_id === disc.id
                );
                const score = rating?.score ?? null;
                const barColor =
                  score === null
                    ? "bg-gray-200"
                    : score >= 4
                    ? "bg-green-500"
                    : score >= 3
                    ? "bg-yellow-400"
                    : "bg-red-400";
                const labelColor =
                  score === null
                    ? "text-gray-300"
                    : score >= 4
                    ? "text-green-600"
                    : score >= 3
                    ? "text-yellow-600"
                    : "text-red-600";
                return (
                  <div key={disc.id} className="mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-600 w-28 truncate shrink-0">
                        {disc.name}
                      </span>
                      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${barColor}`}
                          style={{ width: score ? `${(score / 5) * 100}%` : "0%" }}
                        />
                      </div>
                      <span
                        className={`text-xs font-semibold w-4 text-right shrink-0 ${labelColor}`}
                      >
                        {score ?? "—"}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
            {/* Teacher notes — comment is stored per-discipline but is student-level;
                render the first non-empty comment once, below all discipline bars. */}
            {(() => {
              const note = currentStudent?.ratings.find((r) => r.comment?.trim())?.comment;
              return note ? (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">Teacher Notes</p>
                  <p className="text-xs text-gray-500 italic">{note}</p>
                </div>
              ) : null;
            })()}
          </div>

          {/* Previous reports (history) */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <button
              onClick={() => setHistoryExpanded((v) => !v)}
              className="flex items-center justify-between w-full text-sm font-semibold text-gray-700 mb-2"
            >
              <span>
                Previous Reports ({Math.min(historyReports?.length ?? 0, showMoreHistory ? historyReports?.length ?? 0 : 3)})
              </span>
              <svg
                className={`w-4 h-4 text-gray-400 transition-transform ${
                  historyExpanded ? "" : "-rotate-90"
                }`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {historyExpanded && (
              <>
                {(historyReports?.length ?? 0) === 0 ? (
                  <p className="text-xs text-gray-400">No previous reports.</p>
                ) : (
                  (showMoreHistory
                    ? historyReports
                    : historyReports.slice(0, 3)
                  ).map((r) => (
                    <div key={r.id} className="border-t border-gray-100 pt-2 mt-2">
                      <button
                        onClick={() =>
                          setExpandedHistoryId((v) => (v === r.id ? null : r.id))
                        }
                        className="text-left w-full hover:bg-gray-50 rounded transition p-1 -mx-1"
                      >
                        <div className="text-xs font-medium text-gray-700">
                          {r.session.name}
                        </div>
                        <div className="text-xs text-gray-400">
                          {r.session.class.name} &middot;{" "}
                          {new Date(r.created_at).toLocaleDateString()} &middot;{" "}
                          {r.word_count ?? 0}w
                        </div>
                      </button>
                      {expandedHistoryId === r.id && (
                        <div className="mt-2 p-2 bg-gray-50 rounded text-xs text-gray-600 whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">
                          {r.llm_raw_response}
                        </div>
                      )}
                    </div>
                  ))
                )}
                {(historyReports?.length ?? 0) > 3 && (
                  <button
                    onClick={() => setShowMoreHistory((v) => !v)}
                    className="mt-2 text-xs text-indigo-600 hover:text-indigo-800 transition"
                  >
                    {showMoreHistory
                      ? "Show less"
                      : `Show ${(historyReports?.length ?? 0) - 3} more`}
                  </button>
                )}
              </>
            )}
          </div>

          {/* Previous ratings (history) */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <button
              onClick={() => setRatingsHistoryExpanded((v) => !v)}
              className="flex items-center justify-between w-full text-sm font-semibold text-gray-700 mb-2"
            >
              <span>Previous Ratings</span>
              <svg
                className={`w-4 h-4 text-gray-400 transition-transform ${
                  ratingsHistoryExpanded ? "" : "-rotate-90"
                }`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {ratingsHistoryExpanded && (
              <>
                {ratingsHistory.length === 0 ? (
                  <p className="text-xs text-gray-400">No previous ratings on record.</p>
                ) : (
                  (showMoreRatingsHistory
                    ? ratingsHistory
                    : ratingsHistory.slice(0, 2)
                  ).map((entry) => (
                    <div key={entry.sessionId} className="border-t border-gray-100 pt-2 mt-2">
                      <div className="text-xs font-medium text-gray-700 mb-0.5">
                        {entry.sessionName}
                      </div>
                      <div className="text-xs text-gray-400 mb-2">
                        {entry.className} &middot;{" "}
                        {new Date(entry.createdAt).toLocaleDateString()}
                      </div>
                      {entry.disciplines.map((d) => {
                        const curr = currentScoreByName.get(d.name) ?? null;
                        const delta =
                          curr !== null && d.score !== null
                            ? curr > d.score
                              ? "up"
                              : curr < d.score
                              ? "down"
                              : "same"
                            : null;
                        const barColor =
                          d.score === null
                            ? "bg-gray-200"
                            : d.score >= 4
                            ? "bg-green-500"
                            : d.score >= 3
                            ? "bg-yellow-400"
                            : "bg-red-400";
                        return (
                          <div key={d.name} className="flex items-center gap-2 mb-1.5">
                            <span className="text-xs text-gray-500 w-24 truncate shrink-0">
                              {d.name}
                            </span>
                            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${barColor}`}
                                style={{
                                  width: d.score ? `${(d.score / 5) * 100}%` : "0%",
                                }}
                              />
                            </div>
                            <span className="text-xs font-semibold w-4 text-right shrink-0 text-gray-600">
                              {d.score ?? "—"}
                            </span>
                            {delta === "up" && (
                              <span
                                className="text-xs text-green-600 shrink-0 w-4 text-center"
                                title={`Current: ${curr}`}
                              >
                                ▲
                              </span>
                            )}
                            {delta === "down" && (
                              <span
                                className="text-xs text-red-500 shrink-0 w-4 text-center"
                                title={`Current: ${curr}`}
                              >
                                ▼
                              </span>
                            )}
                            {delta === "same" && (
                              <span className="text-xs text-gray-400 shrink-0 w-4 text-center">
                                =
                              </span>
                            )}
                            {delta === null && <span className="w-4 shrink-0" />}
                          </div>
                        );
                      })}
                    </div>
                  ))
                )}
                {ratingsHistory.length > 2 && (
                  <button
                    onClick={() => setShowMoreRatingsHistory((v) => !v)}
                    className="mt-2 text-xs text-indigo-600 hover:text-indigo-800 transition"
                  >
                    {showMoreRatingsHistory
                      ? "Show less"
                      : `Show ${ratingsHistory.length - 2} more`}
                  </button>
                )}
              </>
            )}
          </div>

          {/* Free AI Model panel */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <button
              onClick={() => {
                setFreeModelExpanded((v) => !v);
                setFreeModelParseStatus("idle");
                setFreeModelError(null);
              }}
              className="flex items-center justify-between w-full text-sm font-semibold text-gray-700 mb-2"
            >
              <span>Free AI Model</span>
              <svg
                className={`w-4 h-4 text-gray-400 transition-transform ${
                  freeModelExpanded ? "" : "-rotate-90"
                }`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {freeModelExpanded && (
              <div className="space-y-3 pt-1">
                <p className="text-xs text-gray-500">
                  Paste this prompt into ChatGPT, Claude or Gemini (free tier):
                </p>

                <p className="text-xs text-indigo-600 bg-indigo-50 border border-indigo-100 rounded-md px-2.5 py-1.5">
                  Student names are replaced with temporary aliases for privacy during AI generation.
                </p>

                <div className="flex justify-end">
                  <button
                    onClick={handleFreeModelCopy}
                    disabled={!currentStudentId}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-300 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    {freeModelCopyStatus === "copied" ? "Copied!" : "Copy Prompt"}
                  </button>
                </div>

                <div>
                  <p className="text-xs text-gray-500 mb-1.5">Paste response:</p>
                  <textarea
                    value={freeModelPaste}
                    onChange={(e) => {
                      setFreeModelPaste(e.target.value);
                      setFreeModelParseStatus("idle");
                      setFreeModelError(null);
                    }}
                    rows={4}
                    placeholder="Paste the AI response here..."
                    className="w-full rounded-md border border-gray-300 px-2.5 py-2 text-xs text-gray-800 placeholder:text-gray-300 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition resize-none"
                  />
                </div>

                {freeModelError && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
                    {freeModelError}
                  </p>
                )}

                {freeModelParseStatus === "success" && (
                  <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2.5 py-1.5">
                    Applied
                  </p>
                )}

                <div className="flex justify-end">
                  <button
                    onClick={handleFreeModelParse}
                    disabled={freeModelParseStatus === "parsing" || !freeModelPaste.trim()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-300 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    {freeModelParseStatus === "parsing" ? "Applying..." : "Parse & Apply"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right column — report editor */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm flex flex-col h-fit">
          {/* Card header */}
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-lg font-bold text-gray-900">
                {currentStudent?.first_name}{" "}
                {currentStudent?.last_name ?? ""}
              </h2>
              {currentStudent?.student_ref_id && (
                <p className="text-xs text-gray-400">#{currentStudent.student_ref_id}</p>
              )}
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              {currentReport && (
                <span
                  className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                    currentReport.status === "final"
                      ? "bg-green-100 text-green-700"
                      : currentReport.status === "edited"
                      ? "bg-blue-100 text-blue-700"
                      : "bg-yellow-100 text-yellow-700"
                  }`}
                >
                  {currentReport.status.charAt(0).toUpperCase() +
                    currentReport.status.slice(1)}
                </span>
              )}
              {currentReport && (
                <span className="text-xs text-gray-400">{wordCount}w</span>
              )}
              {currentReport && (
                <span
                  className={`text-xs ${
                    saveStatus === "saving"
                      ? "text-amber-500"
                      : saveStatus === "unsaved"
                      ? "text-red-400"
                      : "text-green-500"
                  }`}
                >
                  {saveStatus === "saving"
                    ? "Saving..."
                    : saveStatus === "unsaved"
                    ? "Unsaved"
                    : "Saved"}
                </span>
              )}
            </div>
          </div>

          {/* Editor area */}
          <div className="px-5 py-4">
            {studentLoading ? (
              <div className="flex items-center justify-center min-h-48">
                <div className="h-6 w-6 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
              </div>
            ) : !currentReport ? (
              <div className="flex flex-col items-center justify-center gap-3 min-h-48">
                {generating ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="h-8 w-8 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
                    <p className="text-sm text-gray-500">Generating report...</p>
                  </div>
                ) : !(currentStudent?.ratings ?? []).some((r) => r.score !== null) ? (
                  <>
                    <p className="text-sm text-gray-500">No ratings yet for this student.</p>
                    <Link
                      href={`/classes/${classId}/sessions/${sessionId}`}
                      className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
                    >
                      Go to Ratings Grid
                    </Link>
                  </>
                ) : isStatelessMode ? (
                  <>
                    <p className="text-sm text-gray-500">No report yet for this student.</p>
                    <p className="text-sm text-gray-500 max-w-sm text-center">
                      Use the <span className="font-medium text-gray-700">Free AI Model</span> panel:
                      copy the prompt into ChatGPT (or any AI tool), then paste the response back.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-gray-500">No report yet for this student.</p>
                    <button
                      onClick={handleGenerate}
                      className="px-4 py-2 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 transition"
                    >
                      Generate Report
                    </button>
                  </>
                )}
              </div>
            ) : (
              <>
                {currentReport.status === "final" && !isEditable && (
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-xs text-gray-400">
                      This report is marked final.
                    </p>
                    <button
                      onClick={handleUnlock}
                      className="text-xs text-indigo-600 hover:text-indigo-800 font-medium transition"
                    >
                      Edit Report
                    </button>
                  </div>
                )}
                <textarea
                  value={editedContent}
                  onChange={(e) => {
                    setEditedContent(e.target.value);
                    // Auto-size: grow with content
                    e.target.style.height = "auto";
                    e.target.style.height = `${e.target.scrollHeight}px`;
                  }}
                  ref={(el) => {
                    if (el) {
                      el.style.height = "auto";
                      el.style.height = `${el.scrollHeight}px`;
                    }
                  }}
                  readOnly={!isEditable}
                  className={`w-full min-h-[200px] text-sm text-gray-800 leading-relaxed resize-none rounded border border-gray-200 px-3 py-2.5 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 outline-none transition overflow-hidden ${
                    !isEditable ? "bg-slate-50 cursor-default" : "bg-white"
                  }`}
                  placeholder="Report content will appear here..."
                />
              </>
            )}
          </div>

          {/* Action bar */}
          {currentReport && (
            <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                {!isStatelessMode && (
                <button
                  onClick={() => setShowRedoConfirm(true)}
                  disabled={redoing}
                  className={`px-3 py-1.5 text-xs rounded border font-medium transition disabled:opacity-50 ${
                    filtersChangedSinceGenerate
                      ? "border-indigo-600 text-indigo-600 bg-transparent hover:bg-indigo-50 animate-pulse"
                      : "border-indigo-600 text-indigo-600 bg-transparent hover:bg-indigo-50"
                  }`}
                >
                  {redoing ? "Regenerating..." : filtersChangedSinceGenerate ? "Regenerate (filters changed)" : "Regenerate"}
                </button>
                )}
                <button
                  onClick={() =>
                    downloadWithAuth(
                      `/api/v1/reports/${currentReport.id}/export/pdf`,
                      "report.pdf"
                    ).catch(() => {})
                  }
                  disabled={currentReport.status !== "final"}
                  title={currentReport.status !== "final" ? "Mark report as final to export PDF" : "Export this report as PDF"}
                  className="px-3 py-1.5 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  Export PDF
                </button>
              </div>
              <button
                onClick={handleMarkFinal}
                disabled={!isEditable && currentReport.status === "final"}
                className="px-4 py-1.5 text-sm font-semibold rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 transition"
              >
                {nextStudent ? "Mark Final + Next" : "Mark Final — Done"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Mobile sticky footer ──────────────────────────────────────────── */}
      <div className="lg:hidden sticky bottom-0 bg-white border-t border-gray-200 px-4 py-3 flex items-center justify-between gap-2">
        <button
          onClick={() => prevStudent && navigate(prevStudent.id)}
          disabled={!prevStudent}
          className="px-3 py-2 rounded border border-gray-300 text-sm text-gray-600 disabled:opacity-40 transition"
        >
          Prev
        </button>
        {currentReport && (
          <button
            onClick={handleMarkFinal}
            className="flex-1 mx-2 py-2 rounded bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition"
          >
            {nextStudent ? "Mark Final + Next" : "Mark Final — Done"}
          </button>
        )}
        <button
          onClick={() => nextStudent && navigate(nextStudent.id)}
          disabled={!nextStudent}
          className="px-3 py-2 rounded border border-gray-300 text-sm text-gray-600 disabled:opacity-40 transition"
        >
          Next
        </button>
      </div>

      {/* ── Redo confirm dialog ───────────────────────────────────────────── */}
      {showRedoConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <p className="text-sm text-gray-700 mb-5">
              Regenerate this report? This will replace the current content with
              a new LLM generation.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowRedoConfirm(false)}
                className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleRedo}
                className="px-4 py-2 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 transition"
              >
                Regenerate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
