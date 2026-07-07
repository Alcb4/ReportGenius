import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";
// Discipline template library — single source of truth shared with
// stateless / session-only mode.
import { DISCIPLINE_LIBRARY } from "../src/lib/stateless/discipline-library";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log(JSON.stringify({ event: "seed_start", ts: new Date().toISOString() }));

  // ── 1. Organization ────────────────────────────────────────────────────────
  const org = await prisma.organization.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Test School",
      settings: { default_model: "gpt-4o-mini", report_length: "medium" },
    },
  });
  console.log(JSON.stringify({ event: "upserted_org", id: org.id, name: org.name }));

  // ── 2. User ────────────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash("password", 12);
  const user = await prisma.user.upsert({
    where: { email: "teacher@test.com" },
    update: {},
    create: {
      email: "teacher@test.com",
      password_hash: passwordHash,
      organization_id: org.id,
    },
  });
  console.log(JSON.stringify({ event: "upserted_user", id: user.id, email: user.email }));

  // ── 3. Class ───────────────────────────────────────────────────────────────
  const cls = await prisma.class.upsert({
    where: { id: "00000000-0000-0000-0000-000000000002" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000002",
      organization_id: org.id,
      name: "Year 8 Math",
      year_group: "8",
      subject: "Math",
      archived: false,
    },
  });
  console.log(JSON.stringify({ event: "upserted_class", id: cls.id, name: cls.name }));

  // ── 4. Discipline templates ────────────────────────────────────────────────
  for (const tmpl of DISCIPLINE_LIBRARY) {
    await prisma.disciplineTemplate.upsert({
      where: { id: tmpl.id },
      update: {},
      create: {
        id: tmpl.id,
        category: tmpl.category,
        name: tmpl.name,
        is_default: tmpl.is_default,
      },
    });
  }
  console.log(JSON.stringify({ event: "upserted_discipline_templates", count: DISCIPLINE_LIBRARY.length }));

  // ── 5. Students ────────────────────────────────────────────────────────────
  const studentDefs: Array<{
    id: string;
    anonymous_token: string;
    first_name: string;
    last_name: string;
    gender: string;
  }> = [
    { id: "00000000-0000-0000-0000-000000000020", anonymous_token: "a1000000-0000-0000-0000-000000000001", first_name: "Emma",  last_name: "Thompson", gender: "F" },
    { id: "00000000-0000-0000-0000-000000000021", anonymous_token: "a1000000-0000-0000-0000-000000000002", first_name: "James", last_name: "Carter",   gender: "M" },
    { id: "00000000-0000-0000-0000-000000000022", anonymous_token: "a1000000-0000-0000-0000-000000000003", first_name: "Sofia", last_name: "Rossi",    gender: "F" },
    { id: "00000000-0000-0000-0000-000000000023", anonymous_token: "a1000000-0000-0000-0000-000000000004", first_name: "Luca",  last_name: "Bianchi",  gender: "M" },
    { id: "00000000-0000-0000-0000-000000000024", anonymous_token: "a1000000-0000-0000-0000-000000000005", first_name: "Aisha", last_name: "Patel",    gender: "F" },
  ];

  const students: { id: string; first_name: string }[] = [];
  for (const def of studentDefs) {
    const student = await prisma.student.upsert({
      where: { id: def.id },
      update: {},
      create: {
        id: def.id,
        organization_id: org.id,
        class_id: cls.id,
        first_name: def.first_name,
        last_name: def.last_name,
        anonymous_token: def.anonymous_token,
        gender: def.gender,
      },
    });
    students.push({ id: student.id, first_name: student.first_name });
    console.log(JSON.stringify({ event: "upserted_student", id: student.id, name: student.first_name }));
  }

  // ── 6a. Past completed session (for progression comparison) ──────────────────
  // updated_at is @updatedAt so Prisma manages it; force it via raw SQL after upsert.
  const pastSession = await prisma.reportSession.upsert({
    where: { id: "00000000-0000-0000-0000-000000000029" },
    update: { status: "complete" },
    create: {
      id: "00000000-0000-0000-0000-000000000029",
      organization_id: org.id,
      class_id: cls.id,
      name: "End of Term 0 (Baseline)",
      topics_covered: ["Number Skills"],
      tone: "balanced",
      length: "medium",
      status: "complete",
      progression_filters: [],
    },
  });
  // Force updated_at to a past date so progression-data endpoint finds it as "most recently completed".
  await prisma.$executeRaw`
    UPDATE report_sessions
    SET updated_at = '2026-03-01 10:00:00'::timestamptz
    WHERE id = '00000000-0000-0000-0000-000000000029'
  `;
  console.log(JSON.stringify({ event: "upserted_past_session", id: pastSession.id, name: pastSession.name }));

  // ── 6b. SessionDisciplines for past session — same names so they match ──────
  const pastDiscDefs: Array<{ id: string; name: string; category: string }> = [
    { id: "00000000-0000-0000-0000-000000000044", name: "Behaviour",    category: "General" },
    { id: "00000000-0000-0000-0000-000000000045", name: "Homework",     category: "General" },
    { id: "00000000-0000-0000-0000-000000000046", name: "Participation",category: "General" },
    { id: "00000000-0000-0000-0000-000000000047", name: "Effort",       category: "General" },
  ];

  const pastDiscs: { id: string; name: string }[] = [];
  for (const def of pastDiscDefs) {
    const sd = await prisma.sessionDiscipline.upsert({
      where: { id: def.id },
      update: {},
      create: {
        id: def.id,
        session_id: pastSession.id,
        name: def.name,
        category: def.category,
        is_custom: false,
      },
    });
    pastDiscs.push({ id: sd.id, name: sd.name });
    console.log(JSON.stringify({ event: "upserted_past_disc", id: sd.id, name: sd.name }));
  }

  // ── 6c. Past session ratings — lower scores to create visible progression ────
  // Scores are 1 lower per student on average so current session shows improvement.
  const pastScores: number[][] = [
    // Emma:  Behaviour, Homework, Participation, Effort
    [4, 3, 4, 3],
    // James
    [2, 2, 3, 2],
    // Sofia
    [4, 4, 3, 4],
    // Luca
    [3, 2, 2, 3],
    // Aisha
    [4, 3, 4, 4],
  ];

  let pastRatingCount = 0;
  for (let si = 0; si < students.length; si++) {
    for (let di = 0; di < pastDiscs.length; di++) {
      const ratingId = `00000000-0000-0001-${String(si).padStart(4, "0")}-${String(di).padStart(12, "0")}`;
      const student = students[si];
      const disc = pastDiscs[di];
      if (!student || !disc) continue;
      await prisma.rating.upsert({
        where: { id: ratingId },
        update: {},
        create: {
          id: ratingId,
          student_id: student.id,
          session_discipline_id: disc.id,
          score: pastScores[si]?.[di] ?? 3,
          comment: null,
        },
      });
      pastRatingCount++;
    }
  }
  console.log(JSON.stringify({ event: "past_ratings_seeded", count: pastRatingCount }));

  // ── 6. Current ReportSession ───────────────────────────────────────────────
  const session = await prisma.reportSession.upsert({
    where: { id: "00000000-0000-0000-0000-000000000030" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000030",
      organization_id: org.id,
      class_id: cls.id,
      name: "End of Term 1",
      topics_covered: ["Algebra", "Fractions"],
      tone: "balanced",
      length: "medium",
      status: "draft",
    },
  });
  console.log(JSON.stringify({ event: "upserted_session", id: session.id, name: session.name }));

  // ── 7. SessionDisciplines — 4 General disciplines ──────────────────────────
  // Behaviour, Homework, Participation, Effort (from General template IDs)
  const sessionDiscDefs: Array<{ id: string; name: string; category: string }> = [
    { id: "00000000-0000-0000-0000-000000000040", name: "Behaviour",    category: "General" },
    { id: "00000000-0000-0000-0000-000000000041", name: "Homework",     category: "General" },
    { id: "00000000-0000-0000-0000-000000000042", name: "Participation",category: "General" },
    { id: "00000000-0000-0000-0000-000000000043", name: "Effort",       category: "General" },
  ];

  const sessionDiscs: { id: string; name: string }[] = [];
  for (const def of sessionDiscDefs) {
    const sd = await prisma.sessionDiscipline.upsert({
      where: { id: def.id },
      update: {},
      create: {
        id: def.id,
        session_id: session.id,
        name: def.name,
        category: def.category,
        is_custom: false,
      },
    });
    sessionDiscs.push({ id: sd.id, name: sd.name });
    console.log(JSON.stringify({ event: "upserted_session_discipline", id: sd.id, name: sd.name }));
  }

  // ── 8. Ratings — sample scores (1-5) per student × session discipline ──────
  const sampleScores: number[][] = [
    // Emma:  Behaviour, Homework, Participation, Effort
    [5, 4, 5, 4],
    // James
    [3, 2, 4, 3],
    // Sofia
    [5, 5, 4, 5],
    // Luca
    [4, 3, 3, 4],
    // Aisha
    [5, 4, 5, 5],
  ];

  const sampleComments: string[][] = [
    ["Excellent conduct throughout the term.", "Consistently submits on time.", "Very engaged in class.", "Strong improvement noted."],
    ["Good effort, some disruptions early term.", "Occasionally late with submissions.", "Participates when called upon.", "Steady progress."],
    ["Model student behaviour.", "Outstanding homework quality.", "Actively contributes to discussions.", "Top of class performance."],
    ["Generally well-behaved.", "Needs occasional reminders.", "Could participate more.", "Good steady progress."],
    ["Exemplary behaviour.", "Always thorough and timely.", "Leads class discussions.", "Exceptional growth this term."],
  ];

  let ratingCount = 0;
  for (let si = 0; si < students.length; si++) {
    for (let di = 0; di < sessionDiscs.length; di++) {
      const ratingId = `00000000-0000-0000-${String(si).padStart(4, "0")}-${String(di).padStart(12, "0")}`;
      const student = students[si];
      const disc = sessionDiscs[di];
      if (!student || !disc) continue;
      await prisma.rating.upsert({
        where: { id: ratingId },
        update: {},
        create: {
          id: ratingId,
          student_id: student.id,
          session_discipline_id: disc.id,
          score: sampleScores[si]?.[di] ?? 3,
          comment: sampleComments[si]?.[di] ?? null,
        },
      });
      ratingCount++;
    }
  }

  console.log(JSON.stringify({
    event: "seed_complete",
    summary: {
      organizations: 1,
      users: 1,
      classes: 1,
      discipline_templates: DISCIPLINE_LIBRARY.length,
      students: students.length,
      sessions: 2,
      session_disciplines: sessionDiscs.length + pastDiscs.length,
      ratings: ratingCount + pastRatingCount,
    },
    ts: new Date().toISOString(),
  }));
}

main()
  .catch((err: unknown) => {
    console.error(JSON.stringify({ event: "seed_error", error: String(err) }));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
