# Handoff — Report Genius — 2026-08-23

## Goal
Split the database-free "session-only" mode out of the hosted app into its own
standalone product, because the in-app version made a teacher create a class,
students and a named session before writing a single report. Ship it, then clean
up the duplicate repos left over from earlier rebuilds.

## Current state

**Done & verified**
- **Duplicate repos deleted.** `report_genius - Copy`, `.bak`,
  `_finalhosting_bak` and `reportgenius` are gone (user ran the `rm`). Every
  commit in them was an ancestor of `main`. Two things were rescued to
  `~/repo-archive/` first: `pii-protection-ebae6be.bundle` (a commit that existed
  nowhere else, not even on GitHub) and `env-backup/` (9 real `.env` files).
- **`report-genius-solo` built and shipped.** New repo `Alcb4/report-genius-solo`
  (private, `main`), live at https://report-genius-solo.vercel.app. Six-step
  wizard over `localStorage`; generation in batches of 5; export via the
  browser's print dialog, which is what keeps it a fully static export with no
  backend. `npm run check` = 30 assertions, plus lint/tsc/build — all clean.
- **A real PII leak found and fixed in BOTH apps.** Prompt names resolved as
  `aliasMap.get(id) ?? student.first_name`; a student outside the session's class
  had no alias, so the fallback put their **real first name into the LLM prompt**.
  Reproduced (`Name: Rosalind`), fixed to throw instead, and guarded by
  `npm run check:pii` in `frontend/`. See `[[project-alias-privacy-fail-closed]]`.
- **`.env` hygiene confirmed.** Neither repo tracks a real `.env`, none was ever
  committed in either history, and the on-disk ones are `git check-ignore`-clean.
  Only `.env.example` is tracked and it holds placeholders.

**Done but NOT verified**
- **Neither app has had a real-browser walkthrough.** All the logic is covered by
  automated checks, but nobody has clicked through either wizard. This is the
  biggest gap.
- **The hosted app's Vercel build is still unconfirmed** — carried over from the
  last session and still open. `03a0bfa` was just pushed, which should trigger one.

**Open / awaiting a decision**
- `~/repo-archive/env-backup/` holds plaintext API keys.
- Solo app has Deployment Protection ON, so its URL asks for a Vercel login.

## Next step
Open https://report-genius-solo.vercel.app and click through all six steps with a
real class list — paste a roster, pick disciplines, skip tests, rate, copy a batch
prompt into ChatGPT, paste the reply back, print. That is the one thing no
automated check can substitute for.

## Open questions
- **PR flow:** this session pushed straight to `main` on both repos. The standing
  preference is to branch for new work — confirm whether to enforce PRs from here.
- Are any keys in `~/repo-archive/env-backup/` still live (salvage, delete, or
  rotate)?
- Should the hosted app's stateless mode eventually be retired now the splinter
  exists, or do both ship?

## Working tree
- Branch: `main` (both repos), clean and in sync with origin.
- `report_genius` → `03a0bfa`; `report-genius-solo` → `66376da`.
- Uncommitted diff: this wrap's `CLAUDE.md` + `HANDOFF.md` edits only.

## Key paths
- `~/report-genius-solo/src/lib/run-prompt.ts` — batching (`BATCH_SIZE = 5`),
  prompt assembly, response parsing. The heart of the new app.
- `~/report-genius-solo/scripts/roundtrip-check.ts` — `npm run check`.
- `frontend/scripts/pii-probe.ts` — `npm run check:pii`, the privacy guard.
- `frontend/src/lib/stateless/localApi.ts` — the 1,252-line Prisma-API
  impersonator that motivated the whole splinter. Still live here.

## Landmines
- **Five files are duplicated verbatim across the two repos** (`alias-core.ts`,
  `prompt-builder.ts`, `llm-types.ts`/`types.ts`, `report-text.ts`,
  `discipline-library.ts`). A fix to any of them belongs in both. This is the
  deliberate cost of the clean break.
- **Never give an alias lookup a fallback to the raw name.** That is exactly the
  bug fixed this session, and it reads as safe while leaking.
- The solo app is `output: "export"`, so it **cannot serve HTTP headers** — the
  CSP and security headers live in its `vercel.json` and must be ported by hand to
  any other host.
- Hosted Vercel deploys can silently stop building when the **GitHub integration
  disconnects** with no visible error. Check Settings → Git before debugging code.
- `sanitiseLlmResponse` strips a leading title line; on a one-line report that
  opens like a title it would strip everything. Both apps now fall back to the
  original — don't "simplify" that guard away.
