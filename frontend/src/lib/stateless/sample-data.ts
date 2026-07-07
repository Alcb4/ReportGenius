/**
 * One-click sample data for stateless / session-only mode.
 *
 * Seeds a class with ten students and a report session using five common
 * disciplines from the template library, so a visitor can try rating and
 * generation without typing names first. Ratings are left empty — entering
 * them is the point of the demo.
 */

import {
  loadDB,
  saveDB,
  newId,
  nowISO,
  LocalClass,
  LocalSession,
} from "./store";
import { DISCIPLINE_LIBRARY } from "./discipline-library";

const SAMPLE_STUDENTS: Array<{ first: string; last: string; gender: string }> = [
  { first: "Amelia", last: "Barnes", gender: "F" },
  { first: "Ben", last: "Carter", gender: "M" },
  { first: "Chloe", last: "Davies", gender: "F" },
  { first: "Daniel", last: "Evans", gender: "M" },
  { first: "Ella", last: "Foster", gender: "F" },
  { first: "Finn", last: "Gallagher", gender: "M" },
  { first: "Grace", last: "Hughes", gender: "F" },
  { first: "Harry", last: "Iqbal", gender: "M" },
  { first: "Isla", last: "Jones", gender: "F" },
  { first: "Jack", last: "Khan", gender: "M" },
];

const SAMPLE_DISCIPLINES = ["Effort", "Behaviour", "Participation", "Homework", "Progression"];

/** Creates the sample class and returns its id. */
export function seedSampleClass(): string {
  const db = loadDB();
  const stamp = nowISO();

  const cls: LocalClass = {
    id: newId(),
    name: "Year 8 Science (sample)",
    year_group: "8",
    subject: "Science",
    archived: false,
    created_at: stamp,
    updated_at: stamp,
  };
  db.classes.push(cls);

  const base = Date.now();
  SAMPLE_STUDENTS.forEach((s, i) => {
    const t = new Date(base + i).toISOString();
    db.students.push({
      id: newId(),
      class_id: cls.id,
      first_name: s.first,
      last_name: s.last,
      student_ref_id: null,
      gender: s.gender,
      internal_notes: null,
      anonymous_token: newId(),
      created_at: t,
      updated_at: t,
    });
  });

  const session: LocalSession = {
    id: newId(),
    class_id: cls.id,
    name: "Autumn Term Reports",
    topics_covered: ["Cells", "Forces", "The Periodic Table"],
    tone: "balanced",
    length: "medium",
    status: "draft",
    is_template: false,
    source_template_id: null,
    test_filters: null,
    progression_filters: [],
    enable_progression: false,
    allow_negative_progression: false,
    class_overview: null,
    created_at: stamp,
    updated_at: stamp,
  };
  db.sessions.push(session);

  SAMPLE_DISCIPLINES.forEach((name, i) => {
    const template = DISCIPLINE_LIBRARY.find((t) => t.name === name);
    db.disciplines.push({
      id: newId(),
      session_id: session.id,
      name,
      category: template?.category ?? "General",
      is_custom: !template,
      created_at: new Date(base + i).toISOString(),
    });
  });

  saveDB(db);
  return cls.id;
}
