/**
 * Export service — PDF, ZIP, and XLSX exports.
 *
 * PDF rendering uses one of two browser launch paths depending on DEPLOYMENT_MODE:
 *   - "hosted"   → @sparticuz/chromium + puppeteer-core (serverless / Vercel)
 *   - "standalone" (default) → full puppeteer (self-hosted, local Chromium)
 */

import { prisma } from '@/lib/prisma'
import { buildReportHTML, ReportHTMLData } from '@/lib/templates/report.html'
import {
  PDFExportError,
  htmlToBuffer,
  htmlsToBuffers,
  buffersToZip,
  buildReportsWorkbook,
  ReportRow,
} from './export-core'

// Re-exported for the API routes that import it from this module
export { PDFExportError }

export async function exportReportPDF(reportId: string, orgId: string): Promise<Buffer> {
  const report = await prisma.report.findFirst({
    where: { id: reportId, organization_id: orgId },
    select: {
      id: true,
      edited_content: true,
      created_at: true,
      student: { select: { first_name: true } },
      session: { select: { name: true } },
    },
  })

  if (!report) {
    throw Object.assign(new Error('Report not found'), {
      code: 'REPORT_NOT_FOUND',
      statusCode: 404,
    })
  }

  const templateData: ReportHTMLData = {
    firstName: report.student.first_name,
    className: report.session.name,
    term: null,
    reportText: report.edited_content,
    generatedAt: report.created_at,
  }

  return htmlToBuffer(buildReportHTML(templateData))
}

export async function exportSessionPDF(sessionId: string, orgId: string): Promise<Buffer> {
  const session = await prisma.reportSession.findFirst({
    where: { id: sessionId, organization_id: orgId },
    select: { id: true, name: true },
  })

  if (!session) {
    throw Object.assign(new Error('Session not found'), {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    })
  }

  const reports = await prisma.report.findMany({
    where: { session_id: sessionId, organization_id: orgId },
    select: {
      id: true,
      edited_content: true,
      created_at: true,
      student: { select: { first_name: true } },
    },
    orderBy: { student: { first_name: 'asc' } },
  })

  if (reports.length === 0) {
    throw Object.assign(new Error('No reports found for this session'), {
      code: 'NO_REPORTS',
      statusCode: 404,
    })
  }

  // One Chromium launch for the whole session — launching per report costs
  // seconds each on serverless and would blow the route timeout.
  const htmls = reports.map((report) =>
    buildReportHTML({
      firstName: report.student.first_name,
      className: session.name,
      term: null,
      reportText: report.edited_content,
      generatedAt: report.created_at,
    } satisfies ReportHTMLData)
  )
  const buffers = await htmlsToBuffers(htmls)

  return buffersToZip(
    reports.map((report, i) => ({
      name: `${report.student.first_name}_report.pdf`,
      buffer: buffers[i],
    }))
  )
}

export async function exportClassPDF(classId: string, orgId: string): Promise<Buffer> {
  const session = await prisma.reportSession.findFirst({
    where: { class_id: classId, organization_id: orgId },
    select: { id: true },
    orderBy: { created_at: 'desc' },
  })

  if (!session) {
    throw Object.assign(new Error('No sessions found for this class'), {
      code: 'NO_SESSIONS',
      statusCode: 404,
    })
  }

  return exportSessionPDF(session.id, orgId)
}

export async function exportSessionCSV(sessionId: string, orgId: string): Promise<Buffer> {
  const session = await prisma.reportSession.findFirst({
    where: { id: sessionId, organization_id: orgId },
    select: { id: true, name: true },
  })

  if (!session) {
    throw Object.assign(new Error('Session not found'), {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    })
  }

  const reports = await prisma.report.findMany({
    where: { session_id: sessionId, organization_id: orgId },
    select: {
      id: true,
      edited_content: true,
      status: true,
      word_count: true,
      created_at: true,
      student: {
        select: {
          first_name: true,
          last_name: true,
          gender: true,
          student_ref_id: true,
        },
      },
    },
    orderBy: [{ student: { first_name: 'asc' } }, { created_at: 'desc' }],
  })

  const rows: ReportRow[] = reports.map((r) => ({
    ref_id: r.student.student_ref_id ?? '',
    first_name: r.student.first_name,
    last_name: r.student.last_name ?? '',
    gender: r.student.gender ?? '',
    session_name: session.name,
    status: r.status,
    word_count: r.word_count ?? 0,
    report_text: r.edited_content,
    generated_at: r.created_at.toISOString(),
  }))

  return buildReportsWorkbook(rows)
}

export async function exportClassCSV(classId: string, orgId: string): Promise<Buffer> {
  const session = await prisma.reportSession.findFirst({
    where: { class_id: classId, organization_id: orgId },
    select: { id: true },
    orderBy: { created_at: 'desc' },
  })

  if (!session) {
    throw Object.assign(new Error('No sessions found for this class'), {
      code: 'NO_SESSIONS',
      statusCode: 404,
    })
  }

  return exportSessionCSV(session.id, orgId)
}
