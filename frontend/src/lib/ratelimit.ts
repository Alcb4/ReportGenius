/**
 * Rate limiting utility.
 *
 * Uses Upstash Ratelimit when UPSTASH_REDIS_REST_URL + TOKEN are set.
 * Falls back to a module-level in-memory Map for local dev.
 * The fallback resets on each serverless cold-start — not suitable for
 * production; configure Upstash env vars before deploying.
 */

import { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

// ── In-memory fallback (dev only) ──────────────────────────────────────────

interface MemoryEntry { count: number; resetAt: number }
const memoryStore = new Map<string, MemoryEntry>()

function memoryLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now()
  const entry = memoryStore.get(key)

  if (!entry || now > entry.resetAt) {
    memoryStore.set(key, { count: 1, resetAt: now + windowMs })
    return true // allowed
  }

  if (entry.count >= maxRequests) return false // blocked

  entry.count++
  return true // allowed
}

// ── Upstash-backed limiter (production) ────────────────────────────────────

type LimiterConfig = { maxRequests: number; windowSeconds: number }

const upstashAvailable =
  Boolean(process.env.UPSTASH_REDIS_REST_URL) &&
  Boolean(process.env.UPSTASH_REDIS_REST_TOKEN)

// Lazy-load Upstash modules so local dev without env vars doesn't crash
let upstashLimiters: Map<string, unknown> | null = null

async function upstashLimit(key: string, config: LimiterConfig): Promise<boolean> {
  try {
    const { Ratelimit } = await import('@upstash/ratelimit')
    const { Redis } = await import('@upstash/redis')

    if (!upstashLimiters) upstashLimiters = new Map()

    const cacheKey = `${config.maxRequests}/${config.windowSeconds}`
    if (!upstashLimiters.has(cacheKey)) {
      upstashLimiters.set(
        cacheKey,
        new Ratelimit({
          redis: Redis.fromEnv(),
          limiter: Ratelimit.slidingWindow(config.maxRequests, `${config.windowSeconds} s`),
          analytics: false,
        })
      )
    }

    const limiter = upstashLimiters.get(cacheKey) as { limit: (key: string) => Promise<{ success: boolean }> }
    const { success } = await limiter.limit(key)
    return success
  } catch {
    // If Upstash fails (network, config), fail open to avoid blocking legit requests
    return true
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export type RateLimitPreset = 'auth' | 'llm' | 'export' | 'exportBurst' | 'general'

const PRESETS: Record<RateLimitPreset, LimiterConfig> = {
  auth:    { maxRequests: 5,  windowSeconds: 900 }, // 5 req / 15 min
  llm:     { maxRequests: 10, windowSeconds: 3600 }, // 10 req / hour
  export:  { maxRequests: 10, windowSeconds: 3600 }, // 10 req / hour
  // Per-report export workflows legitimately fire dozens of requests in a
  // session (e.g. exporting each student's PDF individually).
  exportBurst: { maxRequests: 120, windowSeconds: 3600 }, // 120 req / hour
  general: { maxRequests: 60, windowSeconds: 60 },   // 60 req / min
}

/**
 * Returns true if the request is allowed, false if rate-limited.
 * Key is derived from IP address + optional suffix (e.g. route name).
 */
export async function checkRateLimit(
  req: NextRequest,
  preset: RateLimitPreset,
  keySuffix = ''
): Promise<boolean> {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    '127.0.0.1'

  const key = `rl:${preset}:${ip}${keySuffix ? ':' + keySuffix : ''}`
  const config = PRESETS[preset]

  if (upstashAvailable) {
    return upstashLimit(key, config)
  }

  return memoryLimit(key, config.maxRequests, config.windowSeconds * 1000)
}

// ── Login lockout (per email) ───────────────────────────────────────────────
// 5 consecutive failures → 15-minute lockout.
// In-memory for dev; Upstash incr/expire in production.

const LOGIN_MAX_FAILURES = 5
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000 // 15 min

interface LockoutEntry { failures: number; lockedUntil: number | null }
const lockoutStore = new Map<string, LockoutEntry>()

function lockoutKey(email: string) {
  return `lockout:${email.toLowerCase()}`
}

/** Returns true if the email is currently locked out. */
export async function isLoginLocked(email: string): Promise<boolean> {
  const key = lockoutKey(email)

  if (upstashAvailable) {
    try {
      const { Redis } = await import('@upstash/redis')
      const redis = Redis.fromEnv()
      const val = await redis.get<string>(key + ':locked')
      return val === '1'
    } catch {
      return false
    }
  }

  const entry = lockoutStore.get(key)
  if (!entry) return false
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    lockoutStore.delete(key)
  }
  return false
}

/** Records a failed login attempt; locks the account after the threshold. */
export async function recordLoginFailure(email: string): Promise<void> {
  const key = lockoutKey(email)

  if (upstashAvailable) {
    try {
      const { Redis } = await import('@upstash/redis')
      const redis = Redis.fromEnv()
      const failures = await redis.incr(key + ':failures')
      if (failures === 1) await redis.expire(key + ':failures', LOGIN_LOCKOUT_MS / 1000)
      if (failures >= LOGIN_MAX_FAILURES) {
        await redis.set(key + ':locked', '1', { px: LOGIN_LOCKOUT_MS })
        await redis.del(key + ':failures')
      }
    } catch { /* fail open */ }
    return
  }

  const entry = lockoutStore.get(key) ?? { failures: 0, lockedUntil: null }
  entry.failures++
  if (entry.failures >= LOGIN_MAX_FAILURES) {
    entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS
    entry.failures = 0
  }
  lockoutStore.set(key, entry)
}

/** Clears lockout state after a successful login. */
export async function clearLoginFailures(email: string): Promise<void> {
  const key = lockoutKey(email)

  if (upstashAvailable) {
    try {
      const { Redis } = await import('@upstash/redis')
      const redis = Redis.fromEnv()
      await Promise.all([redis.del(key + ':failures'), redis.del(key + ':locked')])
    } catch { /* fail open */ }
    return
  }

  lockoutStore.delete(key)
}

/** Convenience — returns a 429 response or null if allowed */
export async function rateLimitOrNull(
  req: NextRequest,
  preset: RateLimitPreset,
  keySuffix = ''
): Promise<NextResponse | null> {
  const allowed = await checkRateLimit(req, preset, keySuffix)
  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait before trying again.', code: 'RATE_LIMITED' },
      { status: 429 }
    )
  }
  return null
}
