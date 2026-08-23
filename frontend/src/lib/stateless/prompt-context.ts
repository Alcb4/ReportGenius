/**
 * Client-side prompt-context assembly for stateless mode.
 *
 * Session-only mode is free-track only: the batch prompt (for pasting into
 * ChatGPT or any AI tool) is built entirely in the browser from the
 * sessionStorage store. It runs the same alias privacy pipeline as the real
 * batch-prompt route (frontend/src/app/api/v1/sessions/[sessionId]/
 * batch-prompt/route.ts): students appear as Student_NN in the prompt, and
 * the pasted response is remapped back via lib/alias-core.
 *
 * DB mode persists aliases in the SessionStudentAlias table; here they are
 * recomputed deterministically from the class roster with the same ordering
 * (first_name asc, id asc), so they are stable for a given roster.
 */

import { RawRating, BatchStudentPayload } from "@/lib/adapters/llm/types";
import { AliasMap, computeAliasMap, buildNameReplacementMap } from "@/lib/alias-core";
import { StatelessDB, LocalSession, LocalStudent } from "./store";

function ratingsFor(db: StatelessDB, sessionId: string, studentId: string): RawRating[] {
  const disciplineById = new Map(
    db.disciplines.filter((d) => d.session_id === sessionId).map((d) => [d.id, d])
  );
  return db.ratings
    .filter((r) => r.student_id === studentId && disciplineById.has(r.session_discipline_id))
    .map((r) => ({
      name: disciplineById.get(r.session_discipline_id)!.name,
      score: r.score,
      comment: r.comment,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function topicRatingsFor(db: StatelessDB, sessionId: string, studentId: string) {
  const rows = db.topicRatings
    .filter((tr) => tr.session_id === sessionId && tr.student_id === studentId)
    .sort((a, b) => a.topic_name.localeCompare(b.topic_name))
    .map((tr) => ({ topicName: tr.topic_name, score: tr.score }));
  return rows.length > 0 ? rows : undefined;
}

/**
 * The alias for a student, or a hard failure.
 *
 * An alias is missing only when the student is not in the session's class, so
 * this is a caller bug rather than a user error — but the safe outcome is no
 * prompt at all, never a prompt carrying a real name.
 */
function requireAlias(aliasMap: AliasMap, student: LocalStudent): string {
  const alias = aliasMap.studentIdToAlias.get(student.id);
  if (!alias) {
    throw new Error(
      `No alias for student ${student.id} — they are not in this session's class. ` +
        `Refusing to build a prompt rather than risk sending a real name.`
    );
  }
  return alias;
}

export interface LocalAliasContext {
  aliasMap: AliasMap;
  nameToAlias: Map<string, string>;
  classStudents: LocalStudent[];
}

/** Alias context for one session's class, mirroring getOrCreateAliases ordering. */
export function buildLocalAliasContext(db: StatelessDB, session: LocalSession): LocalAliasContext {
  const classStudents = db.students.filter((s) => s.class_id === session.class_id);
  const aliasMap = computeAliasMap(classStudents);
  return {
    aliasMap,
    nameToAlias: buildNameReplacementMap(classStudents, aliasMap),
    classStudents,
  };
}

/**
 * Per-student payloads for buildBatchPrompt (the copy-into-free-ChatGPT flow).
 * firstName carries the alias — real names never enter the prompt; free-text
 * fields are aliased inside buildBatchPrompt via options.nameToAlias.
 */
export function buildBatchPayloadsFromDB(
  db: StatelessDB,
  session: LocalSession,
  students: LocalStudent[],
  aliasMap: AliasMap
): BatchStudentPayload[] {
  return students.map((student) => ({
    id: student.id,
    // Fail closed. This used to fall back to `student.first_name` when the
    // alias map had no entry — which put a real name straight into the prompt
    // for any student outside the session's class. A privacy control must
    // never degrade silently into the thing it exists to prevent.
    firstName: requireAlias(aliasMap, student),
    gender: student.gender ?? "unspecified",
    ratings: ratingsFor(db, session.id, student.id),
    topics: session.topics_covered,
    topicRatings: topicRatingsFor(db, session.id, student.id),
    testContext: undefined,
  }));
}
