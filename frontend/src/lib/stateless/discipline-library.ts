/**
 * Discipline template library — single source of truth.
 *
 * Used directly by stateless / session-only mode, and imported by
 * frontend/prisma/seed.ts to seed the DisciplineTemplate table, so template
 * IDs behave identically in both modes.
 */

export interface DisciplineTemplateEntry {
  id: string;
  category: string;
  name: string;
  is_default: boolean;
}

export const DISCIPLINE_LIBRARY: DisciplineTemplateEntry[] = [
  // GENERAL — surfaced in quick-pick by default
  { id: "10000000-0000-0000-0000-000000000001", category: "General", name: "Behaviour", is_default: true },
  { id: "10000000-0000-0000-0000-000000000002", category: "General", name: "Homework", is_default: true },
  { id: "10000000-0000-0000-0000-000000000003", category: "General", name: "Participation", is_default: true },
  { id: "10000000-0000-0000-0000-000000000004", category: "General", name: "Effort", is_default: true },
  { id: "10000000-0000-0000-0000-000000000005", category: "General", name: "Progression", is_default: true },
  { id: "10000000-0000-0000-0000-000000000006", category: "General", name: "Attainment", is_default: true },
  { id: "10000000-0000-0000-0000-000000000007", category: "General", name: "Confidence", is_default: true },
  { id: "10000000-0000-0000-0000-000000000008", category: "General", name: "Teamwork", is_default: true },
  { id: "10000000-0000-0000-0000-000000000009", category: "General", name: "Independence", is_default: true },
  { id: "10000000-0000-0000-0000-000000000010", category: "General", name: "Listening Skills", is_default: true },

  // LANGUAGES
  { id: "20000000-0000-0000-0000-000000000001", category: "Languages", name: "Reading", is_default: false },
  { id: "20000000-0000-0000-0000-000000000002", category: "Languages", name: "Writing", is_default: false },
  { id: "20000000-0000-0000-0000-000000000003", category: "Languages", name: "Speaking", is_default: false },
  { id: "20000000-0000-0000-0000-000000000004", category: "Languages", name: "Listening", is_default: false },
  { id: "20000000-0000-0000-0000-000000000005", category: "Languages", name: "Fluency", is_default: false },
  { id: "20000000-0000-0000-0000-000000000006", category: "Languages", name: "Pronunciation", is_default: false },
  { id: "20000000-0000-0000-0000-000000000007", category: "Languages", name: "Vocabulary", is_default: false },
  { id: "20000000-0000-0000-0000-000000000008", category: "Languages", name: "Grammar", is_default: false },
  { id: "20000000-0000-0000-0000-000000000009", category: "Languages", name: "Comprehension", is_default: false },
  { id: "20000000-0000-0000-0000-000000000010", category: "Languages", name: "Verbal Communication", is_default: false },

  // MATHS
  { id: "30000000-0000-0000-0000-000000000001", category: "Maths", name: "Reasoning", is_default: false },
  { id: "30000000-0000-0000-0000-000000000002", category: "Maths", name: "Recollection", is_default: false },
  { id: "30000000-0000-0000-0000-000000000003", category: "Maths", name: "Problem Solving", is_default: false },
  { id: "30000000-0000-0000-0000-000000000004", category: "Maths", name: "Applying Knowledge", is_default: false },
  { id: "30000000-0000-0000-0000-000000000005", category: "Maths", name: "Mental Arithmetic", is_default: false },
  { id: "30000000-0000-0000-0000-000000000006", category: "Maths", name: "Accuracy", is_default: false },
  { id: "30000000-0000-0000-0000-000000000007", category: "Maths", name: "Showing Working", is_default: false },
  { id: "30000000-0000-0000-0000-000000000008", category: "Maths", name: "Data Interpretation", is_default: false },

  // SCIENCES
  { id: "40000000-0000-0000-0000-000000000001", category: "Sciences", name: "Practical Skills", is_default: false },
  { id: "40000000-0000-0000-0000-000000000002", category: "Sciences", name: "Scientific Enquiry", is_default: false },
  { id: "40000000-0000-0000-0000-000000000003", category: "Sciences", name: "Report Writing", is_default: false },
  { id: "40000000-0000-0000-0000-000000000004", category: "Sciences", name: "Data Analysis", is_default: false },
  { id: "40000000-0000-0000-0000-000000000005", category: "Sciences", name: "Knowledge Recall", is_default: false },
  { id: "40000000-0000-0000-0000-000000000006", category: "Sciences", name: "Safety Awareness", is_default: false },
  { id: "40000000-0000-0000-0000-000000000007", category: "Sciences", name: "Hypothesis Formation", is_default: false },

  // ARTS
  { id: "50000000-0000-0000-0000-000000000001", category: "Arts", name: "Creativity", is_default: false },
  { id: "50000000-0000-0000-0000-000000000002", category: "Arts", name: "Technique", is_default: false },
  { id: "50000000-0000-0000-0000-000000000003", category: "Arts", name: "Presentation", is_default: false },
  { id: "50000000-0000-0000-0000-000000000004", category: "Arts", name: "Artistic Development", is_default: false },
  { id: "50000000-0000-0000-0000-000000000005", category: "Arts", name: "Cultural Awareness", is_default: false },
  { id: "50000000-0000-0000-0000-000000000006", category: "Arts", name: "Critical Analysis", is_default: false },
  { id: "50000000-0000-0000-0000-000000000007", category: "Arts", name: "Portfolio Quality", is_default: false },

  // HUMANITIES
  { id: "60000000-0000-0000-0000-000000000001", category: "Humanities", name: "Source Analysis", is_default: false },
  { id: "60000000-0000-0000-0000-000000000002", category: "Humanities", name: "Essay Writing", is_default: false },
  { id: "60000000-0000-0000-0000-000000000003", category: "Humanities", name: "Research Skills", is_default: false },
  { id: "60000000-0000-0000-0000-000000000004", category: "Humanities", name: "Critical Thinking", is_default: false },
  { id: "60000000-0000-0000-0000-000000000005", category: "Humanities", name: "Debate & Discussion", is_default: false },
  { id: "60000000-0000-0000-0000-000000000006", category: "Humanities", name: "Chronological Understanding", is_default: false },

  // PE & SPORT
  { id: "70000000-0000-0000-0000-000000000001", category: "PE & Sport", name: "Physical Skill", is_default: false },
  { id: "70000000-0000-0000-0000-000000000002", category: "PE & Sport", name: "Tactical Awareness", is_default: false },
  { id: "70000000-0000-0000-0000-000000000003", category: "PE & Sport", name: "Sportsmanship", is_default: false },
  { id: "70000000-0000-0000-0000-000000000004", category: "PE & Sport", name: "Fitness & Effort", is_default: false },
  { id: "70000000-0000-0000-0000-000000000005", category: "PE & Sport", name: "Coaching Ability", is_default: false },
  { id: "70000000-0000-0000-0000-000000000006", category: "PE & Sport", name: "Rule Knowledge", is_default: false },
];

export function findTemplate(id: string): DisciplineTemplateEntry | undefined {
  return DISCIPLINE_LIBRARY.find((t) => t.id === id);
}
