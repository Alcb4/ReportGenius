import { NextResponse } from 'next/server'
import { isStatelessBuild } from '@/lib/stateless/mode'

/**
 * Stateless routes are unauthenticated and prisma-free. They only run when
 * the deployment opts in: STATELESS_ENABLED=true (server-side switch) or
 * NEXT_PUBLIC_STATELESS=true (whole-site stateless build).
 */
export function statelessEnabled(): boolean {
  return process.env.STATELESS_ENABLED === 'true' || isStatelessBuild()
}

export function statelessDisabledResponse(): NextResponse | null {
  if (statelessEnabled()) return null
  return NextResponse.json(
    { error: 'Session-only mode is not enabled on this deployment', code: 'STATELESS_DISABLED' },
    { status: 403 }
  )
}
