/**
 * Prompt builder — the ONLY place in the codebase that constructs LLM prompts.
 *
 * Architecture: every prompt is assembled in two parts.
 *   Part 1 — Header   (written once, contains all writing rules)
 *   Part 2 — Student blocks (one per student, data only — no repeated rules)
 *
 * Individual mode:  buildPrompt()       → header + 1 student block
 * Batch mode:       buildBatchPrompt()  → header + N student blocks
 *
 * Both modes use identical rules. The only difference is the output format
 * instruction at the top of the header.
 *
 * Privacy contract (enforced by type system):
 *   Input types contain only: firstName, gender, RawRating[], topics, tone,
 *   length, optional topicRatings, testContext, progression.
 *   NO last names, org names, class names, birthdates, or any other PII.
 */

import {
  ReportPrompt,
  BatchStudentPayload,
  BatchSessionConfig,
  ProgressionItem,
  TestContextItem,
  LENGTH_WORD_RANGE,
} from "./types";

// ── Prompt injection defence ─────────────────────────────────────────────────

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
  /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
  /forget\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
  /you\s+are\s+now\s+(a|an)\s+/gi,
  /\bsystem\s*prompt\b/gi,
  /\bact\s+as\s+/gi,
  /\bdan\s+mode\b/gi,
  /\bjailbreak\b/gi,
  /\n{2,}(human|user|assistant|system)\s*:/gi,
  /<\s*\/?system\s*>/gi,
];

function sanitize(value: string): string {
  let out = value;
  for (const pattern of INJECTION_PATTERNS) {
    out = out.replace(pattern, "…");
  }
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolvePronouns(gender: string | null | undefined): string {
  switch (gender?.toUpperCase()) {
    case "M":  return "He/Him";
    case "F":  return "She/Her";
    case "N":  return "They/Them";
    default:   return "They/Them";
  }
}

/** Tone label and one-line description for Rule 2. */
function toneDescription(tone: string): string {
  switch (tone.toLowerCase()) {
    case "gentle":
      return "Gentle: Use warm, supportive language. Frame challenges softly and celebrate effort.";
    case "direct":
      return "Direct: Use clear, precise language. State observations plainly without softening.";
    default:
      return "Balanced: Balance honesty and encouragement. Be factual but constructive.";
  }
}

/** Shape of a single test's filter config as stored in the session. */
export interface TestFilterEntry {
  includeMark?: boolean;
  includePercentage?: boolean;
  includeGrade?: boolean;
  includeLowMention?: boolean;
}

/**
 * Derive the Rule 6 (TESTS) instruction from the session's test_filters config.
 * This is the authoritative source — it fires based on what the teacher configured,
 * not on whether students happen to have results yet.
 *
 * Returns null when no tests are configured for this session (omit Rule 6 entirely).
 * When multiple score options are selected across tests (e.g. grade + low score),
 * they are merged into a single instruction.
 *
 * Call this once per prompt assembly and store the result in ReportPrompt.testInstruction
 * or BatchSessionConfig.testInstruction before passing to the prompt builders.
 */
export function resolveTestInstructionFromConfig(
  testFilters: Record<string, TestFilterEntry>,
  configuredTestIds: string[]
): string | null {
  const included = configuredTestIds.filter((id) => testFilters[id] !== undefined);
  if (included.length === 0) return null;

  const filters = included.map((id) => testFilters[id]);

  const hasLow     = filters.some((f) => f?.includeLowMention);
  const hasPercent = filters.some((f) => f?.includePercentage);
  const hasGrade   = filters.some((f) => f?.includeGrade);
  const hasMark    = filters.some((f) => f?.includeMark);
  const hasAnyScore = hasPercent || hasGrade || hasMark;

  // Build score-type label list for merged instructions
  const scoreParts: string[] = [];
  if (hasPercent) scoreParts.push("percentage score");
  if (hasGrade)   scoreParts.push("grade");
  if (hasMark)    scoreParts.push("mark (e.g. 14/20)");

  if (hasLow && hasAnyScore) {
    const scoreClause =
      scoreParts.length === 1
        ? `include the ${scoreParts[0]} as provided`
        : `include the ${scoreParts.join(" and ")} as provided`;
    return (
      `For tests with a score: ${scoreClause}. ` +
      `If a score is below 60%, acknowledge it with honest but constructive language. ` +
      `If 60% or above, reference qualitatively without mentioning the score.`
    );
  }
  if (hasLow) {
    return (
      "If a student's test score is below 60%, acknowledge it with honest but " +
      "constructive language. If 60% or above, reference the test qualitatively " +
      "without mentioning the score."
    );
  }
  if (hasAnyScore) {
    if (scoreParts.length === 1) {
      return `Reference each test and include the ${scoreParts[0]} as provided in the student block.`;
    }
    return `Reference each test using the score data provided in the student block (${scoreParts.join(", ")} as shown).`;
  }
  // All included tests are qualitative only (no score flags set)
  return "Reference the test naturally in the report. Do not mention any score, percentage, grade, or mark.";
}

// ── Progression helpers ───────────────────────────────────────────────────────

function trendPhrase(item: ProgressionItem, tone: string): string {
  const { name, trend, previous, current } = item;
  const toneKey = tone.toLowerCase();

  if (trend === "improved") {
    if (toneKey === "gentle") return `${name}: shows positive development (${previous} → ${current})`;
    if (toneKey === "direct") return `${name}: improved from ${previous} to ${current}`;
    return `${name}: improved from ${previous} to ${current}`;
  }
  if (trend === "declined") {
    if (toneKey === "gentle") return `${name}: has found some challenge in this area (${previous} → ${current})`;
    if (toneKey === "direct") return `${name}: declined from ${previous} to ${current}`;
    return `${name}: declined from ${previous} to ${current}`;
  }
  // maintained
  if (toneKey === "gentle") return `${name}: consistent performance at ${current}`;
  return `${name}: maintained at ${current}`;
}

// ── Part 1: Header ────────────────────────────────────────────────────────────

function buildHeader(
  mode: "individual" | "batch",
  studentCount: number,
  tone: string,
  wordRange: { min: number; max: number },
  testInstruction: string | null,
  hasProgression: boolean
): string {
  const outputInstruction =
    mode === "individual"
      ? "Write a report for 1 student. Respond with the report text only.\nNo labels, no JSON, no extra commentary."
      : `Write reports for ${studentCount} student${studentCount !== 1 ? "s" : ""}. Respond ONLY with a valid JSON array.\nNo text before or after the array.\nFormat: [{ "studentId": "<id>", "report": "<text>" }, ...]\nOne object per student. Any non-JSON output will break the system.`;

  const rules: string[] = [
    `1. WORD COUNT`,
    `   Write between ${wordRange.min} and ${wordRange.max} words per report.`,
    `   Do not exceed ${wordRange.max} words under any circumstances.`,
    ``,
    `2. TONE`,
    `   ${toneDescription(tone)}`,
    ``,
    `3. FORMAT`,
    `   No title, heading, greeting, or sign-off.`,
    `   Start directly with the report text.`,
    `   2–3 paragraphs separated by blank lines. No bullet points.`,
    `   Cover these three areas across the paragraphs: classroom character`,
    `   and engagement, academic performance with specific topic references,`,
    `   and where relevant a grounded forward-looking observation. Vary the`,
    `   paragraph structure naturally between students — do not apply the`,
    `   same opening or sequence to every report.`,
    ``,
    `4. DISCIPLINES`,
    `   Each student has discipline scores on a 1–5 scale.`,
    `   1 = serious concern, 2 = below expectations, 3 = satisfactory,`,
    `   4 = good, 5 = excellent.`,
    `   Weave these into natural prose to reflect the student's attitude,`,
    `   effort, and conduct. Do NOT name the discipline categories`,
    `   (never write "Behaviour", "Homework", "Participation" etc).`,
    `   Do NOT mention numeric scores.`,
    ``,
    `5. TOPICS`,
    `   Each student has topic scores on the same 1–5 scale as disciplines.`,
    `   Where topic scores differ notably from one another, acknowledge`,
    `   the contrast naturally in prose. Never mention numeric scores directly.`,
  ];

  // Rule 6 — TESTS (omit entirely when no tests; subsequent rules shift)
  if (testInstruction) {
    rules.push(``, `6. TESTS`, `   ${testInstruction}`);
  }

  const pronounRule = testInstruction ? 7 : 6;
  const qualityRule = pronounRule + 1;

  rules.push(
    ``,
    `${pronounRule}. NAME AND PRONOUNS`,
    `   Use the student's name EXACTLY ONCE, in the opening sentence,`,
    `   written exactly as it appears in their block.`,
    `   Refer to them by pronoun everywhere else — do not repeat the name,`,
    `   and do not open every report with the same sentence pattern.`,
    `   Use the student's specified pronouns consistently throughout.`,
    `   Never switch pronouns mid-report.`,
    ``,
    `${qualityRule}. QUALITY`,
    `   Express performance qualitatively using specific observations`,
    `   grounded in the student's data. Avoid generic statements.`,
    `   NEVER use these phrases — replace with grounded observations:`,
    `   "making good progress" | "shows great potential" |`,
    `   "I look forward to seeing" | "it is clear that" |`,
    `   "a valued member of the class"`
  );

  if (hasProgression) {
    const progressionRule = qualityRule + 1;
    rules.push(
      ``,
      `${progressionRule}. PROGRESSION`,
      `   Where historical discipline progression data is provided for a student,`,
      `   incorporate these trends naturally using qualitative language.`,
      `   Do NOT quote numeric scores from the progression section.`
    );
  }

  return [
    `You are a school teacher writing end-of-term report card comments.`,
    ``,
    outputInstruction,
    ``,
    `---`,
    ``,
    `WRITING RULES — apply to every report without exception:`,
    ``,
    ...rules,
  ].join("\n");
}

// ── Part 2: Student block ─────────────────────────────────────────────────────

function buildStudentBlock(
  student: {
    id: string;
    firstName: string;
    gender: string;
    ratings: { name: string; score: number; comment?: string | null }[];
    topics: string[];
    topicRatings?: Array<{ topicName: string; score: number }>;
    testContext?: TestContextItem[];
    progression?: ProgressionItem[];
    contextNote?: string;
  },
  index: number,
  total: number,
  tone: string
): string {
  const lines: string[] = [
    `=== STUDENT ${index} of ${total} ===`,
    `ID:        ${student.id}`,
    `Name:      ${sanitize(student.firstName)}`,
    `Pronouns:  ${resolvePronouns(student.gender)}`,
  ];

  // Disciplines section
  if (student.ratings.length > 0) {
    lines.push(``, `Disciplines:`);
    for (const r of student.ratings) {
      const comment = r.comment ? sanitize(r.comment) : null;
      const note = comment ? ` — ${comment}` : "";
      lines.push(`  - ${sanitize(r.name)}: ${r.score}/5${note}`);
    }
  }

  // Topics section (omit if no topics)
  const hasTopicRatings = (student.topicRatings?.length ?? 0) > 0;
  if (hasTopicRatings) {
    lines.push(``, `Topics:`);
    for (const tr of student.topicRatings!) {
      lines.push(`  - ${sanitize(tr.topicName)}: ${tr.score}/5`);
    }
  } else if (student.topics.length > 0) {
    lines.push(``, `Topics:`);
    for (const t of student.topics) {
      lines.push(`  - ${sanitize(t)}`);
    }
  }

  // Tests section (omit if no tests)
  if (student.testContext && student.testContext.length > 0) {
    lines.push(``, `Tests:`);
    for (const tc of student.testContext) {
      const parts: string[] = [];
      if (tc.percentage !== undefined) parts.push(`${tc.percentage}%`);
      if (tc.grade) parts.push(`Grade: ${sanitize(tc.grade)}`);
      if (tc.mark) parts.push(sanitize(tc.mark));
      const scorePart = parts.length > 0 ? ` — ${parts.join(" | ")}` : "";
      lines.push(`  - "${sanitize(tc.testName)}"${scorePart}`);
    }
  }

  // Historical progression section (omit if not present)
  if (student.progression && student.progression.length > 0) {
    lines.push(``, `Historical progression:`);
    for (const item of student.progression) {
      lines.push(`  - ${trendPhrase(item, tone)}`);
    }
  }

  // Additional teacher-provided context (class overview, custom note)
  if (student.contextNote) {
    lines.push(``, `Additional context:`, `  ${sanitize(student.contextNote)}`);
  }

  return lines.join("\n");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the complete prompt for individual hosted-LLM mode.
 * Part 1 (header with all rules) + Part 2 (single student block).
 */
export function buildPrompt(payload: ReportPrompt): string {
  const wordRange = LENGTH_WORD_RANGE[payload.length];
  // Use pre-computed instruction from caller (config-driven). Falls back to
  // undefined check so null (explicit "no tests") is respected.
  const testInstruction =
    payload.testInstruction !== undefined ? payload.testInstruction : null;
  const hasProgression = (payload.progression?.length ?? 0) > 0;

  const header = buildHeader(
    "individual",
    1,
    payload.tone,
    wordRange,
    testInstruction,
    hasProgression
  );

  const block = buildStudentBlock(
    {
      id: "N/A", // not surfaced in individual mode — no JSON needed
      firstName: payload.firstName,
      gender: payload.gender,
      ratings: payload.ratings,
      topics: payload.topics,
      topicRatings: payload.topicRatings,
      testContext: payload.testContext,
      progression: payload.progression,
      contextNote: payload.contextNote,
    },
    1,
    1,
    payload.tone
  );

  return `${header}\n\n${block}`;
}

/**
 * Build the complete prompt for batch (free-LLM copy) mode.
 * Part 1 (header with all rules) + Part 2 (one block per student).
 * The student ID is used in the block so the LLM can return it in JSON.
 */
export function buildBatchPrompt(
  students: BatchStudentPayload[],
  config: BatchSessionConfig
): string {
  const wordRange = LENGTH_WORD_RANGE[config.length];
  const testInstruction = config.testInstruction;
  const hasProgression = students.some((s) => (s.progression?.length ?? 0) > 0);

  const header = buildHeader(
    "batch",
    students.length,
    config.tone,
    wordRange,
    testInstruction,
    hasProgression
  );

  const blocks = students
    .map((s, i) =>
      buildStudentBlock(
        {
          id: s.id,
          firstName: s.firstName,
          gender: s.gender,
          ratings: s.ratings,
          topics: s.topics,
          topicRatings: s.topicRatings,
          testContext: s.testContext,
          progression: s.progression,
        },
        i + 1,
        students.length,
        config.tone
      )
    )
    .join("\n\n");

  return `${header}\n\n${blocks}`;
}

/**
 * Legacy export — kept so any existing callers that import formatRatingSummary
 * from this module do not break. Internally the new prompt builder uses the
 * raw ratings array directly; this helper is no longer used by buildPrompt.
 */
export function formatRatingSummary(
  ratings: Array<{ disciplineName: string; score: number; comment?: string | null }>
): string {
  return ratings
    .map((r) => {
      const base = `${r.disciplineName}: ${r.score}/5`;
      return r.comment ? `${base} (${r.comment})` : base;
    })
    .join(", ");
}
