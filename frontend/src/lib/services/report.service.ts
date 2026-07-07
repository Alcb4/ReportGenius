import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { createLLMAdapter } from '@/lib/adapters/llm/factory'
import { buildPrompt, resolveTestInstructionFromConfig } from '@/lib/adapters/llm/prompt-builder'
import { ReportLength, RawRating, ProgressionItem, TestContextItem } from '@/lib/adapters/llm/types'
import { decryptApiKey } from '@/lib/encryption'
import { getOrCreateAliases, buildNameReplacementMap, buildAliasToNameMap, replaceAliasesInText } from '@/lib/services/alias.service'
import { countWords, sanitiseLlmResponse } from '@/lib/report-text'

export interface GenerateReportOptions {
  tone: string
  length: ReportLength
  llmProvider?: string
  progression?: ProgressionItem[]
}

export interface GeneratedReport {
  id: string
  organization_id: string
  student_id: string
  session_id: string
  anonymous_token: string
  llm_model: string | null
  llm_prompt: string | null
  llm_raw_response: string | null
  edited_content: string
  status: string
  word_count: number | null
  created_at: Date
  updated_at: Date
}

async function resolveOrgLlmSettings(orgId: string): Promise<{ provider: string; apiKey: string; model: string }> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { settings: true },
  })

  const settings = (org?.settings ?? {}) as Record<string, unknown>
  const provider = (settings.llm_provider as string) ?? process.env.LLM_PROVIDER ?? 'openai'
  const model = (settings.model as string) ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
  const encryptedKey = settings.encrypted_api_key as string | undefined

  let apiKey: string
  if (provider === 'ollama') {
    apiKey = (settings.ollama_url as string) ?? process.env.OLLAMA_URL ?? 'http://localhost:11434'
  } else if (encryptedKey) {
    apiKey = decryptApiKey(encryptedKey)
  } else {
    // Fall back to env vars for local dev without DB settings configured
    apiKey =
      provider === 'claude'
        ? (process.env.CLAUDE_API_KEY ?? '')
        : (process.env.OPENAI_API_KEY ?? '')
  }

  if (provider !== 'ollama' && !apiKey) {
    throw Object.assign(
      new Error(`No API key configured for provider "${provider}". Add one in Settings.`),
      { code: 'LLM_NO_API_KEY', statusCode: 500 }
    )
  }

  return { provider, apiKey, model }
}

export async function generateSingleReport(
  studentId: string,
  sessionId: string,
  orgId: string,
  options: GenerateReportOptions
): Promise<GeneratedReport> {
  const { tone, length, progression: optionsProgression } = options

  const { provider, apiKey, model: orgModel } = await resolveOrgLlmSettings(orgId)

  const [session, student] = await Promise.all([
    prisma.reportSession.findFirst({
      where: { id: sessionId, organization_id: orgId },
      select: {
        id: true,
        class_id: true,
        topics_covered: true,
        tone: true,
        length: true,
        test_filters: true,
        disciplines: {
          select: { id: true, name: true },
          orderBy: { created_at: 'asc' },
        },
      },
    }),
    prisma.student.findFirst({
      where: { id: studentId, organization_id: orgId },
      select: {
        id: true,
        first_name: true,
        gender: true,
        anonymous_token: true,
      },
    }),
  ])

  if (!session) {
    throw Object.assign(
      new Error('Session not found or does not belong to this organization'),
      { code: 'SESSION_NOT_FOUND', statusCode: 404 }
    )
  }

  if (!student) {
    throw Object.assign(
      new Error('Student not found or does not belong to this organization'),
      { code: 'STUDENT_NOT_FOUND', statusCode: 404 }
    )
  }

  const disciplineIds = session.disciplines.map((d) => d.id)

  const ratings = await prisma.rating.findMany({
    where: {
      student_id: studentId,
      session_discipline_id: { in: disciplineIds },
    },
    select: {
      score: true,
      comment: true,
      session_discipline: {
        select: { name: true },
      },
    },
    orderBy: { session_discipline: { name: 'asc' } },
  })

  if (ratings.length === 0) {
    throw Object.assign(
      new Error('Student has no ratings for this session — add ratings before generating a report'),
      { code: 'NO_RATINGS', statusCode: 422 }
    )
  }

  const rawRatings: RawRating[] = ratings.map((r) => ({
    name: r.session_discipline.name,
    score: r.score,
    comment: r.comment,
  }))

  const topicRatingRows = await prisma.topicRating.findMany({
    where: {
      session_id: sessionId,
      student_id: studentId,
      organization_id: orgId,
    },
    select: { topic_name: true, score: true },
    orderBy: { topic_name: 'asc' },
  })

  const topicRatings =
    topicRatingRows.length > 0
      ? topicRatingRows.map((tr) => ({
          topicName: tr.topic_name,
          score: tr.score,
        }))
      : undefined

  const testFilters = (session.test_filters ?? {}) as Record<string, {
    includeMark?: boolean
    includePercentage?: boolean
    includeGrade?: boolean
    includeLowMention?: boolean
  }>

  // Derive included test IDs from test_filters keys (tests may be class-level with no session_id,
  // so we query by ID directly rather than relying on the session→tests Prisma relation).
  const configuredTestIds = Object.keys(testFilters)
  const allIncludedTests = configuredTestIds.length > 0
    ? await prisma.test.findMany({
        where: { id: { in: configuredTestIds }, class_id: session.class_id },
        select: { id: true, name: true, max_mark: true },
      })
    : []

  // Rule 6 instruction derived from config — fires regardless of whether results exist yet
  const testInstruction = resolveTestInstructionFromConfig(
    testFilters,
    allIncludedTests.map((t) => t.id)
  )

  // Tests that need score data fetched (have at least one score flag set)
  const scoredTestIds = allIncludedTests
    .filter((t) => {
      const f = testFilters[t.id]
      return f && (f.includePercentage || f.includeGrade || f.includeLowMention || f.includeMark)
    })
    .map((t) => t.id)

  let testContext: TestContextItem[] | undefined

  if (allIncludedTests.length > 0) {
    const testResults = scoredTestIds.length > 0
      ? await prisma.testResult.findMany({
          where: { test_id: { in: scoredTestIds }, student_id: studentId },
          select: { test_id: true, score: true, calculated: true },
        })
      : []
    const resultByTestId = new Map(testResults.map((r) => [r.test_id, r]))
    const items: TestContextItem[] = []
    for (const test of allIncludedTests) {
      const filter = testFilters[test.id]
      const isScored = filter.includePercentage || filter.includeGrade || filter.includeLowMention || filter.includeMark
      if (isScored) {
        const result = resultByTestId.get(test.id)
        if (!result) continue  // no result yet — skip from block (Rule 6 still fires via testInstruction)
        const calc = result.calculated as { percentage: number; grade: string | null }
        const item: TestContextItem = { testName: test.name }
        if (filter.includePercentage || filter.includeLowMention) item.percentage = calc.percentage
        if (filter.includeGrade) item.grade = calc.grade
        if (filter.includeLowMention) item.lowMention = true
        if (filter.includeMark) item.mark = `${result.score}/${test.max_mark}`
        items.push(item)
      } else {
        // Qualitative only — always include with just test name; no result needed
        items.push({ testName: test.name })
      }
    }
    if (items.length > 0) testContext = items
  }

  const effectiveTone = tone || session.tone
  const effectiveLength = length || (session.length as ReportLength)

  let resolvedProgression: ProgressionItem[] | undefined = optionsProgression

  if (resolvedProgression === undefined) {
    const prevSession = await prisma.reportSession.findFirst({
      where: {
        class_id: session.class_id,
        organization_id: orgId,
        status: 'complete',
        id: { not: sessionId },
      },
      select: {
        disciplines: { select: { id: true, name: true } },
      },
      orderBy: { updated_at: 'desc' },
    })

    if (prevSession) {
      const prevDisciplineIds = prevSession.disciplines.map((d) => d.id)

      const prevRatings = await prisma.rating.findMany({
        where: {
          student_id: studentId,
          session_discipline_id: { in: prevDisciplineIds },
        },
        select: {
          score: true,
          session_discipline: { select: { name: true } },
        },
      })

      const previousScoreByName = new Map<string, number>()
      for (const r of prevRatings) {
        previousScoreByName.set(r.session_discipline.name, r.score)
      }

      const currentScoreByName = new Map<string, number>()
      for (const r of ratings) {
        currentScoreByName.set(r.session_discipline.name, r.score)
      }

      const matched: ProgressionItem[] = []
      for (const [name, currentScore] of currentScoreByName) {
        const previousScore = previousScoreByName.get(name)
        if (previousScore === undefined) continue
        const trend: ProgressionItem['trend'] =
          currentScore > previousScore
            ? 'improved'
            : currentScore < previousScore
            ? 'declined'
            : 'maintained'
        matched.push({ name, trend, previous: previousScore, current: currentScore })
      }

      if (matched.length > 0) {
        resolvedProgression = matched
      }
    }
  }

  const reportPrompt = {
    firstName: student.first_name,
    gender: student.gender ?? 'unspecified',
    ratings: rawRatings,
    topics: session.topics_covered,
    tone: effectiveTone,
    length: effectiveLength,
    topicRatings,
    progression: resolvedProgression,
    testContext,
    testInstruction,
  }

  // Apply alias for privacy before sending to LLM
  const aliasMap = await getOrCreateAliases(sessionId, session.class_id, [studentId])
  const alias = aliasMap.studentIdToAlias.get(studentId) ?? student.first_name

  // Fetch all session students for name→alias map
  const sessionStudents = await prisma.student.findMany({
    where: { class_id: session.class_id },
    select: { id: true, first_name: true },
  })
  const nameToAlias = buildNameReplacementMap(sessionStudents, aliasMap)

  const aliasedPrompt = {
    ...reportPrompt,
    firstName: alias,
  }

  const promptText = buildPrompt(aliasedPrompt, nameToAlias)

  const adapter = createLLMAdapter(provider, apiKey)

  const rawResponse = await adapter.generateReport(reportPrompt)

  // Replace aliases back to real names in the LLM response
  const aliasToName = buildAliasToNameMap(sessionStudents, aliasMap)
  const cleanedResponse = sanitiseLlmResponse(replaceAliasesInText(rawResponse, aliasToName))
  const words = countWords(cleanedResponse)

  const saved = await prisma.report.create({
    data: {
      organization_id: orgId,
      student_id: studentId,
      session_id: sessionId,
      anonymous_token: student.anonymous_token,
      llm_model: orgModel,
      llm_prompt: promptText,
      llm_raw_response: rawResponse,
      edited_content: cleanedResponse,
      status: 'draft',
      word_count: words,
    } satisfies Prisma.ReportUncheckedCreateInput,
  })

  return saved
}
