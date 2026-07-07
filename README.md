# ReportGenius

A privacy-first, open-source tool for teachers to generate, edit, and export individualised student report comments using structured ratings and an LLM of your choice.

**No student PII is ever sent to the LLM.** Only first name, pronouns, ratings summary, and topics covered are used in prompts.

---

## Features

- Rate students on custom disciplines (e.g. Homework, Behaviour, Participation)
- Bulk-generate personalised report drafts via OpenAI, Claude, Grok, or a local Ollama model
- Edit and finalise reports in-browser
- Export per-class PDF zip or XLSX spreadsheet
- GDPR-compliant: soft-delete with 30-day cleanup, terms acceptance recorded
- Multi-tenant: each organisation's data is fully isolated

---

## Requirements

- [Node.js](https://nodejs.org/) 20+
- [Docker](https://www.docker.com/) (for local Postgres)
- An LLM API key (OpenAI, Anthropic, or xAI) **or** a local [Ollama](https://ollama.com/) instance

---

## Local development setup

### 1. Clone the repo

```bash
git clone <your-repo-url>
cd teacher_genius
```

### 2. Start the database

```bash
docker compose up -d
```

This starts Postgres on port **5433** and Redis on **6379**.

### 3. Configure environment variables

```bash
cp .env.example frontend/.env.local
```

Edit `frontend/.env.local` — the defaults work for local Docker. The only values you must change are your LLM provider and key:

```env
LLM_PROVIDER=openai          # openai | claude | grok | ollama
OPENAI_API_KEY=sk-...        # your key

# Or for local Ollama:
# LLM_PROVIDER=ollama
# OLLAMA_URL=http://localhost:11434
# OLLAMA_MODEL=llama3.1:8b
```

### 4. Install dependencies and run migrations

```bash
cd frontend
npm install                  # also runs `prisma generate` via postinstall
npx prisma migrate dev --schema=./frontend/prisma/schema.prisma --name init
```

### 5. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and register an account.

---

## Deploying to Vercel + Supabase

**You do not need a separate codebase.** The same code runs locally and in production — only environment variables differ.

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com), create a project, then grab two connection strings from **Project Settings → Database → Connection string**:

| Variable | Supabase string to use |
|---|---|
| `DATABASE_URL` | **Pooled** connection (Transaction mode, port 6543) |
| `DIRECT_URL` | **Direct** connection (port 5432) |

### 2. Run migrations against Supabase

```bash
# From the project root
DATABASE_URL="<direct connection string>" \
npx prisma migrate deploy --schema=./frontend/prisma/schema.prisma
```

### 3. Deploy to Vercel

Push your repo to GitHub, import it in Vercel, then add these environment variables in the Vercel dashboard:

```
DATABASE_URL          = <Supabase pooled URL>
DIRECT_URL            = <Supabase direct URL>
JWT_SECRET            = <random 32+ char string>
ENCRYPTION_KEY        = <64-char hex — run: openssl rand -hex 32>
CRON_SECRET           = <any random string>
LLM_PROVIDER          = openai
OPENAI_API_KEY        = sk-...
NEXT_PUBLIC_APP_URL   = https://your-app.vercel.app

# Optional — add for persistent rate limiting across serverless instances:
UPSTASH_REDIS_REST_URL   = ...
UPSTASH_REDIS_REST_TOKEN = ...
```

Set the Vercel build root to `frontend/` (or add `frontend` as the root directory in project settings).

### 4. Configure the Vercel Cron job

Add this to `frontend/vercel.json` (create if it doesn't exist):

```json
{
  "crons": [
    {
      "path": "/api/cron/cleanup",
      "schedule": "0 3 * * *"
    }
  ]
}
```

And set `CRON_SECRET` in your Vercel environment to match the value in `.env.local`.

---

## LLM options

| Provider | `LLM_PROVIDER` value | Key env var |
|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Anthropic Claude | `claude` | `CLAUDE_API_KEY` |
| xAI Grok | `grok` | `GROK_API_KEY` |
| Ollama (local) | `ollama` | `OLLAMA_URL` + `OLLAMA_MODEL` |

API keys can also be set per-organisation through the **Settings** page in the app. Keys stored this way are encrypted at rest (AES-256-GCM).

---

## Free LLM mode (no API key)

If you don't have an API key, you can use any external AI tool (ChatGPT free tier, etc.) and paste the output back into the app:

1. In the session, click **Generate with free model**
2. Copy the prompt shown and paste it into your AI tool of choice
3. Copy the AI's JSON response and paste it back — the app will parse and save all reports

---

## Session-only (stateless) mode — no database required

ReportGenius can run entirely without a database — and without any AI API key.
In session-only mode all data (classes, students, ratings, reports) lives in
the browser tab's `sessionStorage` and is gone when the tab closes. Reports are
written with the **free AI flow**: copy the generated prompt into ChatGPT (or
any AI tool), paste the response back, and the app parses and saves the
reports. The server keeps just two stateless routes — PDF export and XLSX
export. This is enough for one full report-writing session, and it means the
site keeps working even if the database is down or paused.

Two ways to enable it (set in `frontend/.env.local` or your Vercel env):

- `STATELESS_ENABLED=true` — keeps the normal account-based app, but adds a
  **"Continue without an account (session-only)"** button on the login page.
  Useful as a demo mode and as a fallback when Supabase is paused.
- `NEXT_PUBLIC_STATELESS=true` — forces the whole deployment into session-only
  mode. No login form, no database needed at all (`DATABASE_URL` can be a
  dummy value for the build). Also set `STATELESS_ENABLED=true`.

API-key generation is intentionally unavailable in this mode (nobody sets up a
paid key for a non-persistent session, and it avoids exposing an
unauthenticated LLM proxy). The export routes are rate-limited per IP.

---

## Security

- Passwords hashed with bcrypt (12 rounds)
- JWTs signed HS256, verified with algorithm enforcement
- API keys encrypted AES-256-GCM before database storage
- Per-IP rate limiting on auth and LLM routes
- Login lockout after 5 failed attempts (15-minute window)
- HTTP security headers (CSP, HSTS, X-Frame-Options, etc.)
- All database queries scoped to the authenticated organisation

See [SECURITY.md](./SECURITY.md) for the vulnerability disclosure policy.

---

## Tech stack

- **Frontend/API**: Next.js 15 (App Router, TypeScript)
- **Database**: PostgreSQL via Prisma ORM
- **Auth**: JWT (HS256)
- **Rate limiting**: Upstash Redis (in-memory fallback for local dev)
- **PDF export**: Puppeteer + @sparticuz/chromium
- **XLSX export**: ExcelJS
- **LLM**: Pluggable adapter (OpenAI, Anthropic, xAI, Ollama)

---

## License

MIT
