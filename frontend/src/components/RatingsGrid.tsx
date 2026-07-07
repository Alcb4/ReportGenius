"use client";

/**
 * RatingsGrid — the core teacher workflow component.
 *
 * Renders a grid of students × disciplines where each cell is a [1][2][3][4][5]
 * score picker. Scores update local state instantly; cells auto-save on blur via
 * POST /api/v1/sessions/:sessionId/ratings (bulk upsert with a single entry).
 * A full-grid auto-save fires every 30 seconds for any pending changes.
 *
 * Topic ratings appear after discipline columns. They auto-save on blur via
 * POST /api/v1/sessions/:sessionId/topic-ratings/bulk and flush every 30 seconds.
 *
 * Keyboard navigation:
 *   Tab         → next discipline in same row
 *   Shift+Tab   → previous discipline
 *   Enter       → same discipline, next student row
 *   Left/Right  → change score value within focused cell
 *
 * Per-student features:
 *   - Sparkline (read-only dots + line) once all disciplines are scored
 *   - Row colour: green avg ≥ 4, yellow avg 2–3, red avg ≤ 1
 *   - Report status dot + Generate / View / Edit buttons
 *   - Comment text input (saves on blur alongside ratings)
 *
 * Bulk generation:
 *   - "Generate All Reports" button (active when ≥ 1 student fully rated)
 *   - Shows count: "Generate reports for X fully rated students"
 *   - Progress toast polls GET .../status every 2s
 */

import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  KeyboardEvent,
  FocusEvent,
} from "react";
import Link from "next/link";
import { apiFetch, APIError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import SparklineGrid from "@/components/SparklineGrid";

// ── Drag-to-grade types ───────────────────────────────────────────────────────

interface DragState {
  studentId: string;
  colBounds: Array<{ discId: string; left: number; right: number; centerX: number; centerY: number }>;
  samples: Map<string, number[]>;
  active: boolean;
  startX: number;
  rowTop: number;
  rowHeight: number;
}

interface DragPreview {
  studentId: string;
  scores: Map<string, number>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GridDiscipline {
  id: string;
  name: string;
  category: string | null;
  is_custom: boolean;
}

export interface GridStudentRating {
  session_discipline_id: string;
  score: number | null;
  comment: string | null;
}

export interface GridStudent {
  id: string;
  first_name: string;
  last_name: string | null;
  student_ref_id: string | null;
  gender: string | null;
  ratings: GridStudentRating[];
}

export interface GridReport {
  id: string;
  student_id: string;
  status: string;
  word_count?: number | null;
}

interface RatingsGridProps {
  sessionId: string;
  students: GridStudent[];
  disciplines: GridDiscipline[];
  reports: Map<string, GridReport>;
  isReadOnly: boolean;
  onReportCreated: (report: GridReport) => void;
  onBulkBatchStarted: (batchId: string) => void;
  topics: string[];
}

type CellKey = string;

interface CellValue {
  score: number | null;
  comment: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cellKey(studentId: string, disciplineId: string): CellKey {
  return `${studentId}|${disciplineId}`;
}

function avgScore(scores: (number | null)[]): number | null {
  const valid = scores.filter((s): s is number => s !== null);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function rowColour(avg: number | null): string {
  if (avg === null) return "";
  if (avg >= 4) return "bg-green-50/40";
  if (avg >= 2) return "bg-yellow-50/40";
  return "bg-red-50/40";
}

function SparklesIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
    </svg>
  );
}

function ReportStatusCell({
  report,
  studentId,
  fullyRated,
  anyRated,
  isGenerating,
  isReadOnly,
  onGenerate,
}: {
  report: GridReport | undefined;
  studentId: string;
  fullyRated: boolean;
  anyRated: boolean;
  isGenerating: boolean;
  isReadOnly: boolean;
  onGenerate: (id: string) => void;
}) {
  if (report) {
    const failed = report.status === "failed";
    const iconClass = failed
      ? "text-red-500 hover:text-red-700"
      : "text-green-500 hover:text-green-700";
    const tooltip = failed ? "Generation failed — click to retry" : "View / edit report";
    if (failed) {
      return (
        <button
          onClick={() => onGenerate(studentId)}
          title={tooltip}
          className="transition"
        >
          <SparklesIcon className={`w-4 h-4 ${iconClass} transition`} />
        </button>
      );
    }
    return (
      <Link href={`/reports/${report.id}/edit`} title={tooltip}>
        <SparklesIcon className={`w-4 h-4 ${iconClass} transition`} />
      </Link>
    );
  }

  if (isReadOnly) {
    return <SparklesIcon className="w-4 h-4 text-gray-300" />;
  }

  const tooltip = !anyRated
    ? "Add at least one rating before generating"
    : !fullyRated
    ? "Some disciplines unrated — report will use partial data"
    : "Generate report";

  const iconColour = !anyRated
    ? "text-gray-300"
    : !fullyRated
    ? "text-amber-400 hover:text-amber-600"
    : "text-gray-400 hover:text-indigo-600";

  return (
    <button
      onClick={() => onGenerate(studentId)}
      disabled={isGenerating || !anyRated}
      title={tooltip}
      className="transition disabled:cursor-not-allowed"
    >
      {isGenerating ? (
        <svg className="animate-spin w-4 h-4 text-indigo-400" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
      ) : (
        <SparklesIcon className={`w-4 h-4 ${iconColour} transition`} />
      )}
    </button>
  );
}

// ── Bulk progress toast ────────────────────────────────────────────────────────

interface BatchStatus {
  batchId: string;
  total: number;
  completed: number;
  failed: number;
  pending: number;
  active: number;
  results: Array<{
    studentId: string;
    status: string;
    reportId?: string;
    error?: string;
  }>;
}

function BulkProgressToast({
  sessionId,
  batchId,
  onDone,
  onReportCreated,
  onDismiss,
}: {
  sessionId: string;
  batchId: string;
  onDone: () => void;
  onReportCreated: (report: GridReport) => void;
  onDismiss: () => void;
}) {
  const [status, setStatus] = useState<BatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cancelledRef = useRef(false);
  const onDoneRef = useRef(onDone);
  const onReportCreatedRef = useRef(onReportCreated);

  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);
  useEffect(() => { onReportCreatedRef.current = onReportCreated; }, [onReportCreated]);

  useEffect(() => {
    cancelledRef.current = false;

    async function tick() {
      if (cancelledRef.current) return;
      try {
        const s = await apiFetch<BatchStatus>(
          `/api/v1/sessions/${sessionId}/generate/bulk/${batchId}/status`
        );
        if (cancelledRef.current) return;
        setStatus(s);

        for (const r of s.results) {
          if (r.reportId && r.studentId) {
            onReportCreatedRef.current({
              id: r.reportId,
              student_id: r.studentId,
              status: "draft",
            });
          }
        }

        const isDone = s.pending === 0 && s.active === 0;
        if (isDone) {
          onDoneRef.current();
        } else {
          setTimeout(tick, 2000);
        }
      } catch (err) {
        if (cancelledRef.current) return;
        setError(err instanceof APIError ? err.message : "Polling failed.");
        onDoneRef.current();
      }
    }

    const timer = setTimeout(tick, 0);
    return () => {
      cancelledRef.current = true;
      clearTimeout(timer);
    };
  }, [sessionId, batchId]);

  const isDone = status !== null && status.pending === 0 && status.active === 0;
  const pct = status && status.total > 0
    ? Math.round(((status.completed + status.failed) / status.total) * 100)
    : 0;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-full max-w-sm mx-auto">
      <div className="bg-white rounded-xl shadow-2xl border border-gray-200 px-5 py-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <p className="text-sm font-semibold text-gray-800">
            {isDone
              ? status!.failed > 0
                ? `${status!.completed} complete, ${status!.failed} failed`
                : `${status!.completed} reports ready`
              : `Generating reports... ${status ? `${status.completed + status.failed} / ${status.total}` : "starting"}`}
          </p>
          {isDone && (
            <button
              onClick={onDismiss}
              className="text-gray-400 hover:text-gray-600 transition shrink-0"
              aria-label="Dismiss"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {!isDone && (
          <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
            <div
              className="h-2 rounded-full bg-indigo-600 transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}

        {isDone && !error && status!.failed === 0 && (
          <p className="text-xs text-green-600 font-medium">All reports generated successfully.</p>
        )}
        {isDone && status!.failed > 0 && (
          <p className="text-xs text-red-600">{status!.failed} failed. Try generating individually.</p>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </div>
  );
}

// ── Custom Hook: useRatingsGridState ──────────────────────────────────────────

interface RatingsGridState {
  grid: Map<CellKey, CellValue>;
  setGrid: React.Dispatch<React.SetStateAction<Map<CellKey, CellValue>>>;
  comments: Map<string, string>;
  setComments: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  pendingSave: Set<CellKey>;
  setPendingSave: React.Dispatch<React.SetStateAction<Set<CellKey>>>;
  pendingComments: Set<string>;
  setPendingComments: React.Dispatch<React.SetStateAction<Set<string>>>;
  hasUnsaved: boolean;
  pendingCommentsRef: React.MutableRefObject<Set<string>>;
}

function useRatingsGridState(
  sessionId: string,
  students: GridStudent[],
  disciplines: GridDiscipline[]
): RatingsGridState {
  const localKey = `rg_grid_${sessionId}`;

  const buildInitialGrid = useCallback((): Map<CellKey, CellValue> => {
    const grid = new Map<CellKey, CellValue>();
    let stored: Record<string, CellValue> = {};
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(localKey) : null;
      if (raw) stored = JSON.parse(raw) as Record<string, CellValue>;
    } catch { /* ignore corrupt cache */ }

    for (const student of students) {
      for (const disc of disciplines) {
        const existing = student.ratings.find(
          (r) => r.session_discipline_id === disc.id
        );
        const key = cellKey(student.id, disc.id);
        const serverScore = existing?.score ?? null;
        const cached = stored[key];
        grid.set(key, {
          score: serverScore ?? cached?.score ?? null,
          comment: existing?.comment ?? cached?.comment ?? null,
        });
      }
    }
    return grid;
  }, [students, disciplines, localKey]);

  const [grid, setGrid] = useState<Map<CellKey, CellValue>>(buildInitialGrid);
  const [comments, setComments] = useState<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const student of students) {
      const firstComment = student.ratings.find((r) => r.comment)?.comment ?? "";
      m.set(student.id, firstComment);
    }
    return m;
  });

  useEffect(() => {
    try {
      const obj: Record<string, CellValue> = {};
      grid.forEach((v, k) => { obj[k] = v; });
      localStorage.setItem(localKey, JSON.stringify(obj));
    } catch { /* quota exceeded — ignore */ }
  }, [grid, localKey]);

  const [pendingSave, setPendingSave] = useState<Set<CellKey>>(new Set());
  const [pendingComments, setPendingComments] = useState<Set<string>>(new Set());
  const hasUnsaved = pendingSave.size > 0 || pendingComments.size > 0;

  const pendingCommentsRef = useRef(pendingComments);
  // eslint-disable-next-line react-hooks/refs
  pendingCommentsRef.current = pendingComments;

  useEffect(() => {
    setGrid(buildInitialGrid());
  }, [buildInitialGrid]);

  useEffect(() => {
    setComments((prev) => {
      const next = new Map(prev);
      for (const student of students) {
        if (!pendingCommentsRef.current.has(student.id)) {
          const serverComment =
            student.ratings.find((r) => r.comment)?.comment ?? "";
          next.set(student.id, serverComment);
        }
      }
      return next;
    });
  }, [students]);

  return {
    grid, setGrid,
    comments, setComments,
    pendingSave, setPendingSave,
    pendingComments, setPendingComments,
    hasUnsaved,
    pendingCommentsRef,
  };
}

// ── Custom Hook: useRatingsGridSave ───────────────────────────────────────────

interface RatingsGridSave {
  saveError: string | null;
  setSaveError: React.Dispatch<React.SetStateAction<string | null>>;
  saveSingleRating: (studentId: string, disciplineId: string, scoreOverride?: number) => Promise<void>;
  saveAllPending: () => Promise<void>;
}

function useRatingsGridSave(
  sessionId: string,
  grid: Map<CellKey, CellValue>,
  comments: Map<string, string>,
  pendingSave: Set<CellKey>,
  pendingComments: Set<string>,
  setPendingSave: React.Dispatch<React.SetStateAction<Set<CellKey>>>,
  setPendingComments: React.Dispatch<React.SetStateAction<Set<string>>>,
  disciplines: GridDiscipline[]
): RatingsGridSave {
  const [saveError, setSaveError] = useState<string | null>(null);

  const saveSingleRating = useCallback(
    async (studentId: string, disciplineId: string, scoreOverride?: number) => {
      const key = cellKey(studentId, disciplineId);
      const score = scoreOverride ?? grid.get(key)?.score ?? null;
      if (score === null) return;

      try {
        await apiFetch(`/api/v1/sessions/${sessionId}/ratings`, {
          method: "POST",
          body: {
            ratings: [
              {
                studentId,
                sessionDisciplineId: disciplineId,
                score,
                comment: comments.get(studentId)?.trim() || undefined,
              },
            ],
          },
        });
        setPendingSave((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        setPendingComments((prev) => {
          const next = new Set(prev);
          next.delete(studentId);
          return next;
        });
      } catch (err) {
        setSaveError(err instanceof APIError ? err.message : "Auto-save failed.");
      }
    },
    [sessionId, grid, comments, setPendingSave, setPendingComments]
  );

  const saveAllPending = useCallback(async () => {
    if (pendingSave.size === 0 && pendingComments.size === 0) return;

    const ratings: Array<{
      studentId: string;
      sessionDisciplineId: string;
      score: number;
      comment?: string;
    }> = [];

    for (const key of pendingSave) {
      const [studentId, disciplineId] = key.split("|");
      const cell = grid.get(key);
      if (!cell || cell.score === null) continue;
      ratings.push({
        studentId,
        sessionDisciplineId: disciplineId,
        score: cell.score,
        comment: comments.get(studentId)?.trim() || undefined,
      });
    }

    for (const studentId of pendingComments) {
      for (const disc of disciplines) {
        const key = cellKey(studentId, disc.id);
        const cell = grid.get(key);
        if (cell?.score !== null && cell !== undefined && !pendingSave.has(key)) {
          ratings.push({
            studentId,
            sessionDisciplineId: disc.id,
            score: cell.score as number,
            comment: comments.get(studentId)?.trim() || undefined,
          });
        }
      }
    }

    if (ratings.length === 0) return;

    try {
      await apiFetch(`/api/v1/sessions/${sessionId}/ratings`, {
        method: "POST",
        body: { ratings },
      });
      setPendingSave(new Set());
      setPendingComments(new Set());
      setSaveError(null);
    } catch (err) {
      setSaveError(err instanceof APIError ? err.message : "Save failed.");
    }
  }, [sessionId, pendingSave, pendingComments, grid, comments, disciplines, setPendingSave, setPendingComments]);

  useEffect(() => {
    const timer = setInterval(saveAllPending, 30_000);
    return () => clearInterval(timer);
  }, [saveAllPending]);

  return { saveError, setSaveError, saveSingleRating, saveAllPending };
}

// ── Custom Hook: useRatingsGridTopics ─────────────────────────────────────────

interface RatingsGridTopics {
  topicGrid: Map<string, number | null>;
  setTopicGrid: React.Dispatch<React.SetStateAction<Map<string, number | null>>>;
  topicSaveError: string | null;
  setTopicSaveError: React.Dispatch<React.SetStateAction<string | null>>;
}

function useRatingsGridTopics(sessionId: string): RatingsGridTopics {
  const [topicGrid, setTopicGrid] = useState<Map<string, number | null>>(() => new Map());
  const [topicSaveError, setTopicSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();

    async function loadTopicRatings() {
      try {
        interface TopicRatingEntry {
          studentId: string;
          topicName: string;
          score: number;
        }
        interface TopicRatingsResponse {
          ratings: TopicRatingEntry[];
        }
        const result = await apiFetch<TopicRatingsResponse>(
          `/api/v1/sessions/${sessionId}/topic-ratings`,
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        const m = new Map<string, number | null>();
        for (const r of result.ratings) {
          m.set(`${r.studentId}|${r.topicName}`, r.score);
        }
        setTopicGrid(m);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[RatingsGrid] Failed to load topic ratings:", err);
      }
    }

    loadTopicRatings();
    return () => { controller.abort(); };
  }, [sessionId]);

  return { topicGrid, setTopicGrid, topicSaveError, setTopicSaveError };
}

// ── Custom Hook: useRatingsGridDrag ───────────────────────────────────────────

interface RatingsGridDrag {
  dragPreview: DragPreview | null;
  dragRef: React.MutableRefObject<DragState | null>;
  tableContainerRef: React.RefObject<HTMLDivElement | null>;
  cellRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  handleDiscMouseDown: (
    e: React.MouseEvent<HTMLTableCellElement>,
    studentId: string,
    rowEl: HTMLTableRowElement
  ) => void;
  handleCellKeyDown: (
    e: KeyboardEvent<HTMLDivElement>,
    si: number,
    di: number,
    studentId: string,
    disciplineId: string,
    currentScore: number | null
  ) => void;
  navKey: (si: number, di: number) => string;
}

function useRatingsGridDrag(
  isReadOnly: boolean,
  students: GridStudent[],
  disciplines: GridDiscipline[],
  handleScoreChange: (studentId: string, disciplineId: string, score: number) => void
): RatingsGridDrag {
  const cellRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragRef = useRef<DragState | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);

  function yToBand(clientY: number, rowTop: number, rowHeight: number): number {
    const ratio = Math.max(0, Math.min(1, (clientY - rowTop) / rowHeight));
    return Math.max(1, Math.min(5, Math.ceil((1 - ratio) * 5)));
  }

  function navKey(si: number, di: number) {
    return `${si}-${di}`;
  }

  function handleCellKeyDown(
    e: KeyboardEvent<HTMLDivElement>,
    si: number,
    di: number,
    studentId: string,
    disciplineId: string,
    currentScore: number | null
  ) {
    switch (e.key) {
      case "Tab": {
        e.preventDefault();
        const nextDi = e.shiftKey ? di - 1 : di + 1;
        if (nextDi >= 0 && nextDi < disciplines.length) {
          cellRefs.current.get(navKey(si, nextDi))?.focus();
        } else if (!e.shiftKey && nextDi >= disciplines.length) {
          const commentInput = document.getElementById(`comment-${students[si].id}`);
          commentInput?.focus();
        } else if (e.shiftKey && nextDi < 0 && si > 0) {
          cellRefs.current.get(navKey(si - 1, disciplines.length - 1))?.focus();
        }
        break;
      }
      case "Enter": {
        e.preventDefault();
        if (si + 1 < students.length) {
          cellRefs.current.get(navKey(si + 1, di))?.focus();
        }
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        if (currentScore !== null && currentScore < 5) {
          handleScoreChange(studentId, disciplineId, currentScore + 1);
        } else if (currentScore === null) {
          handleScoreChange(studentId, disciplineId, 1);
        }
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        if (currentScore !== null && currentScore > 1) {
          handleScoreChange(studentId, disciplineId, currentScore - 1);
        }
        break;
      }
      default:
        if (e.key >= "1" && e.key <= "5") {
          e.preventDefault();
          handleScoreChange(studentId, disciplineId, parseInt(e.key, 10));
        }
        break;
    }
  }

  function commitDrag(state: DragState) {
    if (!state.active) return;
    const traversed = Array.from(state.samples.entries()).filter(([, s]) => s.length > 0);
    if (traversed.length < 2) return;

    for (const [discId, samples] of traversed) {
      const tally = new Array<number>(6).fill(0);
      for (const b of samples) tally[b]++;
      const winner = tally.reduce((best, cnt, band) => cnt > tally[best] ? band : best, 1);
      handleScoreChange(state.studentId, discId, winner);
    }
  }

  function handleDiscMouseDown(
    e: React.MouseEvent<HTMLTableCellElement>,
    studentId: string,
    rowEl: HTMLTableRowElement
  ) {
    if (isReadOnly || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, a")) return;

    const rowRect = rowEl.getBoundingClientRect();
    const container = tableContainerRef.current;
    if (!container) return;

    const colBounds: DragState["colBounds"] = [];
    for (const disc of disciplines) {
      const td = rowEl.querySelector<HTMLElement>(`[data-disc-id="${disc.id}"]`);
      if (!td) continue;
      const r = td.getBoundingClientRect();
      colBounds.push({
        discId: disc.id,
        left: r.left,
        right: r.right,
        centerX: r.left + r.width / 2,
        centerY: r.top + r.height / 2,
      });
    }

    dragRef.current = {
      studentId,
      colBounds,
      samples: new Map(),
      active: false,
      startX: e.clientX,
      rowTop: rowRect.top,
      rowHeight: rowRect.height,
    };
  }

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      const state = dragRef.current;
      if (!state) return;

      if (!state.active && Math.abs(e.clientX - state.startX) >= 8) {
        state.active = true;
      }
      if (!state.active) return;

      const band = yToBand(e.clientY, state.rowTop, state.rowHeight);

      for (const col of state.colBounds) {
        if (e.clientX >= col.left && e.clientX <= col.right) {
          const existing = state.samples.get(col.discId) ?? [];
          existing.push(band);
          state.samples.set(col.discId, existing);
        }
      }

      const previewScores = new Map<string, number>();
      for (const [discId, samples] of state.samples.entries()) {
        if (samples.length === 0) continue;
        const tally = new Array<number>(6).fill(0);
        for (const b of samples) tally[b]++;
        const winner = tally.reduce((best, cnt, band) => cnt > tally[best] ? band : best, 1);
        previewScores.set(discId, winner);
      }
      setDragPreview({ studentId: state.studentId, scores: previewScores });
    }

    function onMouseUp(e: MouseEvent) {
      const state = dragRef.current;
      if (!state) return;
      if (e.button !== 0) return;
      commitDrag(state);
      dragRef.current = null;
      setDragPreview(null);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && dragRef.current) {
        dragRef.current = null;
        setDragPreview(null);
      }
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown as unknown as EventListener);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown as unknown as EventListener);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReadOnly, disciplines, students]);

  return {
    dragPreview,
    dragRef,
    tableContainerRef,
    cellRefs,
    handleDiscMouseDown,
    handleCellKeyDown,
    navKey,
  };
}

// ── Custom Hook: useRatingsGridGeneration ─────────────────────────────────────

interface RatingsGridGeneration {
  generatingStudentId: string | null;
  handleGenerateSingle: (studentId: string) => Promise<void>;
  bulkBatchId: string | null;
  bulkError: string | null;
  bulkDone: boolean;
  isBulkRunning: boolean;
  handleBulkGenerate: () => Promise<void>;
  setBulkDone: React.Dispatch<React.SetStateAction<boolean>>;
  setBulkBatchId: React.Dispatch<React.SetStateAction<string | null>>;
  setBulkError: React.Dispatch<React.SetStateAction<string | null>>;
}

function useRatingsGridGeneration(
  sessionId: string,
  saveAllPending: () => Promise<void>,
  onReportCreated: (report: GridReport) => void,
  onBulkBatchStarted: (batchId: string) => void,
  setSaveError: React.Dispatch<React.SetStateAction<string | null>>
): RatingsGridGeneration {
  // Session-only mode: no server LLM key — API generation routes to the free flow
  const { isStatelessMode } = useAuth();
  const [generatingStudentId, setGeneratingStudentId] = useState<string | null>(null);
  const [bulkBatchId, setBulkBatchId] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkDone, setBulkDone] = useState(false);
  const isBulkRunning = bulkBatchId !== null && !bulkDone;

  const handleGenerateSingle = useCallback(
    async (studentId: string) => {
      if (isStatelessMode) {
        setSaveError(
          "API generation is not available in session-only mode — use the Generate tab's free AI flow (copy the prompt, paste the response back)."
        );
        return;
      }
      setGeneratingStudentId(studentId);
      try {
        interface GenerateResponse {
          report: GridReport;
        }
        const result = await apiFetch<GenerateResponse>(
          `/api/v1/sessions/${sessionId}/students/${studentId}/generate`,
          { method: "POST", body: {} }
        );
        const report = result.report;
        onReportCreated({
          id: report.id,
          student_id: report.student_id ?? (report as unknown as Record<string, string>).studentId,
          status: report.status,
          word_count: report.word_count,
        });
      } catch (err) {
        setSaveError(err instanceof APIError ? err.message : "Failed to generate report.");
      } finally {
        setGeneratingStudentId(null);
      }
    },
    [sessionId, onReportCreated, setSaveError, isStatelessMode]
  );

  const handleBulkGenerate = useCallback(async () => {
    await saveAllPending();
    setBulkError(null);
    setBulkDone(false);
    try {
      interface BulkGenerateResponse {
        batchId: string;
        totalJobs: number;
      }
      const result = await apiFetch<BulkGenerateResponse>(
        `/api/v1/sessions/${sessionId}/generate/bulk`,
        { method: "POST", body: {} }
      );
      setBulkBatchId(result.batchId);
      onBulkBatchStarted(result.batchId);
    } catch (err) {
      setBulkError(err instanceof APIError ? err.message : "Failed to start bulk generation.");
    }
  }, [sessionId, saveAllPending, onBulkBatchStarted]);

  return {
    generatingStudentId,
    handleGenerateSingle,
    bulkBatchId,
    bulkError,
    bulkDone,
    isBulkRunning,
    handleBulkGenerate,
    setBulkDone,
    setBulkBatchId,
    setBulkError,
  };
}

// ── Main RatingsGrid ───────────────────────────────────────────────────────────

export default function RatingsGrid({
  sessionId,
  students,
  disciplines,
  reports,
  isReadOnly,
  onReportCreated,
  onBulkBatchStarted,
  topics,
}: RatingsGridProps) {
  // Session-only mode: no server LLM key — bulk API generation is hidden
  const { isStatelessMode } = useAuth();

  // 1. Normalize inputs
  const normalizedStudents = students ?? [];
  const normalizedDisciplines = useMemo(() => disciplines ?? [], [disciplines]);

  // 2. ALL hooks in one contiguous top-level block

  // Grid state (cells, comments, pending saves)
  const {
    grid, setGrid,
    comments, setComments,
    pendingSave,
    setPendingSave,
    pendingComments,
    setPendingComments,
    hasUnsaved,
  } = useRatingsGridState(sessionId, normalizedStudents, normalizedDisciplines);

  // Save logic (single, bulk, auto-save interval)
  const {
    saveError, setSaveError,
    saveSingleRating,
    saveAllPending,
  } = useRatingsGridSave(
    sessionId,
    grid,
    comments,
    pendingSave,
    pendingComments,
    setPendingSave,
    setPendingComments,
    normalizedDisciplines
  );

  // Topic ratings
  const {
    topicGrid, setTopicGrid,
    topicSaveError, setTopicSaveError,
  } = useRatingsGridTopics(sessionId);

  // Drag-to-grade + keyboard navigation
  const handleScoreChange = useCallback(
    (studentId: string, disciplineId: string, score: number) => {
      if (isReadOnly) return;
      const key = cellKey(studentId, disciplineId);
      setGrid((prev) => {
        const next = new Map(prev);
        next.set(key, { score, comment: prev.get(key)?.comment ?? null });
        return next;
      });
      setPendingSave((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    },
    [isReadOnly, setGrid, setPendingSave]
  );

  const {
    dragPreview,
    dragRef,
    tableContainerRef,
    cellRefs,
    handleDiscMouseDown,
    handleCellKeyDown,
    navKey,
  } = useRatingsGridDrag(
    isReadOnly,
    normalizedStudents,
    normalizedDisciplines,
    handleScoreChange
  );

  // Report generation
  const {
    generatingStudentId,
    handleGenerateSingle,
    bulkBatchId,
    bulkError,
    isBulkRunning,
    handleBulkGenerate,
    setBulkDone,
    setBulkBatchId,
    setBulkError,
  } = useRatingsGridGeneration(
    sessionId,
    saveAllPending,
    onReportCreated,
    onBulkBatchStarted,
    setSaveError
  );

  // View mode
  const [viewMode, setViewMode] = useState<"table" | "sparkline">("table");

  // SparklineGrid accessor callbacks
  const getScore = useCallback(
    (studentId: string, disciplineId: string): number | null =>
      grid.get(cellKey(studentId, disciplineId))?.score ?? null,
    [grid]
  );

  const getComment = useCallback(
    (studentId: string): string => comments.get(studentId) ?? "",
    [comments]
  );

  const getTopicScore = useCallback(
    (studentId: string, topicName: string): number | null =>
      topicGrid.get(`${studentId}|${topicName}`) ?? null,
    [topicGrid]
  );

  // Comment/topic handlers
  const handleCommentChange = useCallback(
    (studentId: string, value: string) => {
      if (isReadOnly) return;
      setComments((prev) => new Map(prev).set(studentId, value));
      setPendingComments((prev) => new Set(prev).add(studentId));
    },
    [isReadOnly, setComments, setPendingComments]
  );

  const handleTopicScoreChange = useCallback(
    async (studentId: string, topicName: string, score: number) => {
      if (isReadOnly) return;
      const key = `${studentId}|${topicName}`;
      setTopicGrid((prev) => new Map(prev).set(key, score));
      setTopicSaveError(null);
      try {
        await apiFetch(`/api/v1/sessions/${sessionId}/topic-ratings/bulk`, {
          method: "POST",
          body: { ratings: [{ studentId, topicName, score }] },
        });
      } catch (err) {
        setTopicSaveError(err instanceof APIError ? err.message : "Failed to save topic rating.");
      }
    },
    [isReadOnly, sessionId, setTopicGrid, setTopicSaveError]
  );

  const handleCellBlur = useCallback(
    (e: FocusEvent<HTMLDivElement>, studentId: string, disciplineId: string) => {
      const relatedTarget = e.relatedTarget as HTMLElement | null;
      const currentTarget = e.currentTarget as HTMLElement;
      if (relatedTarget && currentTarget.contains(relatedTarget)) return;

      const key = cellKey(studentId, disciplineId);
      if (pendingSave.has(key)) {
        saveSingleRating(studentId, disciplineId);
      }
    },
    [pendingSave, saveSingleRating]
  );

  const handleCommentBlur = useCallback(
    (studentId: string) => {
      if (!pendingComments.has(studentId)) return;
      const ratingsToPush: Array<{
        studentId: string;
        sessionDisciplineId: string;
        score: number;
        comment?: string;
      }> = [];
      for (const disc of normalizedDisciplines) {
        const key = cellKey(studentId, disc.id);
        const cell = grid.get(key);
        if (cell?.score !== null && cell !== undefined) {
          ratingsToPush.push({
            studentId,
            sessionDisciplineId: disc.id,
            score: cell.score as number,
            comment: comments.get(studentId)?.trim() || undefined,
          });
        }
      }
      if (ratingsToPush.length === 0) {
        setPendingComments((prev) => {
          const next = new Set(prev);
          next.delete(studentId);
          return next;
        });
        return;
      }
      apiFetch(`/api/v1/sessions/${sessionId}/ratings`, {
        method: "POST",
        body: { ratings: ratingsToPush },
      })
        .then(() => {
          setPendingComments((prev) => {
            const next = new Set(prev);
            next.delete(studentId);
            return next;
          });
        })
        .catch((err: unknown) => {
          setSaveError(err instanceof APIError ? err.message : "Auto-save failed.");
        });
    },
    [pendingComments, normalizedDisciplines, grid, comments, sessionId, setPendingComments, setSaveError]
  );

  // 3. Derived values
  const fullyRatedStudentIds = new Set<string>();
  const anyRatedStudentIds = new Set<string>();
  for (const student of normalizedStudents) {
    const allRated = normalizedDisciplines.every((disc) => {
      const cell = grid.get(cellKey(student.id, disc.id));
      return cell?.score !== null;
    });
    const hasAny = normalizedDisciplines.some((disc) => {
      const cell = grid.get(cellKey(student.id, disc.id));
      return (cell?.score ?? null) !== null;
    });
    if (normalizedDisciplines.length > 0 && allRated) {
      fullyRatedStudentIds.add(student.id);
    }
    if (normalizedDisciplines.length > 0 && hasAny) {
      anyRatedStudentIds.add(student.id);
    }
  }

  const fullyRatedCount = fullyRatedStudentIds.size;
  const anyRatedCount = anyRatedStudentIds.size;
  const progressPct =
    normalizedStudents.length > 0 ? Math.round((fullyRatedCount / normalizedStudents.length) * 100) : 0;

  const isLoading = !normalizedStudents.length && !normalizedDisciplines.length;
  const isEmptyStudents = normalizedStudents.length === 0;
  const isEmptyDisciplines = normalizedDisciplines.length === 0;

  // 4. Conditional rendering AFTER all hooks
  if (isLoading) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6 animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-24 mb-4" />
        <div className="space-y-2">
          <div className="h-8 bg-gray-100 rounded" />
          <div className="h-8 bg-gray-100 rounded" />
          <div className="h-8 bg-gray-100 rounded" />
        </div>
      </div>
    );
  }

  if (isEmptyStudents) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm px-6 py-10 text-center">
        <p className="text-sm text-gray-400">No students in this class.</p>
      </div>
    );
  }

  if (isEmptyDisciplines) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm px-6 py-10 text-center">
        <p className="text-sm text-gray-400 mb-1">No disciplines configured for this session.</p>
        <p className="text-xs text-gray-400">Add a discipline above to begin rating.</p>
      </div>
    );
  }

  // 5. Final render
  return (
    <div className="space-y-4">
      {/* Mode switcher */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
          <button
            onClick={() => setViewMode("table")}
            className={`px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500 ${
              viewMode === "table"
                ? "bg-indigo-600 text-white"
                : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            Table View
          </button>
          <button
            onClick={() => setViewMode("sparkline")}
            className={`px-4 py-2 text-sm font-medium transition border-l border-gray-200 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500 ${
              viewMode === "sparkline"
                ? "bg-indigo-600 text-white"
                : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            Sparkline View
          </button>
        </div>
      </div>

      {/* Progress bar + Generate CTA */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm px-5 py-3">
        <div className="flex items-center gap-4">
          <span className="flex-none text-xs font-medium text-gray-600 whitespace-nowrap">
            {fullyRatedCount} / {normalizedStudents.length} students fully rated
          </span>
          <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
            <div
              className="h-2 rounded-full bg-indigo-600 transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="flex-none flex items-center gap-3">
            {hasUnsaved && (
              <span className="flex items-center gap-1 text-xs text-amber-600 whitespace-nowrap">
                <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                Unsaved
              </span>
            )}
            {!isReadOnly && !isStatelessMode && (
              <button
                onClick={handleBulkGenerate}
                disabled={anyRatedCount === 0 || isBulkRunning}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition shadow-sm whitespace-nowrap"
              >
                {isBulkRunning
                  ? "Generating..."
                  : anyRatedCount === 0
                  ? "Generate reports"
                  : `Generate ${anyRatedCount} report${anyRatedCount !== 1 ? "s" : ""}`}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Error banner */}
      {(saveError || bulkError || topicSaveError) && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5 flex items-center justify-between">
          <span className="text-sm text-red-700">{saveError ?? bulkError ?? topicSaveError}</span>
          <button
            onClick={() => { setSaveError(null); setBulkError(null); setTopicSaveError(null); }}
            className="text-red-400 hover:text-red-600 ml-3 transition"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Sparkline View */}
      {viewMode === "sparkline" && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <SparklineGrid
            students={normalizedStudents}
            disciplines={normalizedDisciplines}
            getScore={getScore}
            onScoreChange={handleScoreChange}
            onScoreCommit={saveSingleRating}
            getComment={getComment}
            onCommentChange={handleCommentChange}
            onCommentBlur={handleCommentBlur}
            isReadOnly={isReadOnly}
            reports={reports}
            fullyRatedStudentIds={fullyRatedStudentIds}
            generatingStudentId={generatingStudentId}
            onGenerate={handleGenerateSingle}
            topics={topics}
            getTopicScore={getTopicScore}
            onTopicScoreChange={handleTopicScoreChange}
          />
        </div>
      )}

      {/* Grid (Table View) */}
      <div
        ref={tableContainerRef}
        className="relative bg-white rounded-lg border border-gray-200 shadow-sm overflow-x-auto w-full"
        style={{ display: viewMode === "table" ? undefined : "none" }}
      >
        {/* Drag-to-grade SVG overlay */}
        {/* eslint-disable-next-line react-hooks/refs */}
        {dragPreview && dragPreview.scores.size >= 1 && (() => {
          const container = tableContainerRef.current;
          if (!container) return null;
          const containerRect = container.getBoundingClientRect();
          const state = dragRef.current;
          if (!state) return null;

          const points: Array<[number, number]> = [];
          for (const col of state.colBounds) {
            const score = dragPreview.scores.get(col.discId);
            if (score === undefined) continue;
            const x = col.centerX - containerRect.left + container.scrollLeft;
            const rowRelTop = state.rowTop - containerRect.top + container.scrollTop;
            const y = rowRelTop + state.rowHeight * (1 - (score - 1) / 4);
            points.push([x, y]);
          }
          if (points.length < 1) return null;

          const ptStr = points.map(([x, y]) => `${x},${y}`).join(" ");
          return (
            <svg
              className="absolute inset-0 pointer-events-none"
              style={{ width: "100%", height: "100%", zIndex: 20 }}
            >
              {points.length >= 2 && (
                <polyline
                  points={ptStr}
                  fill="none"
                  stroke="rgb(99,102,241)"
                  strokeWidth="2"
                  strokeOpacity="0.55"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              {points.map(([x, y], i) => (
                <circle key={i} cx={x} cy={y} r="5" fill="rgb(99,102,241)" fillOpacity="0.7" />
              ))}
            </svg>
          );
        })()}
        <table className="table-fixed w-full text-sm border-collapse">
          <colgroup>
            <col style={{ width: "180px" }} />
            {normalizedDisciplines.map((disc) => (
              <col key={disc.id} style={{ width: "110px" }} />
            ))}
            {topics.map((topicName) => (
              <col key={topicName} style={{ width: "110px" }} />
            ))}
            <col />
            <col style={{ width: "40px" }} />
          </colgroup>
          <thead>
            <tr className="bg-slate-100 border-b border-gray-200">
              <th
                rowSpan={2}
                className="sticky left-0 z-10 bg-slate-100 px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide"
              >
                Student
              </th>
              {normalizedDisciplines.length > 0 && (
                <th
                  colSpan={normalizedDisciplines.length}
                  className="px-2 py-1.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wide border-b border-gray-100"
                >
                  Disciplines
                </th>
              )}
              {topics.length > 0 && (
                <th
                  colSpan={topics.length}
                  className="px-2 py-1.5 text-center text-xs font-semibold text-slate-400 uppercase tracking-wide italic border-l-2 border-slate-400 border-b border-gray-100"
                >
                  Topic Performance
                </th>
              )}
              <th
                rowSpan={2}
                className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide"
              >
                Comment
              </th>
              <th
                rowSpan={2}
                className="px-3 py-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wide"
              >
                <SparklesIcon className="w-4 h-4 mx-auto text-gray-400" />
              </th>
            </tr>
            <tr className="border-b border-gray-200 bg-gray-50">
              {normalizedDisciplines.map((disc, di) => (
                <th
                  key={disc.id}
                  className={`px-1 py-2 text-center text-xs font-semibold text-gray-500 uppercase tracking-wide ${di > 0 ? "border-l border-slate-200" : ""} ${di % 2 === 1 ? "bg-slate-50" : ""}`}
                  title={disc.name}
                >
                  <span className="truncate block max-w-[110px] mx-auto" title={disc.name}>
                    {disc.name}
                  </span>
                </th>
              ))}
              {topics.map((topicName, ti) => (
                <th
                  key={topicName}
                  className={`px-1 py-2 text-center text-xs font-semibold text-slate-500 uppercase tracking-wide ${ti === 0 ? "border-l-2 border-slate-400" : "border-l border-slate-200"}`}
                  title={topicName}
                >
                  <span className="truncate block max-w-[110px] mx-auto italic" title={topicName}>
                    {topicName.length > 10 ? topicName.slice(0, 10) + "…" : topicName}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {normalizedStudents.map((student, si) => {
              const scores = normalizedDisciplines.map(
                (disc) => grid.get(cellKey(student.id, disc.id))?.score ?? null
              );
              const avg = avgScore(scores);
              const isFullyRated = fullyRatedStudentIds.has(student.id);
              const isAnyRated = anyRatedStudentIds.has(student.id);
              const report = reports.get(student.id);
              const isGenerating = generatingStudentId === student.id;
              const rowBg = rowColour(avg);

              return (
                <tr
                  key={student.id}
                  className={`transition-colors hover:brightness-[0.97] ${rowBg} ${dragPreview?.studentId === student.id ? "select-none" : ""}`}
                >
                  <td className={`sticky left-0 z-10 px-4 py-2.5 ${rowBg || "bg-white"}`}>
                    <div className="font-medium text-gray-900 text-sm leading-tight">
                      {student.first_name}{student.last_name ? ` ${student.last_name}` : ""}
                    </div>
                    {(student.gender || student.student_ref_id) && (
                      <div className="text-xs text-gray-400 leading-tight">
                        {[
                          student.gender,
                          student.student_ref_id ? `ID: ${student.student_ref_id}` : null,
                        ].filter(Boolean).join(" • ")}
                      </div>
                    )}
                  </td>

                  {normalizedDisciplines.map((disc, di) => {
                    const key = cellKey(student.id, disc.id);
                    const cell = grid.get(key);
                    const score = cell?.score ?? null;
                    const colBg = di % 2 === 1 ? "bg-slate-50/60" : "";

                    const previewScore = dragPreview?.studentId === student.id
                      ? dragPreview.scores.get(disc.id)
                      : undefined;

                    return (
                      <td
                        key={disc.id}
                        data-disc-id={disc.id}
                        onMouseDown={(e) => {
                          const tr = (e.currentTarget as HTMLElement).closest("tr") as HTMLTableRowElement | null;
                          if (tr) handleDiscMouseDown(e, student.id, tr);
                        }}
                        className={`px-1 py-3 text-center cursor-crosshair ${di > 0 ? "border-l border-slate-200" : ""} ${previewScore !== undefined ? "bg-indigo-50/80" : colBg}`}
                      >
                        <div
                          ref={(el) => {
                            if (el) cellRefs.current.set(navKey(si, di), el);
                            else cellRefs.current.delete(navKey(si, di));
                          }}
                          role="group"
                          aria-label={`${disc.name} score for ${student.first_name}`}
                          tabIndex={0}
                          onBlur={(e) => handleCellBlur(e, student.id, disc.id)}
                          onKeyDown={(e) =>
                            handleCellKeyDown(e, si, di, student.id, disc.id, score)
                          }
                          className="inline-flex gap-px rounded focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-1"
                        >
                          {[1, 2, 3, 4, 5].map((v) => {
                            const active = score === v;
                            const isDragRow = dragPreview?.studentId === student.id;
                            return (
                              <button
                                key={v}
                                type="button"
                                tabIndex={-1}
                                disabled={isReadOnly}
                                onClick={() => handleScoreChange(student.id, disc.id, v)}
                                aria-label={`Score ${v}`}
                                aria-pressed={score === v}
                                className={`w-5 h-5 rounded text-xs font-bold transition-all select-none
                                  ${isReadOnly ? "cursor-default" : "cursor-pointer hover:scale-110"}
                                  ${isDragRow ? "opacity-30" : ""}
                                  ${active
                                    ? "bg-indigo-600 text-white shadow-sm"
                                    : "bg-slate-200 text-slate-700 hover:bg-indigo-100 hover:text-indigo-700"
                                  }`}
                              >
                                {v}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                    );
                  })}

                  {topics.map((topicName, ti) => {
                    const key = `${student.id}|${topicName}`;
                    const score = topicGrid.get(key) ?? null;
                    return (
                      <td
                        key={topicName}
                        className={`px-1 py-3 text-center ${ti === 0 ? "border-l-2 border-slate-400" : "border-l border-slate-200"}`}
                      >
                        <div
                          className="inline-flex gap-px rounded focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-1"
                          tabIndex={0}
                        >
                          {[1, 2, 3, 4, 5].map((v) => {
                            const active = score === v;
                            return (
                              <button
                                key={v}
                                type="button"
                                tabIndex={-1}
                                disabled={isReadOnly}
                                onClick={() => handleTopicScoreChange(student.id, topicName, v)}
                                aria-label={`Topic ${topicName} score ${v}`}
                                className={`w-5 h-5 rounded text-xs font-bold transition-all select-none
                                  ${isReadOnly ? "cursor-default" : "cursor-pointer hover:scale-110"}
                                  ${active
                                    ? "bg-indigo-600 text-white shadow-sm"
                                    : "bg-slate-200 text-slate-700 hover:bg-indigo-100 hover:text-indigo-700"
                                  }`}
                              >
                                {v}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                    );
                  })}

                  <td className="px-2 py-2 w-full">
                    <input
                      id={`comment-${student.id}`}
                      type="text"
                      disabled={isReadOnly}
                      value={comments.get(student.id) ?? ""}
                      onChange={(e) => handleCommentChange(student.id, e.target.value)}
                      onBlur={() => handleCommentBlur(student.id)}
                      placeholder="Key observations…"
                      className="w-full text-xs rounded border border-gray-200 px-2 py-1.5 text-gray-700 placeholder:text-gray-300 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 outline-none transition disabled:bg-gray-50 disabled:text-gray-400"
                    />
                  </td>

                  <td className="px-3 py-2">
                    <ReportStatusCell
                      report={report}
                      studentId={student.id}
                      fullyRated={isFullyRated}
                      anyRated={isAnyRated}
                      isGenerating={isGenerating}
                      isReadOnly={isReadOnly}
                      onGenerate={handleGenerateSingle}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Bulk progress toast */}
      {bulkBatchId !== null && (
        <BulkProgressToast
          sessionId={sessionId}
          batchId={bulkBatchId}
          onDone={() => setBulkDone(true)}
          onReportCreated={onReportCreated}
          onDismiss={() => { setBulkBatchId(null); setBulkDone(false); }}
        />
      )}
    </div>
  );
}
