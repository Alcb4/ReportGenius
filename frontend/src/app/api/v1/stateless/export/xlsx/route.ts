import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { buildReportsWorkbook, ReportRow } from '@/lib/services/export-core'
import { rateLimitOrNull } from '@/lib/ratelimit'
import { statelessDisabledResponse } from '../../guard'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const RowSchema = z.object({
  ref_id: z.string().max(100),
  first_name: z.string().max(100),
  last_name: z.string().max(100),
  gender: z.string().max(20),
  session_name: z.string().max(255),
  status: z.string().max(20),
  word_count: z.number().int().min(0),
  report_text: z.string().max(50_000),
  generated_at: z.string().max(40),
})

const BodySchema = z.object({
  rows: z.array(RowSchema).min(1).max(200),
})

export async function POST(req: NextRequest) {
  const disabled = statelessDisabledResponse()
  if (disabled) return disabled

  const limited = await rateLimitOrNull(req, 'exportBurst', 'stateless-xlsx')
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

    const workbook = await buildReportsWorkbook(parsed.data.rows as ReportRow[])
    return new NextResponse(new Uint8Array(workbook), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="session_reports.xlsx"',
      },
    })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, { status: 500 })
  }
}
