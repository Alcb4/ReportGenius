/**
 * Prisma-free export primitives — HTML→PDF (puppeteer + @sparticuz/chromium),
 * PDF ZIP bundling, and the reports XLSX workbook.
 *
 * Extracted from export.service.ts so the stateless export routes can render
 * documents from client-supplied data without touching the database.
 */

import archiver from 'archiver'
import ExcelJS from 'exceljs'
import { Readable } from 'stream'

export class PDFExportError extends Error {
  constructor(
    message: string,
    public readonly userFacingMessage: string,
    public readonly code: string = 'PDF_EXPORT_ERROR',
  ) {
    super(message)
    this.name = 'PDFExportError'
  }
}

// ── Browser launch (conditional per deployment mode) ─────────────────────────

const isHosted = process.env.DEPLOYMENT_MODE === 'hosted'

async function launchBrowser(): Promise<unknown> {
  if (isHosted) {
    try {
      const [{ default: chromium }, { default: puppeteer }] = await Promise.all([
        import('@sparticuz/chromium'),
        import('puppeteer-core'),
      ])

      return puppeteer.launch({
        args: puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
        defaultViewport: { width: 794, height: 1123, deviceScaleFactor: 1 },
        executablePath: await chromium.executablePath(),
        headless: 'shell',
      })
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new PDFExportError(
        `Chromium launch failed on hosted deployment: ${detail}`,
        'PDF export is not available on the hosted demo. Self-host ReportGenius for full PDF export. View setup instructions at https://github.com/anomalyco/report_genius',
        'PDF_EXPORT_UNAVAILABLE',
      )
    }
  }

  // standalone — full Puppeteer with bundled Chromium
  const { default: puppeteer } = await import('puppeteer')
  return puppeteer.launch({ headless: true })
}

// ── HTML → PDF ───────────────────────────────────────────────────────────────

/**
 * Render many HTML documents in ONE browser instance (a Chromium launch costs
 * seconds on serverless — never launch per document).
 */
export async function htmlsToBuffers(htmls: string[]): Promise<Buffer[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null

  try {
    browser = await launchBrowser()

    const page = await browser.newPage()
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 })

    const buffers: Buffer[] = []
    for (const html of htmls) {
      await page.setContent(html, { waitUntil: 'domcontentloaded' })
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      })
      buffers.push(Buffer.from(pdfBuffer))
    }
    return buffers
  } finally {
    if (browser !== null) {
      await browser.close()
    }
  }
}

export async function htmlToBuffer(html: string): Promise<Buffer> {
  const [buffer] = await htmlsToBuffers([html])
  return buffer
}

/** Strip characters that break Content-Disposition / filesystem filenames. */
export function safeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim()
}

export async function buffersToZip(files: Array<{ name: string; buffer: Buffer }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const archive = archiver('zip', { zlib: { level: 6 } })

    archive.on('data', (chunk: Buffer) => chunks.push(chunk))
    archive.on('end', () => resolve(Buffer.concat(chunks)))
    archive.on('error', (err: Error) => reject(err))

    for (const file of files) {
      archive.append(Readable.from(file.buffer), { name: file.name })
    }

    archive.finalize().catch(reject)
  })
}

// ── Reports XLSX workbook ────────────────────────────────────────────────────

export interface ReportRow {
  ref_id: string
  first_name: string
  last_name: string
  gender: string
  session_name: string
  status: string
  word_count: number
  report_text: string
  generated_at: string
}

const REPORT_ROW_KEYS: (keyof ReportRow)[] = [
  'ref_id', 'first_name', 'last_name', 'gender', 'session_name',
  'status', 'word_count', 'report_text', 'generated_at',
]

const COLUMN_HEADERS: Record<keyof ReportRow, string> = {
  ref_id: 'Ref ID',
  first_name: 'First Name',
  last_name: 'Last Name',
  gender: 'Gender',
  session_name: 'Session',
  status: 'Status',
  word_count: 'Word Count',
  report_text: 'Report Text',
  generated_at: 'Generated At',
}

export async function buildReportsWorkbook(rows: ReportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('Reports')

  const colWidths = [14, 18, 18, 10, 30, 10, 12, 60, 24]
  worksheet.columns = REPORT_ROW_KEYS.map((key, i) => ({
    header: COLUMN_HEADERS[key],
    key,
    width: colWidths[i] ?? 15,
  }))

  for (const row of rows) {
    worksheet.addRow(REPORT_ROW_KEYS.map((k) => row[k]))
  }

  const raw = await workbook.xlsx.writeBuffer()
  return Buffer.from(raw)
}
