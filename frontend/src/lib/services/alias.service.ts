/**
 * Student Alias Service — privacy layer for AI generation.
 *
 * Replaces real student names with session-scoped aliases (Student_01, Student_02, ...)
 * before any prompt is sent to an external LLM or shown for copy/paste.
 *
 * Core guarantees:
 *   - Aliases are unique within a sessionId only
 *   - Real names never leave the app in prompts or LLM payloads
 *   - LLM responses are remapped back to real studentIds locally
 *   - Missing or invented aliases cause safe failures, never silent mis-maps
 *
 * The pure (prisma-free) parts live in lib/alias-core.ts so the stateless /
 * session-only mode can run the same pipeline in the browser; this module
 * re-exports them and adds the DB-backed alias persistence.
 */

import { prisma } from '@/lib/prisma'
import { AliasMap, formatAlias } from '@/lib/alias-core'

export * from '@/lib/alias-core'

export async function getOrCreateAliases(
  sessionId: string,
  classId: string,
  _studentIds: string[]
): Promise<AliasMap> {
  const existing = await prisma.sessionStudentAlias.findMany({
    where: { session_id: sessionId },
    select: { student_id: true, alias: true },
  })

  // Fetch ALL students in the class to ensure consistent alias assignment
  const allClassStudents = await prisma.student.findMany({
    where: { class_id: classId },
    select: { id: true },
    orderBy: [{ first_name: 'asc' }, { id: 'asc' }],
  })
  const allStudentIds = allClassStudents.map((s) => s.id)

  // Only recreate if we have no aliases or the class composition changed
  if (existing.length >= allStudentIds.length) {
    const studentIdToAlias = new Map<string, string>()
    const aliasToStudentId = new Map<string, string>()
    for (const entry of existing) {
      studentIdToAlias.set(entry.student_id, entry.alias)
      aliasToStudentId.set(entry.alias, entry.student_id)
    }
    return { studentIdToAlias, aliasToStudentId, nameToAlias: new Map<string, string>() }
  }

  await prisma.sessionStudentAlias.deleteMany({
    where: { session_id: sessionId },
  })

  // Assign aliases to ALL class students in consistent order (by first_name)
  const entries = allStudentIds.map((studentId, index) => ({
    session_id: sessionId,
    class_id: classId,
    student_id: studentId,
    alias: formatAlias(index + 1),
  }))

  await prisma.sessionStudentAlias.createMany({
    data: entries,
  })

  const studentIdToAlias = new Map<string, string>()
  const aliasToStudentId = new Map<string, string>()
  for (const entry of entries) {
    studentIdToAlias.set(entry.student_id, entry.alias)
    aliasToStudentId.set(entry.alias, entry.student_id)
  }

  return { studentIdToAlias, aliasToStudentId, nameToAlias: new Map<string, string>() }
}

export async function getAliasMap(sessionId: string): Promise<AliasMap> {
  const existing = await prisma.sessionStudentAlias.findMany({
    where: { session_id: sessionId },
    select: { student_id: true, alias: true },
  })

  const studentIdToAlias = new Map<string, string>()
  const aliasToStudentId = new Map<string, string>()
  for (const entry of existing) {
    studentIdToAlias.set(entry.student_id, entry.alias)
    aliasToStudentId.set(entry.alias, entry.student_id)
  }

  return { studentIdToAlias, aliasToStudentId, nameToAlias: new Map<string, string>() }
}

export async function getAliasesForClass(classId: string): Promise<AliasMap> {
  const students = await prisma.student.findMany({
    where: { class_id: classId },
    select: { id: true, first_name: true },
    orderBy: { first_name: 'asc' },
  })

  const studentIdToAlias = new Map<string, string>()
  const aliasToStudentId = new Map<string, string>()
  const nameToAlias = new Map<string, string>()

  students.forEach((s, i) => {
    const alias = formatAlias(i + 1)
    studentIdToAlias.set(s.id, alias)
    aliasToStudentId.set(alias, s.id)
    nameToAlias.set(s.first_name.toLowerCase(), alias)
  })

  return { studentIdToAlias, aliasToStudentId, nameToAlias }
}
