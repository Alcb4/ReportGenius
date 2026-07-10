# Handoff — Report Genius — 2026-07-10

## Goal
Get the standalone/stateless (no-DB, no-auth) version of Report Genius deployed on Vercel, then clean up the several duplicate/stale repos (`report_genius - copy`, `report_genius.bak`, `report-Genius_finalhosting_bak`, `reportgenius`).

## Current state
- `main` is pushed and clean at `github.com/Alcb4/ReportGenius`, includes stateless mode (shipped 4e19b3c) and today's fixes.
- Vercel "multiple services" import error fixed: `vercel.json` (crons only) now lives under `frontend/`, matching the project's **Root Directory = `frontend`** setting. A root-level `vercel.json` was tried first and reverted — it's ignored once Root Directory is set, and its `cd frontend && ...` commands were wrong anyway.
- Vercel's GitHub integration had silently disconnected (deploys were stuck on an April 7 build despite pushes). User reconnected it in the dashboard; an empty commit (`31e6402`) was pushed to force the webhook, and a build started. **Not yet confirmed live/working by the user** — last state was "ok building now".
- Fixed a real stateless-mode bug: the in-browser mirror of `POST /classes/[classId]/students/bulk` (`frontend/src/lib/stateless/localApi.ts`) wrongly required `last_name` non-empty; the real server route treats it as optional. Fixed to match (commit `3096d65`).
- Confirmed discipline templates already have one source of truth: `frontend/src/lib/stateless/discipline-library.ts`, imported by both stateless mode and `frontend/prisma/seed.ts` — no action needed, just verified for the user.

## Next step
Confirm with the user whether the Vercel build that started after `31e6402` actually succeeded and is serving the current code (check Deployments tab / hit the live URL). If it failed, get the build log. Once confirmed live, do a manual smoke-test of the stateless flow (session-only entry → batch-prompt → paste → parse-reports → export) on the real deployment — this has only been logic-tested, never click-tested end to end.

## Open questions
- Once the Vercel deploy is confirmed working, user wants to clean up the duplicate repos (`report_genius - copy`, `report_genius.bak`, `report-Genius_finalhosting_bak`, `reportgenius`) — not yet scoped (delete? archive? check for unique unmerged work first?).

## Working tree
- Branch: `main`
- Changed/untracked files: none — clean, everything committed and pushed.
- Uncommitted diff: none.

## Key paths
- `vercel.json` — repo-level deploy config, lives at `frontend/vercel.json` (cron only; Next.js auto-detected).
- `frontend/src/lib/stateless/localApi.ts` — in-browser API mirror for stateless mode; any change to a real route's response shape or validation must be mirrored here.
- `frontend/src/lib/stateless/discipline-library.ts` — single source of truth for discipline templates (stateless mode + DB seed).
- `CLAUDE.md` — has detailed architecture notes on stateless mode; keep it updated if stateless internals change further.

## Landmines
- Don't reintroduce a root-level `vercel.json` unless the Vercel project's Root Directory setting is also reset to blank — the two must match or the build config is silently ignored or wrong.
- When editing any real API route under `frontend/src/app/api/v1/...`, check whether `frontend/src/lib/stateless/localApi.ts` has a mirrored handler and update both — they've already diverged once (the bulk-add-students bug fixed this session).
