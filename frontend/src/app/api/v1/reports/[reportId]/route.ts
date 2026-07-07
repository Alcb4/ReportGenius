import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { authenticate } from '@/lib/authenticate'
import { countWords } from '@/lib/report-text'

export const dynamic = 'force-dynamic'

const UpdateReportSchema = z.object({
  edited_content: z.string().min(1).optional(),
  status: z.enum(['draft', 'edited', 'final']).optional(),
}).refine(
  (d) => d.edited_content !== undefined || d.status !== undefined,
  { message: 'At least one of edited_content or status is required' }
)

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ reportId: string }> }
) {
  const user = await authenticate(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized', code: 'AUTH_MISSING' }, { status: 401 })

  const { reportId } = await params

  try {
    const report = await prisma.report.findFirst({
      where: { id: reportId, organization_id: user.organizationId },
      select: {
        id: true, student_id: true, session_id: true,
        status: true, word_count: true, edited_content: true,
        llm_model: true, llm_prompt: true, llm_raw_response: true,
        ratings_changed_at: true, created_at: true, updated_at: true,
        student: { select: { id: true, first_name: true, last_name: true, gender: true } },
        session: { select: { id: true, name: true, tone: true, length: true } },
      },
    })

    if (!report) return NextResponse.json({ error: 'Report not found', code: 'REPORT_NOT_FOUND' }, { status: 404 })

    return NextResponse.json({ report })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, { status: 500 })
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ reportId: string }> }
) {
  const user = await authenticate(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized', code: 'AUTH_MISSING' }, { status: 401 })

  const { reportId } = await params

  try {
    const report = await prisma.report.findFirst({
      where: { id: reportId, organization_id: user.organizationId },
      select: { id: true },
    })
    if (!report) return NextResponse.json({ error: 'Report not found', code: 'REPORT_NOT_FOUND' }, { status: 404 })

    const body = await req.json()
    const parsed = UpdateReportSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors.map((e) => e.message).join(', '), code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
    }

    const updateData: { edited_content?: string; word_count?: number; status?: string } = {}
    if (parsed.data.edited_content !== undefined) {
      updateData.edited_content = parsed.data.edited_content
      updateData.word_count = countWords(parsed.data.edited_content)
      if (!parsed.data.status) updateData.status = 'edited'
    }
    if (parsed.data.status !== undefined) updateData.status = parsed.data.status

    const updated = await prisma.report.update({
      where: { id: reportId },
      data: updateData,
      select: {
        id: true, student_id: true, session_id: true,
        status: true, word_count: true, edited_content: true,
        llm_raw_response: true, created_at: true, updated_at: true,
      },
    })

    return NextResponse.json({ report: updated })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, { status: 500 })
  }
}
