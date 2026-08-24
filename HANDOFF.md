# Handoff — Report Genius (hosted) — 2026-08-24

> The standalone splinter now has its own handoff at
> `~/report-genius-solo/HANDOFF.md`. This file covers the **hosted** app only.

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
  wizard over `localStorage`; export via the browser's print dialog, which is
  what keeps it a fully static export with no backend. See that repo's own
  HANDOFF.md for its current state.
- **A real PII leak found and fixed in BOTH apps.** Prompt names resolved as
  `aliasMap.get(id) ?? student.first_name`; a student outside the session's class
  had no alias, so the fallback put their **real first name into the LLM prompt**.
  Reproduced (`Name: Rosalind`), fixed to throw instead, and guarded by
  `npm run check:pii` in `frontend/`. See `[[project-alias-privacy-fail-closed]]`.
- **`.env` hygiene confirmed.** Neither repo tracks a real `.env`, none was ever
  committed in either history, and the on-disk ones are `git check-ignore`-clean.
  Only `.env.example` is tracked and it holds placeholders.

**Landed since (2026-08-24)**
- `03a0bfa` — stateless prompts fail closed when a student has no alias (a real
  PII leak; see `npm run check:pii`).
- `ea7cae0` (PR #1) — the prompt now names the student once instead of using
  pronouns throughout. Mirrored from the solo app; `prompt-builder.ts` is
  byte-identical across both repos again, verified by diff.

**Done but NOT verified**
- **This hosted app has had no browser walkthrough.** (The solo app was tested
  locally by the user on 2026-08-24 and approved; this one has not been.)
- **The hosted app's Vercel build is still unconfirmed** — now three sessions
  old, with two more commits landed since. Check **Settings → Git** first: the
  GitHub integration disconnects silently with no visible error.

**Open / awaiting a decision**
- `~/repo-archive/env-backup/` holds plaintext API keys.
- Solo app has Deployment Protection ON, so its URL asks for a Vercel login.

## Next step
Confirm the hosted app's Vercel deploy is actually live and building from `main`.
It has been unconfirmed across three sessions and nothing else here can be
trusted until it is.

## Open questions
- Are any keys in `~/repo-archive/env-backup/` still live (salvage, delete, or
  rotate)?
- Should the hosted app's stateless mode eventually be retired now the splinter
  exists, or do both ship?

## Working tree
- Branch: `main` (both repos), clean and in sync with origin. No open PRs.
- `report_genius` → `ea7cae0`; `report-genius-solo` → `0a1b9da`.
- Uncommitted diff: this wrap's `CLAUDE.md` + `HANDOFF.md` edits only.

## Key paths
- `~/report-genius-solo/` — the splinter; it has its own HANDOFF.md now.
- `frontend/scripts/pii-probe.ts` — `npm run check:pii`, the privacy guard.
- `frontend/src/lib/stateless/localApi.ts` — the 1,252-line Prisma-API
  impersonator that motivated the whole splinter. Still live here.

## Landmines
- **Five files are duplicated verbatim across the two repos** (`alias-core.ts`,
  `prompt-builder.ts`, `llm-types.ts`/`types.ts`, `report-text.ts`,
  `discipline-library.ts`). A fix to any of them belongs in both. This is the
  deliberate cost of the clean break.
- **Never give an alias lookup a fallback to the raw name.** It reads as safe
  while leaking; fixed 2026-08-23 in both repos.
- **Code changes go branch + PR, never straight to `main`.** Session-wrap doc
  commits are the only carve-out. Confirmed by the user 2026-08-24.
- The solo app is `output: "export"`, so it **cannot serve HTTP headers** — the
  CSP and security headers live in its `vercel.json` and must be ported by hand to
  any other host.
- Hosted Vercel deploys can silently stop building when the **GitHub integration
  disconnects** with no visible error. Check Settings → Git before debugging code.
- `sanitiseLlmResponse` strips a leading title line; on a one-line report that
  opens like a title it would strip everything. Both apps now fall back to the
  original — don't "simplify" that guard away.
