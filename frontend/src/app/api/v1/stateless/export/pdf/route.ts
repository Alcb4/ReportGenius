import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { buildReportHTML, ReportHTMLData } from '@/lib/templates/report.html'
import {
  PDFExportError,
  htmlsToBuffers,
  buffersToZip,
  safeFilename,
} from '@/lib/services/export-core'
import { rateLimitOrNull } from '@/lib/ratelimit'
import { statelessDisabledResponse } from '../../guard'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ReportItemSchema = z.object({
  firstName: z.string().min(1).max(100),
  className: z.string().max(255),
  term: z.string().max(100).nullable(),
  reportText: z.string().min(1).max(50_000),
  generatedAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
})

const BodySchema = z.object({
  reports: z.array(ReportItemSchema).min(1).max(100),
  // true = always return a ZIP, even for a single report (session-level
  // exports save under a fixed .zip filename, so the payload must be a ZIP).
  bundle: z.boolean().optional(),
})

export async function POST(req: NextRequest) {
  const disabled = statelessDisabledResponse()
  if (disabled) return disabled

  const limited = await rateLimitOrNull(req, 'exportBurst', 'stateless-pdf')
  if (limited) return limited

  try {
    const body = await req.json().catch(() => null)
    const parsed = BodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors.map((e) => e.message).join(', '), code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
    }

    const items: ReportHTMLData[] = parsed.data.reports.map((r) => ({
      firstName: r.firstName,
      className: r.className,
      term: r.term,
      reportText: r.reportText,
      generatedAt: new Date(r.generatedAt),
    }))

    // One Chromium launch for the whole batch — a launch costs seconds on
    // serverless, so per-report launches would blow maxDuration.
    const buffers = await htmlsToBuffers(items.map((item) => buildReportHTML(item)))

    if (items.length === 1 && !parsed.data.bundle) {
      return new NextResponse(new Uint8Array(buffers[0]), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${safeFilename(items[0].firstName)}_report.pdf"`,
        },
      })
    }

    const zip = await buffersToZip(
      items.map((item, i) => ({
        name: `${safeFilename(item.firstName)}_report.pdf`,
        buffer: buffers[i],
      }))
    )
    return new NextResponse(new Uint8Array(zip), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="session_reports.zip"',
      },
    })
  } catch (err: unknown) {
    if (err instanceof PDFExportError) {
      return NextResponse.json({ error: err.userFacingMessage, code: err.code }, { status: 503 })
    }
    console.error(err)
    return NextResponse.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, { status: 500 })
  }
}
