import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'

import type { LoadedPlan, PlanFileData, PlanStateFile, TaskUpdateStatus } from './types.ts'
import {
  appendDiscoveredTaskState,
  applyPlanLifecycleState,
  applyTaskStatusUpdates,
  buildLoadedPlan,
  buildPlanMarkdown,
  getPlanPaths,
  getPlansRoot,
  normalizePlanState,
  preparePlanWrite,
  serializePlanState,
  toPlanState,
} from './state.ts'
import { slugify, titleFromSlug } from './utils.ts'

function nowIso(): string {
  return new Date().toISOString()
}

async function ensurePlansRoot(cwd: string): Promise<void> {
  await mkdir(getPlansRoot(cwd), { recursive: true })
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return undefined
  }
}

async function readPlanStateFile(
  statePath: string,
  fallbackTitle: string
): Promise<PlanStateFile | undefined> {
  const content = await readTextIfExists(statePath)
  if (!content) return undefined

  try {
    return normalizePlanState(JSON.parse(content), fallbackTitle, nowIso())
  } catch {
    return undefined
  }
}

async function writePlanStateFile(statePath: string, state: PlanStateFile): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, serializePlanState(state), 'utf-8')
}

// plan.json stays the source of truth, but keeping a synced PLAN.md makes plans much easier to scan while iterating.
async function writePlanProjection(planPath: string, state: PlanStateFile): Promise<void> {
  const markdown = buildPlanMarkdown(state)
  await writeFile(planPath, markdown, 'utf-8')
}

async function withPlanLock<T>(cwd: string, name: string, fn: () => Promise<T>): Promise<T> {
  const { planPath, startPromptPath, statePath } = getPlanPaths(cwd, name)

  return withFileMutationQueue(statePath, async () =>
    withFileMutationQueue(planPath, async () => withFileMutationQueue(startPromptPath, fn))
  )
}

async function readPlanUnlocked(cwd: string, rawName: string): Promise<LoadedPlan | undefined> {
  const name = slugify(rawName) || rawName
  const paths = getPlanPaths(cwd, name)
  const dirExists = existsSync(paths.dir)

  if (!dirExists) {
    return undefined
  }

  const state = await readPlanStateFile(paths.statePath, titleFromSlug(name))
  if (!state) {
    return undefined
  }

  const startPrompt = (await readTextIfExists(paths.startPromptPath)) ?? ''
  return buildLoadedPlan(name, paths, state, startPrompt)
}

export async function readPlan(cwd: string, name: string): Promise<LoadedPlan | undefined> {
  return readPlanUnlocked(cwd, name)
}

export async function resolvePlanName(cwd: string, input: string): Promise<string | undefined> {
  const names = await listPlanNames(cwd)
  if (names.includes(input)) return input

  const lower = input.toLowerCase()
  const lowerMatch = names.find(name => name.toLowerCase() === lower)
  if (lowerMatch) return lowerMatch

  const slug = slugify(input)
  if (names.includes(slug)) return slug
  return undefined
}

async function listPlanNames(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(getPlansRoot(cwd), { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory())
      .filter(entry => existsSync(getPlanPaths(cwd, entry.name).statePath))
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

export async function listPlans(cwd: string): Promise<LoadedPlan[]> {
  const names = await listPlanNames(cwd)
  const plans = await Promise.all(names.map(name => readPlan(cwd, name)))
  return plans.filter((plan): plan is LoadedPlan => Boolean(plan))
}

export async function writePlanFiles(
  cwd: string,
  name: string,
  input: Partial<PlanFileData>
): Promise<LoadedPlan> {
  const normalizedName = slugify(name) || name

  return withPlanLock(cwd, normalizedName, async () => {
    await ensurePlansRoot(cwd)
    const current = await readPlan(cwd, normalizedName)
    const currentState = toPlanState(current)
    const { dir, planPath, startPromptPath, statePath } = getPlanPaths(cwd, normalizedName)
    await mkdir(dir, { recursive: true })

    const currentHandoff = (await readTextIfExists(startPromptPath)) ?? current?.handoff ?? ''
    const { startPrompt, state } = preparePlanWrite(
      currentState,
      titleFromSlug(normalizedName),
      input,
      currentHandoff,
      nowIso()
    )

    await writePlanStateFile(statePath, state)
    await writePlanProjection(planPath, state)
    await writeFile(startPromptPath, startPrompt, 'utf-8')

    return buildLoadedPlan(
      normalizedName,
      { dir, planPath, startPromptPath, statePath },
      state,
      startPrompt
    )
  })
}

export async function addDiscoveredTask(
  cwd: string,
  name: string,
  text: string
): Promise<LoadedPlan> {
  const normalizedName = slugify(name) || name

  return withPlanLock(cwd, normalizedName, async () => {
    const plan = await readPlan(cwd, normalizedName)
    if (!plan) {
      throw new Error(`Plan not found: ${normalizedName}`)
    }

    const state = appendDiscoveredTaskState(plan, text, nowIso())

    await writePlanStateFile(plan.statePath, state)
    await writePlanProjection(plan.planPath, state)

    return buildLoadedPlan(normalizedName, getPlanPaths(cwd, normalizedName), state, plan.handoff)
  })
}

export async function updateTaskStatuses(
  cwd: string,
  name: string,
  updates: Array<{ note?: string; task: number; status: TaskUpdateStatus }>
): Promise<LoadedPlan> {
  const normalizedName = slugify(name) || name

  return withPlanLock(cwd, normalizedName, async () => {
    const plan = await readPlan(cwd, normalizedName)
    if (!plan) {
      throw new Error(`Plan not found: ${normalizedName}`)
    }

    const state = applyTaskStatusUpdates(plan, updates, nowIso(), normalizedName)

    await writePlanStateFile(plan.statePath, state)

    return buildLoadedPlan(normalizedName, getPlanPaths(cwd, normalizedName), state, plan.handoff)
  })
}

export async function setPlanLifecycle(
  cwd: string,
  name: string,
  status: 'in-progress' | 'done' | 'superseded' | 'abandoned',
  reason?: string
): Promise<LoadedPlan> {
  const normalizedName = slugify(name) || name

  return withPlanLock(cwd, normalizedName, async () => {
    const plan = await readPlan(cwd, normalizedName)
    if (!plan) throw new Error(`Plan not found: ${normalizedName}`)

    const state = applyPlanLifecycleState(plan, status, reason, nowIso(), normalizedName)

    await writePlanStateFile(plan.statePath, state)

    return buildLoadedPlan(normalizedName, getPlanPaths(cwd, normalizedName), state, plan.handoff)
  })
}
