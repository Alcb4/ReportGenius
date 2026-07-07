import { NextResponse } from 'next/server'
import { statelessEnabled } from '../guard'

export const dynamic = 'force-dynamic'

/**
 * Tells the client whether this deployment has session-only mode enabled.
 * STATELESS_ENABLED is server-only, so the login page asks here before
 * showing the "Continue without an account" entry point — otherwise a user
 * could do a whole session of work and only hit 403 at export time.
 */
export async function GET() {
  return NextResponse.json({ enabled: statelessEnabled() })
}
