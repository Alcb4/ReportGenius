/**
 * Pure text helpers for LLM report output.
 *
 * Extracted from report.service.ts so prisma-free code paths (the stateless
 * local router and the shared parse-reports parser) can share them.
 */

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/** Strip a leading "Student Report:" style title line some models prepend. */
export function sanitiseLlmResponse(raw: string): string {
  const lines = raw.split('\n')
  const firstLine = lines[0].trim()

  const isTitleLine =
    /^(\*{1,2})?student report[:\s]/i.test(firstLine) ||
    /^#{1,3}\s/.test(firstLine)

  if (isTitleLine) {
    let rest = lines.slice(1)
    while (rest.length > 0 && rest[0].trim() === '') {
      rest = rest.slice(1)
    }
    return rest.join('\n').trim()
  }

  return raw.trim()
}
