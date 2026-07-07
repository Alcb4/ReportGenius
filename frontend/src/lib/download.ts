/**
 * Mode-aware export download helper.
 *
 * Normal mode: authenticated GET to the export route, blob-download the result
 * (moved here from the inline downloadWithAuth helpers in the session detail
 * and review pages).
 *
 * Stateless / session-only mode: the DB-backed export routes can't serve us,
 * so the report data is read from the sessionStorage store and POSTed to the
 * prisma-free /api/v1/stateless/export/* routes instead.
 */

import { isStateless } from "./stateless/mode";
import { getToken } from "./auth";

function triggerDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

async function fetchBlob(url: string, init?: RequestInit): Promise<Blob> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = `Export failed: HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON body
    }
    throw new Error(message);
  }
  return response.blob();
}

// ── Stateless-mode export payload assembly ────────────────────────────────────

interface StatelessExportPlan {
  url: string;
  body: unknown;
  filename: string | null; // override, when we can compute a better name
}

async function planStatelessExport(url: string): Promise<StatelessExportPlan> {
  const { loadDB } = await import("./stateless/store");
  const db = loadDB();

  const reportPdf = url.match(/^\/api\/v1\/reports\/([^/]+)\/export\/pdf$/);
  if (reportPdf) {
    const report = db.reports.find((r) => r.id === reportPdf[1]);
    if (!report) throw new Error("Report not found");
    const student = db.students.find((s) => s.id === report.student_id);
    const session = db.sessions.find((s) => s.id === report.session_id);
    return {
      url: "/api/v1/stateless/export/pdf",
      body: {
        reports: [
          {
            firstName: student?.first_name ?? "Student",
            className: session?.name ?? "",
            term: null,
            reportText: report.edited_content,
            generatedAt: report.created_at,
          },
        ],
      },
      filename: session && student ? `${session.name} - ${student.first_name}.pdf` : null,
    };
  }

  const sessionExport = url.match(/^\/api\/v1\/sessions\/([^/]+)\/export\/(pdf|csv)$/);
  if (sessionExport) {
    const [, sessionId, kind] = sessionExport;
    const session = db.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error("Session not found");
    const studentById = new Map(db.students.map((s) => [s.id, s]));
    const reports = db.reports
      .filter((r) => r.session_id === sessionId)
      .sort((a, b) =>
        (studentById.get(a.student_id)?.first_name ?? "").localeCompare(
          studentById.get(b.student_id)?.first_name ?? ""
        )
      );
    if (reports.length === 0) throw new Error("No reports found for this session");

    if (kind === "pdf") {
      return {
        url: "/api/v1/stateless/export/pdf",
        body: {
          reports: reports.map((r) => ({
            firstName: studentById.get(r.student_id)?.first_name ?? "Student",
            className: session.name,
            term: null,
            reportText: r.edited_content,
            generatedAt: r.created_at,
          })),
          // Session export always downloads as session_reports.zip, so the
          // payload must be a ZIP even when only one report exists.
          bundle: true,
        },
        filename: null,
      };
    }

    return {
      url: "/api/v1/stateless/export/xlsx",
      body: {
        rows: reports.map((r) => {
          const student = studentById.get(r.student_id);
          return {
            ref_id: student?.student_ref_id ?? "",
            first_name: student?.first_name ?? "",
            last_name: student?.last_name ?? "",
            gender: student?.gender ?? "",
            session_name: session.name,
            status: r.status,
            word_count: r.word_count ?? 0,
            report_text: r.edited_content,
            generated_at: r.created_at,
          };
        }),
      },
      filename: null,
    };
  }

  throw new Error("This export is not available in session-only mode");
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function downloadExport(url: string, filename: string): Promise<void> {
  if (isStateless()) {
    const plan = await planStatelessExport(url);
    const blob = await fetchBlob(plan.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plan.body),
    });
    triggerDownload(blob, plan.filename ?? filename);
    return;
  }

  const token = typeof window !== "undefined" ? getToken() : null;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const blob = await fetchBlob(url, { headers });
  triggerDownload(blob, filename);
}
