/**
 * In-browser API router for stateless / session-only mode.
 *
 * apiFetch (frontend/src/lib/api.ts) routes /api/v1/* calls here instead of
 * the network when stateless mode is active. Each handler mirrors the exact
 * response shape of its real server route (referenced in a comment above it)
 * so the pages and components work unchanged.
 *
 * Report generation is free-track only in this mode: the batch-prompt handler
 * builds the prompt client-side (copy into ChatGPT) and parse-reports saves
 * the pasted response. No LLM key, no generation server route.
 */

import {
  loadDB,
  saveDB,
  newId,
  nowISO,
  LocalApiError,
  StatelessDB,
  LocalClass,
  LocalStudent,
  LocalSession,
  LocalDiscipline,
  LocalReport,
  DEMO_ORG_ID,
} from "./store";
import { DISCIPLINE_LIBRARY, findTemplate } from "./discipline-library";
import { buildBatchPrompt } from "@/lib/adapters/llm/prompt-builder";
import { ReportLength } from "@/lib/adapters/llm/types";
import { buildBatchPayloadsFromDB, buildLocalAliasContext } from "./prompt-context";
import { validateAndRemapResponse, buildAliasToNameMap, replaceAliasesInText } from "@/lib/alias-core";
import { countWords } from "@/lib/report-text";

// Mirrors the caps in the real parse-reports route
const MAX_RAW_BYTES = 500_000;
const MAX_REPORTS_PER_BATCH = 50;

export interface LocalResponse {
  status: number;
  json: unknown;
}

type Body = Record<string, unknown>;

type Handler = (
  params: Record<string, string>,
  body: Body,
  query: URLSearchParams
) => LocalResponse | Promise<LocalResponse>;

const ok = (json: unknown): LocalResponse => ({ status: 200, json });
const created = (json: unknown): LocalResponse => ({ status: 201, json });
const noContent = (): LocalResponse => ({ status: 204, json: {} });
const fail = (message: string, code: string, status: number): never => {
  throw new LocalApiError(message, code, status);
};

// ── Lookups ────────────────────────────────────────────────────────────────────

function getClass(db: StatelessDB, classId: string): LocalClass {
  const cls = db.classes.find((c) => c.id === classId);
  if (!cls) fail("Class not found", "CLASS_NOT_FOUND", 404);
  return cls!;
}

function getSession(db: StatelessDB, sessionId: string): LocalSession {
  const s = db.sessions.find((x) => x.id === sessionId);
  if (!s) fail("Session not found", "SESSION_NOT_FOUND", 404);
  return s!;
}

function getStudent(db: StatelessDB, studentId: string): LocalStudent {
  const s = db.students.find((x) => x.id === studentId);
  if (!s) fail("Student not found", "STUDENT_NOT_FOUND", 404);
  return s!;
}

function getReport(db: StatelessDB, reportId: string): LocalReport {
  const r = db.reports.find((x) => x.id === reportId);
  if (!r) fail("Report not found", "REPORT_NOT_FOUND", 404);
  return r!;
}

function sessionDisciplines(db: StatelessDB, sessionId: string): LocalDiscipline[] {
  return db.disciplines
    .filter((d) => d.session_id === sessionId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function classStudents(db: StatelessDB, classId: string): LocalStudent[] {
  return db.students
    .filter((s) => s.class_id === classId)
    .sort((a, b) => a.first_name.localeCompare(b.first_name));
}

// Public shapes (subset of Local* records, matching each real route's select)
function classSummary(c: LocalClass) {
  const { id, name, year_group, subject, archived, created_at, updated_at } = c;
  return { id, name, year_group, subject, archived, created_at, updated_at };
}

function studentSummary(s: LocalStudent) {
  const { id, first_name, last_name, student_ref_id, gender, created_at, updated_at } = s;
  return { id, first_name, last_name, student_ref_id, gender, created_at, updated_at };
}

function sessionSummary(db: StatelessDB, s: LocalSession) {
  return {
    id: s.id,
    name: s.name,
    topics_covered: s.topics_covered,
    tone: s.tone,
    length: s.length,
    status: s.status,
    is_template: s.is_template,
    source_template_id: s.source_template_id,
    created_at: s.created_at,
    updated_at: s.updated_at,
    _count: {
      disciplines: db.disciplines.filter((d) => d.session_id === s.id).length,
      reports: db.reports.filter((r) => r.session_id === s.id).length,
    },
  };
}

function disciplineSummary(d: LocalDiscipline) {
  const { id, name, category, is_custom, created_at } = d;
  return { id, name, category, is_custom, created_at };
}

/** Students with ratings scoped to one session, as GET /sessions/:id(/ratings) returns. */
function studentsWithRatings(db: StatelessDB, session: LocalSession) {
  const disciplineIds = new Set(db.disciplines.filter((d) => d.session_id === session.id).map((d) => d.id));
  return classStudents(db, session.class_id).map((s) => ({
    id: s.id,
    first_name: s.first_name,
    last_name: s.last_name,
    gender: s.gender,
    ratings: db.ratings
      .filter((r) => r.student_id === s.id && disciplineIds.has(r.session_discipline_id))
      .map((r) => ({
        session_discipline_id: r.session_discipline_id,
        score: r.score,
        comment: r.comment,
      })),
  }));
}

function touchRatingsChangedAt(db: StatelessDB, sessionId: string, studentIds: string[]): void {
  const ids = new Set(studentIds);
  for (const report of db.reports) {
    if (report.session_id === sessionId && ids.has(report.student_id)) {
      report.ratings_changed_at = nowISO();
    }
  }
}

// ── LLM generation ─────────────────────────────────────────────────────────────
// Session-only mode is free-track only: reports are created via batch-prompt
// (copy into ChatGPT) + parse-reports (paste the response back). There is no
// server-side LLM key, so the API-generation endpoints answer with a pointer
// to that flow. The UI hides its generate buttons in this mode; this error is
// the safety net for anything missed.

const FREE_MODE_MESSAGE =
  "API generation is not available in session-only mode. Use the free AI flow instead: " +
  "copy the prompt, paste it into ChatGPT (or any AI tool), then paste the response back.";

const freeModeOnly = (): never => fail(FREE_MODE_MESSAGE, "STATELESS_FREE_MODE_ONLY", 501);

// ── Handlers ───────────────────────────────────────────────────────────────────

const routes: Array<{
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}> = [];

/**
 * Register a handler for a path template like "/api/v1/classes/:classId".
 * Templates compile to positional capture groups (the tsconfig target
 * predates named groups).
 */
function route(method: string, template: string, handler: Handler): void {
  const paramNames: string[] = [];
  const source = template
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  routes.push({ method, pattern: new RegExp(`^${source}$`), paramNames, handler });
}

// GET/POST /api/v1/classes — mirrors app/api/v1/classes/route.ts
route("GET", "/api/v1/classes", () => {
  const db = loadDB();
  const data = [...db.classes]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((c) => ({
      ...classSummary(c),
      _count: {
        students: db.students.filter((s) => s.class_id === c.id).length,
        sessions: db.sessions.filter((s) => s.class_id === c.id).length,
      },
    }));
  return ok({ data });
});

route("POST", "/api/v1/classes", (_p, body) => {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) fail("Class name is required", "VALIDATION_ERROR", 400);
  const db = loadDB();
  const stamp = nowISO();
  const cls: LocalClass = {
    id: newId(),
    name,
    year_group: typeof body.year_group === "string" ? body.year_group : null,
    subject: typeof body.subject === "string" ? body.subject : null,
    archived: false,
    created_at: stamp,
    updated_at: stamp,
  };
  db.classes.push(cls);
  saveDB(db);
  return created({ data: classSummary(cls) });
});

// GET/PUT /api/v1/classes/:classId — mirrors app/api/v1/classes/[classId]/route.ts
route("GET", "/api/v1/classes/:classId", (p) => {
  const db = loadDB();
  const cls = getClass(db, p.classId);
  return ok({
    data: {
      ...classSummary(cls),
      students: classStudents(db, cls.id).map(studentSummary),
      sessions: db.sessions
        .filter((s) => s.class_id === cls.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((s) => sessionSummary(db, s)),
    },
  });
});

route("PUT", "/api/v1/classes/:classId", (p, body) => {
  const db = loadDB();
  const cls = getClass(db, p.classId);
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) fail("Class name is required", "VALIDATION_ERROR", 400);
    cls.name = name;
  }
  if (body.year_group !== undefined) cls.year_group = (body.year_group as string | null) ?? null;
  if (body.subject !== undefined) cls.subject = (body.subject as string | null) ?? null;
  cls.updated_at = nowISO();
  saveDB(db);
  return ok({ data: classSummary(cls) });
});

// POST /api/v1/classes/:classId/archive — mirrors .../archive/route.ts
route("POST", "/api/v1/classes/:classId/archive", (p) => {
  const db = loadDB();
  const cls = getClass(db, p.classId);
  cls.archived = true;
  cls.updated_at = nowISO();
  saveDB(db);
  return ok({ data: { id: cls.id, name: cls.name, archived: cls.archived, updated_at: cls.updated_at } });
});

// GET/POST /api/v1/classes/:classId/students — mirrors .../students/route.ts
route("GET", "/api/v1/classes/:classId/students", (p) => {
  const db = loadDB();
  getClass(db, p.classId);
  return ok({ data: classStudents(db, p.classId).map(studentSummary) });
});

route("POST", "/api/v1/classes/:classId/students", (p, body) => {
  const db = loadDB();
  getClass(db, p.classId);
  const first_name = typeof body.first_name === "string" ? body.first_name.trim() : "";
  if (!first_name) fail("first_name is required", "VALIDATION_ERROR", 400);
  const stamp = nowISO();
  const student: LocalStudent = {
    id: newId(),
    class_id: p.classId,
    first_name,
    last_name: (body.last_name as string | undefined) ?? null,
    student_ref_id: (body.student_ref_id as string | undefined) ?? null,
    gender: (body.gender as string | undefined) ?? null,
    internal_notes: (body.internal_notes as string | undefined) ?? null,
    anonymous_token: newId(),
    created_at: stamp,
    updated_at: stamp,
  };
  db.students.push(student);
  saveDB(db);
  return created({ data: studentSummary(student) });
});

// POST /api/v1/classes/:classId/students/bulk — mirrors .../students/bulk/route.ts
route("POST", "/api/v1/classes/:classId/students/bulk", (p, body) => {
  const db = loadDB();
  getClass(db, p.classId);
  const rows = Array.isArray(body.students) ? (body.students as Array<Record<string, unknown>>) : [];
  if (rows.length === 0) fail("students array must not be empty", "VALIDATION_ERROR", 400);
  if (rows.length > 100) fail("Cannot import more than 100 students at once", "VALIDATION_ERROR", 400);

  const normaliseGender = (val: unknown): string | null => {
    if (typeof val !== "string" || !val.trim()) return null;
    const upper = val.trim().toUpperCase();
    if (upper === "M") return "M";
    if (upper === "F") return "F";
    if (upper === "OTHER") return "Other";
    return null;
  };

  const base = Date.now();
  rows.forEach((row, i) => {
    const first_name = typeof row.first_name === "string" ? row.first_name.trim() : "";
    const last_name = typeof row.last_name === "string" ? row.last_name.trim() : "";
    if (!first_name) {
      fail("first_name must be at least 1 character", "VALIDATION_ERROR", 400);
    }
    const stamp = new Date(base + i).toISOString();
    db.students.push({
      id: newId(),
      class_id: p.classId,
      first_name,
      last_name,
      student_ref_id: (row.student_ref_id as string | undefined) ?? null,
      gender: normaliseGender(row.gender),
      internal_notes: (row.internal_notes as string | undefined) ?? null,
      anonymous_token: newId(),
      created_at: stamp,
      updated_at: stamp,
    });
  });
  saveDB(db);
  // Real route returns ALL students of the class after insert, plus insert count
  return created({
    data: classStudents(db, p.classId).map(studentSummary),
    count: rows.length,
  });
});

// PUT/DELETE /api/v1/students/:studentId — mirrors app/api/v1/students/[studentId]/route.ts
route("PUT", "/api/v1/students/:studentId", (p, body) => {
  const db = loadDB();
  const student = getStudent(db, p.studentId);
  const first_name = typeof body.first_name === "string" ? body.first_name.trim() : "";
  if (!first_name) fail("first_name is required", "VALIDATION_ERROR", 400);
  student.first_name = first_name;
  student.last_name = (body.last_name as string | null | undefined) ?? null;
  student.student_ref_id = (body.student_ref_id as string | null | undefined) ?? null;
  student.gender = (body.gender as string | null | undefined) ?? null;
  student.updated_at = nowISO();
  saveDB(db);
  return ok({ data: studentSummary(student) });
});

route("DELETE", "/api/v1/students/:studentId", (p) => {
  const db = loadDB();
  const student = getStudent(db, p.studentId);
  const hasFinal = db.reports.some((r) => r.student_id === student.id && r.status === "final");
  if (hasFinal) {
    fail(
      "Cannot delete student with final reports. Archive the session instead.",
      "STUDENT_HAS_FINAL_REPORTS",
      409
    );
  }
  db.students = db.students.filter((s) => s.id !== student.id);
  db.ratings = db.ratings.filter((r) => r.student_id !== student.id);
  db.topicRatings = db.topicRatings.filter((r) => r.student_id !== student.id);
  db.reports = db.reports.filter((r) => r.student_id !== student.id);
  saveDB(db);
  return noContent();
});

// GET /api/v1/students/:studentId/ratings-history — mirrors .../ratings-history/route.ts
route("GET", "/api/v1/students/:studentId/ratings-history", (p) => {
  const db = loadDB();
  const student = getStudent(db, p.studentId);
  const disciplineById = new Map(db.disciplines.map((d) => [d.id, d]));
  const sessionById = new Map(db.sessions.map((s) => [s.id, s]));
  const classById = new Map(db.classes.map((c) => [c.id, c]));

  const grouped = new Map<
    string,
    { sessionName: string; className: string; createdAt: string; disciplines: Array<{ name: string; score: number | null }> }
  >();

  const studentRatings = db.ratings
    .filter((r) => r.student_id === student.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  for (const r of studentRatings) {
    const disc = disciplineById.get(r.session_discipline_id);
    if (!disc) continue;
    const session = sessionById.get(disc.session_id);
    if (!session) continue;
    const existing = grouped.get(session.id);
    if (!existing) {
      grouped.set(session.id, {
        sessionName: session.name,
        className: classById.get(session.class_id)?.name ?? "",
        createdAt: r.created_at,
        disciplines: [{ name: disc.name, score: r.score }],
      });
    } else {
      existing.disciplines.push({ name: disc.name, score: r.score });
    }
  }

  const history = [...grouped.entries()].map(([sessionId, data]) => ({ sessionId, ...data }));
  return ok({ history });
});

// GET /api/v1/students/:studentId/reports — mirrors .../reports/route.ts
route("GET", "/api/v1/students/:studentId/reports", (p) => {
  const db = loadDB();
  const student = getStudent(db, p.studentId);
  const sessionById = new Map(db.sessions.map((s) => [s.id, s]));
  const classById = new Map(db.classes.map((c) => [c.id, c]));
  const data = db.reports
    .filter((r) => r.student_id === student.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((r) => {
      const session = sessionById.get(r.session_id);
      const cls = session ? classById.get(session.class_id) : undefined;
      return {
        id: r.id,
        status: r.status,
        word_count: r.word_count,
        edited_content: r.edited_content,
        created_at: r.created_at,
        updated_at: r.updated_at,
        session: session
          ? { id: session.id, name: session.name, class: cls ? { id: cls.id, name: cls.name } : null }
          : null,
      };
    });
  return ok({ data });
});

// GET/POST /api/v1/classes/:classId/sessions — mirrors .../sessions/route.ts
route("GET", "/api/v1/classes/:classId/sessions", (p) => {
  const db = loadDB();
  getClass(db, p.classId);
  const data = db.sessions
    .filter((s) => s.class_id === p.classId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((s) => sessionSummary(db, s));
  return ok({ data });
});

route("POST", "/api/v1/classes/:classId/sessions", (p, body) => {
  const db = loadDB();
  getClass(db, p.classId);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) fail("Session name is required", "VALIDATION_ERROR", 400);

  const stamp = nowISO();
  const session: LocalSession = {
    id: newId(),
    class_id: p.classId,
    name,
    topics_covered: Array.isArray(body.topics_covered) ? (body.topics_covered as string[]) : [],
    tone: typeof body.tone === "string" ? body.tone : "balanced",
    length: typeof body.length === "string" ? body.length : "medium",
    status: "draft",
    is_template: false,
    source_template_id: null,
    test_filters: null,
    progression_filters: [],
    enable_progression: false,
    allow_negative_progression: false,
    class_overview: null,
    created_at: stamp,
    updated_at: stamp,
  };
  db.sessions.push(session);

  const templateIds = Array.isArray(body.templateDisciplineIds)
    ? (body.templateDisciplineIds as string[])
    : [];
  const customs = Array.isArray(body.customDisciplines)
    ? (body.customDisciplines as Array<{ name: string; category?: string }>)
    : [];

  const disciplineData = [
    ...templateIds
      .map((id) => findTemplate(id))
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
      .map((t) => ({ name: t.name, category: t.category as string | null, is_custom: false })),
    ...customs.map((c) => ({ name: c.name, category: c.category ?? null, is_custom: true })),
  ];

  const base = Date.now();
  disciplineData.forEach((d, i) => {
    db.disciplines.push({
      id: newId(),
      session_id: session.id,
      name: d.name,
      category: d.category,
      is_custom: d.is_custom,
      created_at: new Date(base + i).toISOString(),
    });
  });
  saveDB(db);

  return created({
    data: {
      id: session.id,
      organization_id: DEMO_ORG_ID,
      class_id: session.class_id,
      name: session.name,
      topics_covered: session.topics_covered,
      tone: session.tone,
      length: session.length,
      status: session.status,
      created_at: session.created_at,
      updated_at: session.updated_at,
      _count: {
        disciplines: disciplineData.length,
        reports: 0,
      },
      disciplines: sessionDisciplines(db, session.id).map(disciplineSummary),
    },
  });
});

// GET /api/v1/classes/:classId/tests and /api/v1/sessions/:sessionId/tests — stubs (tests module out of scope)
route("GET", "/api/v1/classes/:classId/tests", () => ok({ data: [] }));
route("GET", "/api/v1/sessions/:sessionId/tests", () => ok({ data: [] }));

// GET/PUT/DELETE /api/v1/sessions/:sessionId — mirrors app/api/v1/sessions/[sessionId]/route.ts
route("GET", "/api/v1/sessions/:sessionId", (p) => {
  const db = loadDB();
  const s = getSession(db, p.sessionId);
  const disciplines = sessionDisciplines(db, s.id).map(disciplineSummary);
  return ok({
    data: {
      session: {
        id: s.id,
        organization_id: DEMO_ORG_ID,
        class_id: s.class_id,
        name: s.name,
        topics_covered: s.topics_covered,
        tone: s.tone,
        length: s.length,
        status: s.status,
        is_template: s.is_template,
        source_template_id: s.source_template_id,
        test_filters: s.test_filters,
        progression_filters: s.progression_filters,
        enable_progression: s.enable_progression,
        allow_negative_progression: s.allow_negative_progression,
        class_overview: s.class_overview,
        created_at: s.created_at,
        updated_at: s.updated_at,
        disciplines,
      },
      students: studentsWithRatings(db, s),
      disciplines,
    },
  });
});

route("PUT", "/api/v1/sessions/:sessionId", (p, body) => {
  const db = loadDB();
  const s = getSession(db, p.sessionId);

  if (body.topics_covered !== undefined && Array.isArray(body.topics_covered)) {
    const newTopics = body.topics_covered as string[];
    const removed = s.topics_covered.filter((t) => !newTopics.includes(t));
    if (removed.length > 0) {
      const removedSet = new Set(removed);
      db.topicRatings = db.topicRatings.filter(
        (tr) => !(tr.session_id === s.id && removedSet.has(tr.topic_name))
      );
    }
    s.topics_covered = newTopics;
  }
  if (typeof body.name === "string" && body.name.trim()) s.name = body.name.trim();
  if (typeof body.tone === "string") s.tone = body.tone;
  if (typeof body.length === "string") s.length = body.length;
  if (typeof body.status === "string") s.status = body.status;
  if (body.test_filters !== undefined) {
    s.test_filters = (body.test_filters as LocalSession["test_filters"]) ?? null;
  }
  if (Array.isArray(body.progression_filters)) s.progression_filters = body.progression_filters as string[];
  if (typeof body.enable_progression === "boolean") s.enable_progression = body.enable_progression;
  if (typeof body.allow_negative_progression === "boolean") {
    s.allow_negative_progression = body.allow_negative_progression;
  }
  if (body.class_overview !== undefined) s.class_overview = (body.class_overview as string | null) ?? null;
  s.updated_at = nowISO();
  saveDB(db);

  return ok({
    data: {
      id: s.id,
      name: s.name,
      topics_covered: s.topics_covered,
      tone: s.tone,
      length: s.length,
      status: s.status,
      test_filters: s.test_filters,
      progression_filters: s.progression_filters,
      enable_progression: s.enable_progression,
      allow_negative_progression: s.allow_negative_progression,
      class_overview: s.class_overview,
      created_at: s.created_at,
      updated_at: s.updated_at,
    },
  });
});

route("DELETE", "/api/v1/sessions/:sessionId", (p) => {
  const db = loadDB();
  const s = getSession(db, p.sessionId);
  const disciplineIds = new Set(db.disciplines.filter((d) => d.session_id === s.id).map((d) => d.id));
  db.reports = db.reports.filter((r) => r.session_id !== s.id);
  db.ratings = db.ratings.filter((r) => !disciplineIds.has(r.session_discipline_id));
  db.topicRatings = db.topicRatings.filter((tr) => tr.session_id !== s.id);
  db.disciplines = db.disciplines.filter((d) => d.session_id !== s.id);
  db.sessions = db.sessions.filter((x) => x.id !== s.id);
  saveDB(db);
  return noContent();
});

// POST /api/v1/sessions/:sessionId/duplicate — mirrors .../duplicate/route.ts
route("POST", "/api/v1/sessions/:sessionId/duplicate", (p, body) => {
  const db = loadDB();
  const source = getSession(db, p.sessionId);
  const targetClassId =
    typeof body.targetClassId === "string" && body.targetClassId.trim()
      ? body.targetClassId.trim()
      : source.class_id;
  if (targetClassId !== source.class_id) {
    const target = db.classes.find((c) => c.id === targetClassId);
    if (!target) fail("Target class not found", "CLASS_NOT_FOUND", 404);
  }

  const stamp = nowISO();
  const copy: LocalSession = {
    ...source,
    id: newId(),
    class_id: targetClassId,
    name: `${source.name} (Copy)`,
    status: "draft",
    is_template: false,
    source_template_id: null,
    test_filters: null,
    progression_filters: [],
    created_at: stamp,
    updated_at: stamp,
  };
  db.sessions.push(copy);

  const base = Date.now();
  sessionDisciplines(db, source.id).forEach((d, i) => {
    db.disciplines.push({
      id: newId(),
      session_id: copy.id,
      name: d.name,
      category: d.category,
      is_custom: d.is_custom,
      created_at: new Date(base + i).toISOString(),
    });
  });
  saveDB(db);

  return created({
    data: {
      id: copy.id,
      class_id: copy.class_id,
      name: copy.name,
      topics_covered: copy.topics_covered,
      tone: copy.tone,
      length: copy.length,
      status: copy.status,
      created_at: copy.created_at,
      updated_at: copy.updated_at,
      disciplines: sessionDisciplines(db, copy.id).map(disciplineSummary),
    },
  });
});

// GET/POST /api/v1/sessions/:sessionId/disciplines — mirrors .../disciplines/route.ts
route("GET", "/api/v1/sessions/:sessionId/disciplines", (p) => {
  const db = loadDB();
  getSession(db, p.sessionId);
  return ok({ data: sessionDisciplines(db, p.sessionId).map(disciplineSummary) });
});

route("POST", "/api/v1/sessions/:sessionId/disciplines", (p, body) => {
  const db = loadDB();
  getSession(db, p.sessionId);

  let name: string;
  let category: string | null = null;
  let isCustom = false;

  if (typeof body.templateId === "string" && body.templateId) {
    const template = findTemplate(body.templateId);
    if (!template) fail("Discipline template not found", "TEMPLATE_NOT_FOUND", 404);
    name = template!.name;
    category = template!.category;
  } else if (typeof body.name === "string" && body.name.trim()) {
    name = body.name.trim();
    category = (body.category as string | undefined) ?? null;
    isCustom = true;
  } else {
    return fail(
      "Provide either templateId (from library) or name (custom discipline)",
      "VALIDATION_ERROR",
      400
    );
  }

  const discipline: LocalDiscipline = {
    id: newId(),
    session_id: p.sessionId,
    name,
    category,
    is_custom: isCustom,
    created_at: nowISO(),
  };
  db.disciplines.push(discipline);
  saveDB(db);
  return created({ data: disciplineSummary(discipline) });
});

// DELETE /api/v1/sessions/:sessionId/disciplines/:disciplineId
route(
  "DELETE",
  "/api/v1/sessions/:sessionId/disciplines/:disciplineId",
  (p) => {
    const db = loadDB();
    getSession(db, p.sessionId);
    const discipline = db.disciplines.find(
      (d) => d.id === p.disciplineId && d.session_id === p.sessionId
    );
    if (!discipline) fail("Discipline not found in this session", "DISCIPLINE_NOT_FOUND", 404);
    const hasRatings = db.ratings.some((r) => r.session_discipline_id === p.disciplineId);
    if (hasRatings) {
      fail(
        "Cannot delete discipline with existing ratings. Delete ratings first.",
        "DISCIPLINE_HAS_RATINGS",
        409
      );
    }
    db.disciplines = db.disciplines.filter((d) => d.id !== p.disciplineId);
    saveDB(db);
    return noContent();
  }
);

// GET/POST /api/v1/sessions/:sessionId/ratings — mirrors .../ratings/route.ts
route("GET", "/api/v1/sessions/:sessionId/ratings", (p) => {
  const db = loadDB();
  const s = getSession(db, p.sessionId);
  return ok({
    students: studentsWithRatings(db, s),
    disciplines: sessionDisciplines(db, s.id).map(disciplineSummary),
  });
});

route("POST", "/api/v1/sessions/:sessionId/ratings", (p, body) => {
  const db = loadDB();
  const s = getSession(db, p.sessionId);
  const incoming = Array.isArray(body.ratings)
    ? (body.ratings as Array<{ studentId: string; sessionDisciplineId: string; score: number; comment?: string | null }>)
    : [];
  if (incoming.length === 0) fail("ratings array must not be empty", "VALIDATION_ERROR", 400);

  const classStudentIds = new Set(classStudents(db, s.class_id).map((x) => x.id));
  const disciplineIds = new Set(db.disciplines.filter((d) => d.session_id === s.id).map((d) => d.id));

  for (const r of incoming) {
    if (!classStudentIds.has(r.studentId)) {
      fail(`Student ${r.studentId} does not belong to this session's class`, "STUDENT_NOT_IN_CLASS", 422);
    }
    if (!disciplineIds.has(r.sessionDisciplineId)) {
      fail(`Discipline ${r.sessionDisciplineId} does not belong to this session`, "DISCIPLINE_NOT_IN_SESSION", 422);
    }
    if (typeof r.score !== "number" || r.score < 1 || r.score > 5) {
      fail("score must be an integer between 1 and 5", "VALIDATION_ERROR", 400);
    }
  }

  const existingByKey = new Map(
    db.ratings.map((r) => [`${r.student_id}|${r.session_discipline_id}`, r])
  );

  let createdCount = 0;
  let updatedCount = 0;
  const stamp = nowISO();
  for (const r of incoming) {
    const existing = existingByKey.get(`${r.studentId}|${r.sessionDisciplineId}`);
    if (existing) {
      existing.score = r.score;
      existing.comment = r.comment ?? null;
      existing.updated_at = stamp;
      updatedCount++;
    } else {
      const record = {
        id: newId(),
        student_id: r.studentId,
        session_discipline_id: r.sessionDisciplineId,
        score: r.score,
        comment: r.comment ?? null,
        created_at: stamp,
        updated_at: stamp,
      };
      db.ratings.push(record);
      existingByKey.set(`${r.studentId}|${r.sessionDisciplineId}`, record);
      createdCount++;
    }
  }

  touchRatingsChangedAt(db, s.id, incoming.map((r) => r.studentId));
  saveDB(db);

  return ok({ message: "Ratings saved", created: createdCount, updated: updatedCount, total: incoming.length });
});

// GET /api/v1/sessions/:sessionId/topic-ratings — mirrors .../topic-ratings/route.ts
route("GET", "/api/v1/sessions/:sessionId/topic-ratings", (p) => {
  const db = loadDB();
  const s = getSession(db, p.sessionId);
  const ratings = db.topicRatings
    .filter((tr) => tr.session_id === s.id)
    .sort((a, b) => a.student_id.localeCompare(b.student_id) || a.topic_name.localeCompare(b.topic_name))
    .map((tr) => ({ studentId: tr.student_id, topicName: tr.topic_name, score: tr.score }));
  return ok({ topics: s.topics_covered, ratings });
});

// POST /api/v1/sessions/:sessionId/topic-ratings/bulk — mirrors .../topic-ratings/bulk/route.ts
route("POST", "/api/v1/sessions/:sessionId/topic-ratings/bulk", (p, body) => {
  const db = loadDB();
  const s = getSession(db, p.sessionId);
  const incoming = Array.isArray(body.ratings)
    ? (body.ratings as Array<{ studentId: string; topicName: string; score: number }>)
    : [];
  if (incoming.length === 0) fail("ratings array must not be empty", "VALIDATION_ERROR", 422);

  const topicsSet = new Set(s.topics_covered);
  const invalidTopics = [...new Set(incoming.map((r) => r.topicName).filter((t) => !topicsSet.has(t)))];
  if (invalidTopics.length > 0) {
    fail(`Topic(s) not in session: ${invalidTopics.join(", ")}`, "INVALID_TOPIC", 422);
  }

  const classStudentIds = new Set(classStudents(db, s.class_id).map((x) => x.id));
  const invalidStudents = [...new Set(incoming.map((r) => r.studentId).filter((id) => !classStudentIds.has(id)))];
  if (invalidStudents.length > 0) {
    fail(`Student(s) not in session's class: ${invalidStudents.join(", ")}`, "INVALID_STUDENT", 422);
  }

  const existingByKey = new Map(
    db.topicRatings
      .filter((tr) => tr.session_id === s.id)
      .map((tr) => [`${tr.student_id}|${tr.topic_name}`, tr])
  );

  let createdCount = 0;
  let updatedCount = 0;
  for (const r of incoming) {
    const existing = existingByKey.get(`${r.studentId}|${r.topicName}`);
    if (existing) {
      existing.score = r.score;
      updatedCount++;
    } else {
      const record = {
        id: newId(),
        session_id: s.id,
        student_id: r.studentId,
        topic_name: r.topicName,
        score: r.score,
      };
      db.topicRatings.push(record);
      existingByKey.set(`${r.studentId}|${r.topicName}`, record);
      createdCount++;
    }
  }

  touchRatingsChangedAt(db, s.id, incoming.map((r) => r.studentId));
  saveDB(db);

  return ok({ data: { created: createdCount, updated: updatedCount, total: createdCount + updatedCount } });
});

// GET /api/v1/sessions/:sessionId/reports — mirrors .../reports/route.ts
route("GET", "/api/v1/sessions/:sessionId/reports", (p) => {
  const db = loadDB();
  getSession(db, p.sessionId);
  const studentById = new Map(db.students.map((s) => [s.id, s]));
  const reports = db.reports
    .filter((r) => r.session_id === p.sessionId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((r) => {
      const student = studentById.get(r.student_id);
      return {
        id: r.id,
        student_id: r.student_id,
        status: r.status,
        word_count: r.word_count,
        edited_content: r.edited_content,
        ratings_changed_at: r.ratings_changed_at,
        created_at: r.created_at,
        updated_at: r.updated_at,
        student: student
          ? { id: student.id, first_name: student.first_name, last_name: student.last_name, gender: student.gender }
          : null,
      };
    });
  return ok({ reports });
});

// GET /api/v1/sessions/:sessionId/progression-data — mirrors .../progression-data/route.ts
route("GET", "/api/v1/sessions/:sessionId/progression-data", (p, _b, query) => {
  const db = loadDB();
  const current = getSession(db, p.sessionId);

  const previous = db.sessions
    .filter((s) => s.class_id === current.class_id && s.status === "complete" && s.id !== current.id)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  if (!previous) return ok({ previousSession: null, matchedDisciplines: [] });

  const currentDisciplineIds = new Set(
    db.disciplines.filter((d) => d.session_id === current.id).map((d) => d.id)
  );

  let studentId = query.get("studentId");
  if (!studentId) {
    const firstRating = db.ratings.find((r) => currentDisciplineIds.has(r.session_discipline_id));
    studentId = firstRating?.student_id ?? null;
  }

  const previousSession = { id: previous.id, name: previous.name, completed_at: previous.updated_at };
  if (!studentId) return ok({ previousSession, matchedDisciplines: [] });

  const disciplineById = new Map(db.disciplines.map((d) => [d.id, d]));
  const scoreByName = (sessionId: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const r of db.ratings) {
      const disc = disciplineById.get(r.session_discipline_id);
      if (disc && disc.session_id === sessionId && r.student_id === studentId) {
        map.set(disc.name, r.score);
      }
    }
    return map;
  };

  const currentScores = scoreByName(current.id);
  const previousScores = scoreByName(previous.id);
  const matchedDisciplines: Array<{ name: string; currentScore: number; previousScore: number; trend: string }> = [];
  for (const [name, currentScore] of currentScores) {
    const previousScore = previousScores.get(name);
    if (previousScore === undefined) continue;
    const trend =
      currentScore > previousScore ? "improved" : currentScore < previousScore ? "declined" : "maintained";
    matchedDisciplines.push({ name, currentScore, previousScore, trend });
  }

  return ok({ previousSession, matchedDisciplines });
});

// GET /api/v1/sessions/:sessionId/batch-prompt — mirrors .../batch-prompt/route.ts, built fully client-side
route("GET", "/api/v1/sessions/:sessionId/batch-prompt", (p, _b, query) => {
  const db = loadDB();
  const s = getSession(db, p.sessionId);

  const rawIds = query.getAll("studentIds").flatMap((v) => v.split(","));
  const studentIds = rawIds.filter(Boolean);
  if (studentIds.length === 0) fail("studentIds query param required", "VALIDATION_ERROR", 400);
  if (studentIds.length > 5) fail("Maximum 5 students per batch prompt", "BATCH_TOO_LARGE", 422);

  const students = studentIds.map((id) => db.students.find((x) => x.id === id));
  if (students.some((x) => !x)) fail("One or more students not found", "STUDENT_NOT_FOUND", 404);
  // Every student must belong to this session's class, because that is the
  // roster the alias map is built from. Anyone outside it would have no alias.
  if (students.some((x) => x!.class_id !== s.class_id)) {
    fail("One or more students are not in this session's class", "STUDENT_NOT_IN_CLASS", 400);
  }

  // Same alias privacy pipeline as the real route — the prompt carries
  // Student_NN aliases, never real names.
  const { aliasMap, nameToAlias } = buildLocalAliasContext(db, s);
  const payloads = buildBatchPayloadsFromDB(db, s, students as LocalStudent[], aliasMap);
  const prompt = buildBatchPrompt(
    payloads,
    {
      tone: s.tone,
      length: s.length as ReportLength,
      testInstruction: null,
    },
    { useAliases: true, nameToAlias }
  );
  return ok({ prompt });
});

// POST /api/v1/sessions/:sessionId/parse-reports — mirrors .../parse-reports/route.ts
// (alias pipeline: the pasted AI response contains Student_NN aliases which are
// remapped back to students, and aliases inside report text become real names)
route("POST", "/api/v1/sessions/:sessionId/parse-reports", (p, body) => {
  const db = loadDB();
  const s = getSession(db, p.sessionId);

  const raw = typeof body.raw === "string" ? body.raw : "";
  const studentIds = Array.isArray(body.studentIds) ? (body.studentIds as string[]) : [];
  if (!raw || raw.length > MAX_RAW_BYTES) {
    fail(raw ? "Pasted content is too large" : "raw is required", "VALIDATION_ERROR", 400);
  }
  if (studentIds.length === 0 || studentIds.length > MAX_REPORTS_PER_BATCH) {
    fail(
      studentIds.length === 0
        ? "studentIds is required"
        : `Too many student IDs — maximum ${MAX_REPORTS_PER_BATCH} per batch`,
      "VALIDATION_ERROR",
      400
    );
  }

  const { aliasMap, classStudents } = buildLocalAliasContext(db, s);
  const validation = validateAndRemapResponse(raw, aliasMap, studentIds);
  const aliasToName = buildAliasToNameMap(classStudents, aliasMap);

  if (validation.reports.length + validation.errors.length > MAX_REPORTS_PER_BATCH) {
    fail(
      `Input exceeds maximum allowed size — received ${validation.reports.length + validation.errors.length} report items, maximum is ${MAX_REPORTS_PER_BATCH}`,
      "INPUT_TOO_LARGE",
      422
    );
  }

  // The real route stores the full raw paste on every report row (Postgres
  // doesn't care), but here N copies of a large paste would blow the ~5 MB
  // sessionStorage quota — keep a bounded excerpt per report instead.
  const RAW_EXCERPT_CHARS = 10_000;
  const rawExcerpt =
    raw.length > RAW_EXCERPT_CHARS ? `${raw.slice(0, RAW_EXCERPT_CHARS)}\n… [truncated]` : raw;

  const studentById = new Map(db.students.map((x) => [x.id, x]));
  const results: Array<{ studentId: string; name: string; success: boolean; error?: string }> = [];
  let saved = 0;
  let failed = 0;
  const stamp = nowISO();

  for (const err of validation.errors) {
    failed++;
    const sid = err.studentId ?? "unknown";
    const student = studentById.get(sid);
    results.push({
      studentId: sid,
      name: student?.first_name ?? err.alias ?? "Unknown",
      success: false,
      error: err.error,
    });
  }

  for (const remapped of validation.reports) {
    const student = studentById.get(remapped.studentId);
    if (!student) {
      failed++;
      results.push({ studentId: remapped.studentId, name: "Unknown", success: false, error: "Student not found after remap" });
      continue;
    }
    if (!studentIds.includes(remapped.studentId)) {
      failed++;
      results.push({ studentId: remapped.studentId, name: student.first_name, success: false, error: "Student not in the requested batch" });
      continue;
    }

    const reportText = replaceAliasesInText(remapped.report, aliasToName);
    const wordCount = countWords(reportText);

    const existing = db.reports.find(
      (r) => r.session_id === s.id && r.student_id === remapped.studentId
    );
    if (existing) {
      existing.llm_model = "free_model";
      existing.llm_raw_response = rawExcerpt;
      existing.edited_content = reportText;
      existing.status = "draft";
      existing.word_count = wordCount;
      existing.updated_at = stamp;
    } else {
      db.reports.push({
        id: newId(),
        student_id: remapped.studentId,
        session_id: s.id,
        anonymous_token: student.anonymous_token,
        llm_model: "free_model",
        llm_prompt: null,
        llm_raw_response: rawExcerpt,
        edited_content: reportText,
        status: "draft",
        word_count: wordCount,
        ratings_changed_at: null,
        created_at: stamp,
        updated_at: stamp,
      });
    }
    saved++;
    results.push({ studentId: remapped.studentId, name: student.first_name, success: true });
  }
  saveDB(db);

  return ok({
    results,
    saved,
    failed,
    flaggedForReview: validation.flaggedForReview,
    reviewReasons: validation.reviewReasons,
  });
});

// GET/PUT /api/v1/reports/:reportId — mirrors app/api/v1/reports/[reportId]/route.ts
route("GET", "/api/v1/reports/:reportId", (p) => {
  const db = loadDB();
  const r = getReport(db, p.reportId);
  const student = db.students.find((s) => s.id === r.student_id);
  const session = db.sessions.find((s) => s.id === r.session_id);
  return ok({
    report: {
      id: r.id,
      student_id: r.student_id,
      session_id: r.session_id,
      status: r.status,
      word_count: r.word_count,
      edited_content: r.edited_content,
      llm_model: r.llm_model,
      llm_prompt: r.llm_prompt,
      llm_raw_response: r.llm_raw_response,
      ratings_changed_at: r.ratings_changed_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
      student: student
        ? { id: student.id, first_name: student.first_name, last_name: student.last_name, gender: student.gender }
        : null,
      session: session
        ? { id: session.id, name: session.name, tone: session.tone, length: session.length }
        : null,
    },
  });
});

route("PUT", "/api/v1/reports/:reportId", (p, body) => {
  const db = loadDB();
  const r = getReport(db, p.reportId);
  const editedContent = typeof body.edited_content === "string" ? body.edited_content : undefined;
  const status = typeof body.status === "string" ? body.status : undefined;
  if (editedContent === undefined && status === undefined) {
    fail("At least one of edited_content or status is required", "VALIDATION_ERROR", 400);
  }
  // Mirror the real route's Zod rules — empty content would later break the
  // PDF export schema (reportText min 1)
  if (editedContent !== undefined && editedContent.length === 0) {
    fail("edited_content must not be empty", "VALIDATION_ERROR", 400);
  }
  if (status !== undefined && !["draft", "edited", "final"].includes(status)) {
    fail("status must be one of draft, edited, final", "VALIDATION_ERROR", 400);
  }
  if (editedContent !== undefined) {
    r.edited_content = editedContent;
    r.word_count = countWords(editedContent);
    if (!status) r.status = "edited";
  }
  if (status !== undefined) r.status = status;
  r.updated_at = nowISO();
  saveDB(db);
  return ok({
    report: {
      id: r.id,
      student_id: r.student_id,
      session_id: r.session_id,
      status: r.status,
      word_count: r.word_count,
      edited_content: r.edited_content,
      llm_raw_response: r.llm_raw_response,
      created_at: r.created_at,
      updated_at: r.updated_at,
    },
  });
});

// API-generation endpoints — free-track only in session-only mode (see above)
route("POST", "/api/v1/reports/:reportId/redo", () => freeModeOnly());
route("POST", "/api/v1/sessions/:sessionId/students/:studentId/generate", () => freeModeOnly());
route("POST", "/api/v1/sessions/:sessionId/generate/bulk", () => freeModeOnly());
route("GET", "/api/v1/sessions/:sessionId/generate/bulk/:batchId/status", () => freeModeOnly());

// GET /api/v1/discipline-templates — mirrors app/api/v1/discipline-templates/route.ts
route("GET", "/api/v1/discipline-templates", () => {
  const grouped: Record<string, Array<{ id: string; name: string; is_default: boolean }>> = {};
  for (const t of [...DISCIPLINE_LIBRARY].sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)
  )) {
    (grouped[t.category] ??= []).push({ id: t.id, name: t.name, is_default: t.is_default });
  }
  const data = Object.entries(grouped).map(([category, disciplines]) => ({ category, disciplines }));
  return ok({ data, total: DISCIPLINE_LIBRARY.length });
});

// GET /api/v1/settings — static stub; session-only mode is free-track only
route("GET", "/api/v1/settings", () =>
  ok({
    org_name: "Session-only mode",
    llm_provider: "free",
    model: "free_model",
    has_api_key: false,
  })
);

// ── Entry point ────────────────────────────────────────────────────────────────

export async function handleLocal(
  method: string,
  path: string,
  body: unknown
): Promise<LocalResponse> {
  const url = new URL(path, "http://local");
  const pathname = url.pathname;

  for (const r of routes) {
    if (r.method !== method.toUpperCase()) continue;
    const match = pathname.match(r.pattern);
    if (!match) continue;
    const params: Record<string, string> = {};
    r.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });
    try {
      return await r.handler(params, (body ?? {}) as Body, url.searchParams);
    } catch (err) {
      if (err instanceof LocalApiError) {
        return { status: err.status, json: { error: err.message, code: err.code } };
      }
      console.error("[stateless] handler error", method, pathname, err);
      return { status: 500, json: { error: "Internal error in session-only mode", code: "INTERNAL_ERROR" } };
    }
  }

  return {
    status: 404,
    json: { error: "Not available in session-only mode", code: "STATELESS_UNSUPPORTED" },
  };
}
