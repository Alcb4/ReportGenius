/**
 * In-browser data store for stateless / session-only mode.
 *
 * One JSON document in sessionStorage. Record shapes mirror what the real
 * API routes select from Prisma (snake_case fields, ISO-string dates) so the
 * local handlers can return them unchanged.
 */

import { STATELESS_DB_KEY } from "./mode";

export const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000000";

export interface LocalClass {
  id: string;
  name: string;
  year_group: string | null;
  subject: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface LocalStudent {
  id: string;
  class_id: string;
  first_name: string;
  last_name: string | null;
  student_ref_id: string | null;
  gender: string | null;
  internal_notes: string | null;
  anonymous_token: string;
  created_at: string;
  updated_at: string;
}

export interface TestFilterConfig {
  includeMark?: boolean;
  includePercentage?: boolean;
  includeGrade?: boolean;
  includeLowMention?: boolean;
}

export interface LocalSession {
  id: string;
  class_id: string;
  name: string;
  topics_covered: string[];
  tone: string;
  length: string;
  status: string;
  is_template: boolean;
  source_template_id: string | null;
  test_filters: Record<string, TestFilterConfig> | null;
  progression_filters: string[];
  enable_progression: boolean;
  allow_negative_progression: boolean;
  class_overview: string | null;
  created_at: string;
  updated_at: string;
}

export interface LocalDiscipline {
  id: string;
  session_id: string;
  name: string;
  category: string | null;
  is_custom: boolean;
  created_at: string;
}

export interface LocalRating {
  id: string;
  student_id: string;
  session_discipline_id: string;
  score: number;
  comment: string | null;
  created_at: string;
  updated_at: string;
}

export interface LocalTopicRating {
  id: string;
  session_id: string;
  student_id: string;
  topic_name: string;
  score: number;
}

export interface LocalReport {
  id: string;
  student_id: string;
  session_id: string;
  anonymous_token: string;
  llm_model: string | null;
  llm_prompt: string | null;
  llm_raw_response: string | null;
  edited_content: string;
  status: string;
  word_count: number | null;
  ratings_changed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StatelessDB {
  classes: LocalClass[];
  students: LocalStudent[];
  sessions: LocalSession[];
  disciplines: LocalDiscipline[];
  ratings: LocalRating[];
  topicRatings: LocalTopicRating[];
  reports: LocalReport[];
}

function emptyDB(): StatelessDB {
  return {
    classes: [],
    students: [],
    sessions: [],
    disciplines: [],
    ratings: [],
    topicRatings: [],
    reports: [],
  };
}

export function loadDB(): StatelessDB {
  if (typeof window === "undefined") return emptyDB();
  try {
    const raw = window.sessionStorage.getItem(STATELESS_DB_KEY);
    if (!raw) return emptyDB();
    return { ...emptyDB(), ...(JSON.parse(raw) as Partial<StatelessDB>) };
  } catch {
    return emptyDB();
  }
}

/** Thrown shape matches the { error, code, status } contract of the local router. */
export class LocalApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "LocalApiError";
  }
}

export function saveDB(db: StatelessDB): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STATELESS_DB_KEY, JSON.stringify(db));
  } catch {
    throw new LocalApiError(
      "Browser storage is full — session-only mode cannot save more data in this tab",
      "STORAGE_FULL",
      507
    );
  }
}

export function newId(): string {
  // Every browser that runs this app has crypto.randomUUID (it is only
  // absent in insecure http contexts, which the app doesn't target).
  return crypto.randomUUID();
}

export function nowISO(): string {
  return new Date().toISOString();
}
