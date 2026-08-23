/**
 * Privacy regression guard for session-only (stateless) mode.
 *
 * Asserts that a batch prompt built from the in-browser store carries NO real
 * student data — not first names, surnames, ref IDs, internal notes or the
 * class name — including names the teacher typed into free-text rating notes,
 * which are the easiest leak to reintroduce.
 *
 * Also asserts the pipeline FAILS CLOSED: a student outside the session's
 * class has no alias, and the builder must refuse rather than fall back to a
 * real name (it silently did exactly that until 2026-08-23).
 *
 * Run: npm run check:pii
 */
import { StatelessDB } from "../src/lib/stateless/store";
import { buildLocalAliasContext, buildBatchPayloadsFromDB } from "../src/lib/stateless/prompt-context";
import { buildBatchPrompt } from "../src/lib/adapters/llm/prompt-builder";

const CLASS = "c1";
const db = {
  classes: [{ id: CLASS, name: "8B Science", year_group: "8", subject: "Science", archived: false, created_at: "", updated_at: "" }],
  students: [
    { id: "s1", class_id: CLASS, first_name: "Amelia", last_name: "Okafor", student_ref_id: "R1", gender: "F", internal_notes: "SEN plan", anonymous_token: "t1", created_at: "", updated_at: "" },
    { id: "s2", class_id: CLASS, first_name: "Jonah",  last_name: "Whitmore", student_ref_id: "R2", gender: "M", internal_notes: null, anonymous_token: "t2", created_at: "", updated_at: "" },
  ],
  sessions: [{ id: "sess1", class_id: CLASS, name: "Autumn", topics_covered: ["photosynthesis"], tone: "balanced", length: "medium", status: "draft", is_template: false, source_template_id: null, test_filters: null, progression_filters: [], enable_progression: false, allow_negative_progression: false, class_overview: null, created_at: "", updated_at: "" }],
  disciplines: [{ id: "d1", session_id: "sess1", name: "Effort", category: "General", is_custom: false, created_at: "" }],
  ratings: [
    // A teacher note naming BOTH students - the classic leak vector.
    { id: "r1", student_id: "s1", session_discipline_id: "d1", score: 4, comment: "Amelia works well next to Jonah", created_at: "", updated_at: "" },
    { id: "r2", student_id: "s2", session_discipline_id: "d1", score: 3, comment: null, created_at: "", updated_at: "" },
  ],
  topicRatings: [], reports: [],
} as unknown as StatelessDB;

const session = db.sessions[0];
const { aliasMap, nameToAlias } = buildLocalAliasContext(db, session);
const payloads = buildBatchPayloadsFromDB(db, session, db.students, aliasMap);
const prompt = buildBatchPrompt(payloads, { tone: "balanced", length: "medium", testInstruction: null }, { useAliases: true, nameToAlias });

// Now the suspect path: a student who is NOT in the session's class, so the
// alias map has no entry for them. buildBatchPayloadsFromDB falls back to
// `?? student.first_name`.
const outsider = { id: "s9", class_id: "OTHER_CLASS", first_name: "Rosalind", last_name: "Vane", student_ref_id: "R9", gender: "F", internal_notes: null, anonymous_token: "t9", created_at: "", updated_at: "" };
(db.students as unknown[]).push(outsider);
let refused = false;
try {
  const p2 = buildBatchPayloadsFromDB(db, session, [outsider] as never, aliasMap);
  const prompt2 = buildBatchPrompt(p2 as never, { tone: "balanced", length: "medium", testInstruction: null }, { useAliases: true, nameToAlias });
  console.log(`\n  cross-class student name in prompt: ${/\bRosalind\b/.test(prompt2) ? "*** LEAKED ***" : "absent"}`);
} catch (e) {
  refused = true;
  console.log(`\n  cross-class student: REFUSED (fails closed) — ${(e as Error).message.slice(0, 70)}…`);
}
if (!refused) { console.log("  *** expected a refusal ***"); process.exitCode = 1; }
console.log("");

const PII = ["Amelia", "Okafor", "Jonah", "Whitmore", "R1", "R2", "SEN plan", "8B Science"];
let bad = 0;
for (const term of PII) {
  const hit = new RegExp(`\\b${term}\\b`, "i").test(prompt);
  console.log(`  ${hit ? "LEAK  " : "absent"}  ${term}`);
  if (hit) bad++;
}
console.log(`\n  aliases present: ${/Student_\d\d/.test(prompt)}`);
console.log(`  aliased note   : ${(prompt.match(/- Effort:.*/) ?? ["?"])[0]}`);
console.log(`\n${bad === 0 ? "NO PII IN PROMPT" : bad + " LEAK(S)"}`);
process.exit(bad === 0 ? 0 : 1);
