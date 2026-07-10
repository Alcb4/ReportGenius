# Report Genius — Agent Memory

## Architecture Notes

### Vercel deployment
- The repo root has two services (`frontend/` Next.js app, `backend/` Express/BullMQ worker); `backend/` is not Vercel-deployable (long-running worker), so only `frontend/` is deployed.
- The Vercel project's **Root Directory is set to `frontend`** (Project Settings → General). `vercel.json` must live at `frontend/vercel.json` to be read at all — a root-level `vercel.json` is silently ignored once Root Directory is set. It currently only declares the `/api/cron/cleanup` cron; the Next.js framework/build is auto-detected, no explicit build/install commands needed.
- If deploys stop updating (stuck on an old build despite pushes to `main`), check **Settings → Git** first — the GitHub integration can silently disconnect with no visible error. Reconnecting doesn't retroactively build missed commits; push a new commit (an empty one is fine) to force the webhook.

### Stateless / session-only mode (no database)
- Activated by `NEXT_PUBLIC_STATELESS=true` (whole site) or per-tab via the "Continue without an account" button on `/login` (sets sessionStorage `rg_stateless=1`). Server routes additionally gate on `STATELESS_ENABLED=true`.
- `apiFetch` (`frontend/src/lib/api.ts`) intercepts all `/api/v1/*` calls when stateless and serves them from an in-browser router: `frontend/src/lib/stateless/localApi.ts` (path-template routes → handlers over a sessionStorage JSON store, `frontend/src/lib/stateless/store.ts`, key `rg_stateless_db`). Handlers mirror each real route's exact response envelope — when changing a real route's shape, update the matching local handler.
- **Free-track only**: there is NO API-key generation in stateless mode (no server LLM key, no `stateless/generate` route — deliberately, to avoid an unauthenticated LLM proxy). Reports are created via batch-prompt (built client-side by `stateless/prompt-context.ts` + pure `buildBatchPrompt` with `useAliases: true`) → paste into ChatGPT → `parse-reports` (local handler remaps alias-keyed items and restores real names). The generate/redo/bulk endpoints return 501 `STATELESS_FREE_MODE_ONLY`, and the UI hides API-generate buttons when `isStatelessMode` (RatingsGrid, GenerateReportsPanel Section A, review page Generate/Regenerate).
- **Alias privacy in stateless mode**: the pure alias pipeline lives in `frontend/src/lib/alias-core.ts` (prisma-free; `alias.service.ts` re-exports it and adds the DB-backed `SessionStudentAlias` persistence). Stateless aliases are recomputed deterministically via `computeAliasMap` with the same ordering DB mode uses (first_name asc, id asc → `Student_NN`) — keep the two orderings in sync.
- Prisma-free server routes used in this mode: `POST /api/v1/stateless/export/pdf`, `POST /api/v1/stateless/export/xlsx` (data in the body; shared core in `lib/services/export-core.ts`; rate-limited per IP with the `exportBurst` preset) and `GET /api/v1/stateless/status` (tells the login page whether to show the session-only entry button).
- Shared pure helpers extracted for reuse: `lib/report-text.ts` (sanitise/word-count), `lib/alias-core.ts` (alias pipeline), `lib/services/export-core.ts` (single-Chromium-launch `htmlsToBuffers`, zip/xlsx builders, `safeFilename`; browser launch is `DEPLOYMENT_MODE`-conditional — sparticuz when `hosted`, full puppeteer otherwise).
- `AuthContext` exposes `isStatelessMode` / `enterStatelessMode()`; `isAuthenticated` is true in stateless mode; logout wipes the flag + store. Amber banner in `(app)/layout.tsx`; settings page shows an info card; tests tab hidden on the class page; dashboard empty state offers "Load sample class" (`stateless/sample-data.ts`).
- Exports in stateless mode go through `lib/download.ts` (`downloadExport`), which POSTs store data to the stateless export routes; in normal mode it does the authenticated GET (replaced the two inline `downloadWithAuth` helpers).

### Export — CSP & routing (prompt_13_done)
- All browser-initiated API calls must use **relative URLs** (no `http://localhost:3001`) to comply with `connect-src 'self'` in `next.config.ts`.
- The session detail page (`frontend/src/app/(app)/classes/[id]/sessions/[sessionId]/page.tsx`) previously computed `API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"`. This is now `const API_URL = ""` so template-literal URLs like `` `${API_URL}/api/v1/...` `` become relative.
- The review page (`review/page.tsx`) had `const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"`. This constant has been removed entirely; export URLs now use relative paths directly.
- Next.js proxy routes for export already exist at:
  - `frontend/src/app/api/v1/sessions/[sessionId]/export/pdf/route.ts` — returns ZIP of all session PDFs
  - `frontend/src/app/api/v1/sessions/[sessionId]/export/csv/route.ts` — returns XLSX (despite the route name)
  - `frontend/src/app/api/v1/reports/[reportId]/export/pdf/route.ts` — returns single-report PDF
  - `frontend/src/app/api/v1/classes/[classId]/export/pdf/route.ts` and `.../csv/route.ts` — class-level exports
- These proxy routes call internal service functions directly; they do NOT forward to port 3001.
- The `next.config.ts` CSP (`connect-src 'self'`) does not need changing once all export calls use relative URLs.

### Export XLSX column headers (audited)
- The `/export/csv` route returns an **XLSX file** (not plain CSV) — this is intentional. The file is named `session_reports.xlsx`.
- Both the frontend service (`frontend/src/lib/services/export.service.ts`) and backend service (`backend/src/services/export.service.ts`) now use human-readable column headers in the exported workbook:
  - `Ref ID`, `First Name`, `Last Name`, `Gender`, `Session`, `Status`, `Word Count`, `Report Text`, `Generated At`
- Internally the data keys remain snake_case (`ref_id`, `first_name`, etc.) — only the displayed header row uses the human-readable labels.
- There is no separate "ratings/scores" XLSX export — the only XLSX export is the report text dump described above.
- No CSP issues: `API_URL = ""` is already set in the session page; all export fetches use relative URLs.

### Export PDF on individual report review page (`/classes/[id]/sessions/[sessionId]/review`)
- The **Export PDF** button in the action bar exports the **current individual report** as a PDF (not the whole session ZIP).
- It calls `/api/v1/reports/${currentReport.id}/export/pdf` (relative URL, no port).
- The button is **disabled** (`disabled={currentReport.status !== "final"}`) with a tooltip explaining why, and **enabled** only when the report is marked Final.
- This reflects the intent: final reports are production-ready; exporting a draft is blocked.
- The button is inside `{currentReport && (...)}` so it only renders when a report exists.
- The `Content-Disposition` filename is set in `frontend/src/app/api/v1/reports/[reportId]/export/pdf/route.ts`. It queries both `student.first_name` and `session.name` from the report, sanitises each via `safeFilename()` (strips `/\:*?"<>|` → `-`, collapses multiple spaces), and sets the header to `"[sessionName] - [firstName].pdf"` (e.g. `coding 2 - Luca.pdf`).


### Class Creation (`/classes/new`)
- The disciplines section has been **removed** from `frontend/src/app/(app)/classes/new/page.tsx`.
- Disciplines belong to **report session creation**, not class setup.
- Class setup covers: class details (name, year group, subject, term) and topics covered only.
- The backend `CreateClassSchema` (`backend/src/routes/classes.ts`) only accepts `name`, `year_group`, and `subject` — it never accepted disciplines, term, or topics_covered at the API level. Extra fields are silently ignored by Zod.
- Do **not** touch disciplines in report session creation or anywhere else in the app.

### Duplicate Session — class-selection modal
- Clicking "Duplicate Session" now opens a `DuplicateToClassModal` (defined inline in the session detail page) instead of immediately duplicating.
- The modal fetches all non-archived classes via `GET /api/v1/classes` (already existed). Each row shows class name, year group, subject, student count. The current class is labelled "(this class)".
- Single-selection (highlight on click). The confirm button reads "Duplicate to [class name]" and is disabled until a class is selected.
- On confirm the page POSTs to `/api/v1/sessions/[sessionId]/duplicate` with `{ targetClassId }` in the body, then navigates to `/classes/[targetClassId]/sessions/[newSessionId]` and shows a success toast (auto-dismisses after 4 s).
- The duplicate route (`frontend/src/app/api/v1/sessions/[sessionId]/duplicate/route.ts`) now reads `targetClassId` from the request body (optional; falls back to the source session's class if omitted). When a non-source `targetClassId` is given it validates the class belongs to the same organisation before proceeding. The new session is created with `class_id = resolvedClassId`.
- `class_id: true` is already present in the Prisma `select` block (fixed in prompt 77) so the response always includes `class_id`.
- The old `POST /api/v1/classes/[classId]/sessions/copy` route still exists but is not wired to any UI — leave it untouched.

### Test detail page (`/classes/[id]/tests/[testId]`)
- The test detail page (`frontend/src/app/(app)/classes/[id]/tests/[testId]/page.tsx`) combines the score entry table with Edit and Duplicate header buttons.
- Header: test name, max mark, entry progress, grade boundary summary, topic tags, Save All, Duplicate, Edit, Back buttons.
- **Edit button** opens `EditTestModal` (inline) — same fields as the TestModal on the class page (name, max mark, topics, grade boundaries). On save, all existing score rows are recalculated against the new boundaries/max mark.
- **Duplicate button** opens `DuplicateTestModal` (inline) — fetches non-archived classes, shows name/year/subject/student count, current class labelled "(this class)", single-selection, confirm reads "Duplicate to [class name]". Uses `POST /api/v1/classes/[classId]/tests/copy`.
- Score table columns: Student | Mark (text input, supports "42/50" format) | % (auto-calc) | Grade (hidden if no boundaries) | Comment (button).
- **Tab key** on mark inputs moves to the next student's mark input via `scoreInputRefs` Map keyed by student index.
- **Comment button** expands an inline textarea row below the student row. A filled dot indicator shows when a comment exists. Collapses on second click.
- Auto-save on blur of mark or comment inputs; Save All as a fallback.
- Uses existing APIs: `GET /api/v1/classes/[classId]/tests/[testId]`, `GET /api/v1/classes/[classId]`, `GET /api/v1/tests/[testId]/results`, `POST /api/v1/tests/[testId]/results/bulk`.
- The existing `/entry` sub-page (`entry/page.tsx`) remains untouched — it is a simpler inline-comment-free version.
- `TestResult` model in Prisma already existed with fields: `id`, `test_id`, `student_id`, `score` (Int), `comment` (String?), `calculated` (JsonB). No migration needed.

### Tests card on the class page (`/classes/[id]`)
- A `TestsCard` component (self-contained, fetches its own data) renders below the Report Sessions section on the class detail page (`frontend/src/app/(app)/classes/[id]/page.tsx`).
- The card lists all tests for the class: name, total marks, grade boundaries indicator (✓ grades / — grades), topic count. Three-dot menu per row for Edit, Duplicate, Delete.
- Empty state: "No tests yet. Add your first test." with CTA. List state has "+ Add Test" button in card header and a footer link.
- `TestModal` handles both create (`POST /api/v1/classes/[classId]/tests`) and edit (`PUT /api/v1/classes/[classId]/tests/[testId]`). Fields: name, total marks (max_mark), topics (TagInput), grade boundaries (expandable — pairs of label + min %).
- `DuplicateTestModal` fetches non-archived classes via `GET /api/v1/classes`, lets the teacher pick a destination, then POSTs to `POST /api/v1/classes/[classId]/tests/copy` with `{ testId, targetClassId }`. If the target is the current class, the new test is prepended to the list.
- API routes: GET, POST at `/api/v1/classes/[classId]/tests/route.ts` (already existed). PUT and DELETE added to `/api/v1/classes/[classId]/tests/[testId]/route.ts`. Copy route at `/api/v1/classes/[classId]/tests/copy/route.ts` already existed.
- The `Test` model in prisma has no `organization_id` — org isolation is enforced by verifying `class.organization_id === user.organizationId` before any test operation.

### Test score rendering in prompts
- `TestResult` model stores `score (Int)` and `calculated (JsonB)` as `{ percentage: number; grade: string | null }`. This shape is written by `computeGrade()` in `frontend/src/app/api/v1/tests/[testId]/results/bulk/route.ts`.
- When building test context for any prompt (batch-prompt, generate, regenerate), the code checks `isScored = includePercentage || includeGrade || includeLowMention || includeMark` and queries `TestResult` only for scored tests.
- **`includeLowMention` always forces `percentage` onto the item** — even if `includePercentage` is false. This is required so the LLM can evaluate the "below 60%" threshold in Rule 6. Fixed in all five paths: `frontend/batch-prompt/route.ts`, `frontend/report.service.ts`, `frontend/regenerate/route.ts`, `backend/report.service.ts`, `backend/routes/reports.ts` (both the batch-prompt and regenerate handlers).
- The `mark` field renders WITHOUT a `Mark:` prefix in `buildStudentBlock`. Both `frontend/src/lib/adapters/llm/prompt-builder.ts` and `backend/src/adapters/llm/prompt-builder.ts` render it as `sanitize(tc.mark)` (not `Mark: ${sanitize(tc.mark)}`), consistent with the `percentage` format.
- Prompt rendering for tests: `"[name]" — [score]/[max_mark]` (mark), `"[name]" — [percentage]%` (percent), `"[name]" — Grade: [grade]` (grade). Multiple display modes combine with `|` separator.

### Edit / Delete Session — session detail page
- An **"Edit"** button sits next to "Duplicate Session" in the header button row on `frontend/src/app/(app)/classes/[id]/sessions/[sessionId]/page.tsx`.
- Clicking Edit opens `EditSessionModal` (defined inline in the same file). The modal has a session name text input (pre-populated, required) and "Save Changes" / "Cancel" buttons. A visually separated **Danger Zone** at the bottom contains a "Delete Session" button (red border/text).
- Clicking "Delete Session" in the edit modal closes it and opens `DeleteSessionConfirmModal`. That modal shows `"This will permanently delete "[name]" and all [N] reports. This cannot be undone."` and has "Cancel" and "Delete Session" (red) buttons.
- On delete confirm: sends `DELETE /api/v1/sessions/[sessionId]`, then navigates to `/classes/[classId]`. Errors surface via `actionError`.
- The `DELETE` handler was added to `frontend/src/app/api/v1/sessions/[sessionId]/route.ts` (PUT and GET already existed). It validates org ownership, then in a `$transaction` deletes `Report` rows for the session first (no cascade in schema on `Report.session_id`) before deleting the `ReportSession` itself. Returns 204 on success.
- `reportCount` passed to both modals is `reports.size` from the existing reports `Map` state — gives a live count of loaded reports.
