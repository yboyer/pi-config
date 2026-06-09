import { join } from 'node:path'

import type {
  LoadedPlan,
  PlanExplicitStatus,
  PlanFileData,
  PlanRegistryEntry,
  PlanStateFile,
  PlanTask,
  TaskStatus,
  TaskUpdateStatus,
} from './types.ts'

const PLANS_DIR = '.plans'
const PLAN_FILE = 'PLAN.md'
const START_PROMPT_FILE = 'START-PROMPT.md'
const PLAN_STATE_FILE = 'plan.json'

export type PlanPaths = Pick<LoadedPlan, 'dir' | 'planPath' | 'startPromptPath' | 'statePath'>

export function getPlansRoot(cwd: string): string {
  return join(cwd, PLANS_DIR)
}

export function getPlanDir(cwd: string, name: string): string {
  return join(getPlansRoot(cwd), name)
}

export function getPlanPaths(cwd: string, name: string): PlanPaths {
  const dir = getPlanDir(cwd, name)
  return {
    dir,
    planPath: join(dir, PLAN_FILE),
    startPromptPath: join(dir, START_PROMPT_FILE),
    statePath: join(dir, PLAN_STATE_FILE),
  }
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

export function buildPlanMarkdown(
  data: Pick<PlanStateFile, 'summary' | 'tasks' | 'title'>
): string {
  const parts = [`# ${data.title.trim()}`]

  if (data.summary.trim()) {
    parts.push('', '## Summary', '', data.summary.trim())
  }

  parts.push('', '## Plan', '')
  for (const task of data.tasks) {
    parts.push(`${task.id}. ${task.text.trim()}`)
  }

  return `${parts.join('\n').trim()}\n`
}

export function buildStartPromptMarkdown(title: string, handoff: string): string {
  const trimmed = handoff.trim()
  if (trimmed.length === 0) return `# ${title}\n\nFill execution handoff.\n`
  if (/^#\s+/m.test(trimmed)) return `${trimmed}\n`
  return `# ${title}\n\n${trimmed}\n`
}

function normalizeTaskText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function nextTaskId(tasks: PlanTask[]): number {
  const max = tasks.reduce((acc, task) => Math.max(acc, task.id), 0)
  return max + 1
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'pending' || value === 'done' || value === 'skipped' || value === 'blocked'
}

function isExplicitStatus(value: unknown): value is Exclude<PlanExplicitStatus, null> {
  return value === 'superseded' || value === 'abandoned'
}

function normalizeTask(raw: unknown, fallbackTimestamp: string): PlanTask | undefined {
  if (!raw || typeof raw !== 'object') return undefined

  const task = raw as Partial<PlanTask> & Record<string, unknown>
  if (typeof task.id !== 'number' || !Number.isInteger(task.id) || task.id < 1) return undefined
  if (typeof task.text !== 'string') return undefined

  const text = task.text.trim()
  if (!text) return undefined

  const createdAt =
    typeof task.createdAt === 'string' && task.createdAt.length > 0
      ? task.createdAt
      : fallbackTimestamp
  const updatedAt =
    typeof task.updatedAt === 'string' && task.updatedAt.length > 0 ? task.updatedAt : createdAt
  const note = typeof task.note === 'string' && task.note.trim() ? task.note.trim() : undefined

  return {
    createdAt,
    id: task.id,
    note,
    source: task.source === 'discovered' ? 'discovered' : 'plan',
    status: isTaskStatus(task.status) ? task.status : 'pending',
    text,
    updatedAt,
  }
}

function normalizeTasks(rawTasks: unknown, fallbackTimestamp: string): PlanTask[] {
  if (!Array.isArray(rawTasks)) return []

  return rawTasks
    .map(task => normalizeTask(task, fallbackTimestamp))
    .filter((task): task is PlanTask => Boolean(task))
    .sort((a, b) => a.id - b.id)
}

function projectedStatus(
  tasks: PlanTask[],
  explicitStatus: PlanExplicitStatus | undefined
): LoadedPlan['derivedStatus'] {
  if (explicitStatus === 'superseded' || explicitStatus === 'abandoned') return explicitStatus
  if (
    tasks.length > 0 &&
    tasks.every(task => task.status === 'done' || task.status === 'skipped')
  ) {
    return 'done'
  }
  return 'in-progress'
}

function hydrateRegistryEntry(
  previous: Partial<PlanRegistryEntry> | undefined,
  tasks: PlanTask[],
  timestamp: string
): PlanRegistryEntry {
  const created =
    typeof previous?.created === 'string' && previous.created ? previous.created : timestamp
  const explicitStatus = isExplicitStatus(previous?.explicitStatus) ? previous.explicitStatus : null
  const status = projectedStatus(tasks, explicitStatus)
  const updated =
    typeof previous?.updated === 'string' && previous.updated ? previous.updated : created
  let completed: string | null = null

  if (status === 'done') {
    completed =
      typeof previous?.completed === 'string' && previous.completed ? previous.completed : updated
  }

  return {
    completed,
    created,
    explicitStatus,
    reason:
      explicitStatus && typeof previous?.reason === 'string' && previous.reason.trim()
        ? previous.reason.trim()
        : null,
    status,
    updated,
  }
}

function projectRegistryEntry(
  previous: PlanRegistryEntry | undefined,
  tasks: PlanTask[],
  updatedAt: string
): PlanRegistryEntry {
  const hydrated = hydrateRegistryEntry(previous, tasks, updatedAt)
  return {
    ...hydrated,
    completed: hydrated.status === 'done' ? (hydrated.completed ?? updatedAt) : null,
    updated: updatedAt,
  }
}

function mergeTaskDefinitions(
  existingTasks: PlanTask[],
  parsedTasks: Array<Pick<PlanTask, 'id' | 'text'>>,
  timestamp: string
): PlanTask[] {
  const existingById = new Map(existingTasks.map(task => [task.id, task]))
  const merged: PlanTask[] = []

  for (const parsed of parsedTasks) {
    const existing = existingById.get(parsed.id)
    const sameText = existing && normalizeTaskText(existing.text) === normalizeTaskText(parsed.text)
    if (existing && sameText) {
      merged.push({
        ...existing,
        source: 'plan',
        text: parsed.text,
      })
      continue
    }

    merged.push({
      createdAt: existing?.createdAt ?? timestamp,
      id: parsed.id,
      source: 'plan',
      status: 'pending',
      text: parsed.text,
      updatedAt: timestamp,
    })
  }

  const mergedIds = new Set(merged.map(task => task.id))
  for (const existing of existingTasks) {
    if (existing.source === 'discovered' && !mergedIds.has(existing.id)) {
      merged.push(existing)
    }
  }

  return merged.sort((a, b) => a.id - b.id)
}

export function normalizePlanState(
  raw: unknown,
  fallbackTitle: string,
  fallbackTimestamp: string
): PlanStateFile | undefined {
  if (!raw || typeof raw !== 'object') return undefined

  const state = raw as Partial<PlanStateFile> & Record<string, unknown>
  const rawRegistry =
    state.registry && typeof state.registry === 'object'
      ? (state.registry as Partial<PlanRegistryEntry> & { title?: unknown })
      : undefined
  const registryTitle =
    typeof rawRegistry?.title === 'string' && rawRegistry.title.trim()
      ? rawRegistry.title.trim()
      : ''
  const title =
    typeof state.title === 'string' && state.title.trim()
      ? state.title.trim()
      : registryTitle || fallbackTitle
  const summary = typeof state.summary === 'string' ? normalizeNewlines(state.summary).trim() : ''
  const tasks = normalizeTasks(state.tasks, fallbackTimestamp)

  return {
    registry: hydrateRegistryEntry(rawRegistry, tasks, fallbackTimestamp),
    summary,
    tasks,
    title,
    version: 1,
  }
}

export function serializePlanState(state: PlanStateFile): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

export function buildLoadedPlan(
  name: string,
  paths: PlanPaths,
  state: PlanStateFile,
  handoff: string
): LoadedPlan {
  return {
    derivedStatus: projectedStatus(state.tasks, state.registry.explicitStatus),
    dir: paths.dir,
    handoff,
    name,
    planPath: paths.planPath,
    registry: state.registry,
    startPromptPath: paths.startPromptPath,
    statePath: paths.statePath,
    summary: state.summary,
    tasks: state.tasks,
    title: state.title,
  }
}

export function toPlanState(plan: LoadedPlan | undefined): PlanStateFile | undefined {
  if (!plan?.registry) return undefined

  return {
    registry: plan.registry,
    summary: plan.summary,
    tasks: plan.tasks,
    title: plan.title,
    version: 1,
  }
}

export function preparePlanWrite(
  currentState: PlanStateFile | undefined,
  fallbackTitle: string,
  input: Partial<PlanFileData>,
  currentHandoff: string,
  timestamp: string
): { startPrompt: string; state: PlanStateFile } {
  const title = input.title?.trim() || currentState?.title || fallbackTitle
  const summary = input.summary !== undefined ? input.summary.trim() : (currentState?.summary ?? '')
  const rawTasks = input.tasks ?? currentState?.tasks ?? []
  const normalizedTasks = rawTasks.map((task, index) => ({
    id: typeof task.id === 'number' ? task.id : index + 1,
    text: task.text.trim(),
  }))
  const handoff = input.handoff !== undefined ? input.handoff : currentHandoff

  const finalTasks = mergeTaskDefinitions(currentState?.tasks ?? [], normalizedTasks, timestamp)
  const state: PlanStateFile = {
    registry: projectRegistryEntry(currentState?.registry, finalTasks, timestamp),
    summary,
    tasks: finalTasks,
    title,
    version: 1,
  }

  return {
    startPrompt: buildStartPromptMarkdown(title, handoff),
    state,
  }
}

export function appendDiscoveredTaskState(
  plan: LoadedPlan,
  text: string,
  timestamp: string
): PlanStateFile {
  const tasks = [...plan.tasks]
  tasks.push({
    createdAt: timestamp,
    id: nextTaskId(tasks),
    source: 'discovered',
    status: 'pending',
    text: text.trim(),
    updatedAt: timestamp,
  })

  return {
    registry: projectRegistryEntry(plan.registry, tasks, timestamp),
    summary: plan.summary,
    tasks,
    title: plan.title,
    version: 1,
  }
}

export function applyTaskStatusUpdates(
  plan: LoadedPlan,
  updates: Array<{ note?: string; task: number; status: TaskUpdateStatus }>,
  timestamp: string,
  planName: string
): PlanStateFile {
  const tasks = plan.tasks.map(task => ({ ...task }))

  for (const update of updates) {
    const task = tasks.find(item => item.id === update.task)
    if (!task) throw new Error(`Task ${update.task} not found in ${planName}`)
    task.status = update.status
    task.note = update.note?.trim() || task.note
    task.updatedAt = timestamp
  }

  return {
    registry: projectRegistryEntry(plan.registry, tasks, timestamp),
    summary: plan.summary,
    tasks,
    title: plan.title,
    version: 1,
  }
}

export function applyPlanLifecycleState(
  plan: LoadedPlan,
  status: 'in-progress' | 'done' | 'superseded' | 'abandoned',
  reason: string | undefined,
  timestamp: string,
  planName: string
): PlanStateFile {
  const currentEntry = plan.registry ?? projectRegistryEntry(undefined, plan.tasks, timestamp)
  let registry: PlanRegistryEntry

  if (status === 'done') {
    const unresolved = plan.tasks.filter(
      task => task.status !== 'done' && task.status !== 'skipped'
    )
    if (unresolved.length > 0) {
      throw new Error(`Cannot mark ${planName} done while tasks remain unresolved`)
    }
    registry = {
      ...currentEntry,
      completed: currentEntry.completed ?? timestamp,
      explicitStatus: null,
      reason: null,
      status: 'done',
      updated: timestamp,
    }
  } else if (status === 'in-progress') {
    registry = {
      ...projectRegistryEntry(currentEntry, plan.tasks, timestamp),
      explicitStatus: null,
      reason: null,
    }
  } else {
    registry = {
      ...currentEntry,
      completed: null,
      explicitStatus: status,
      reason: reason?.trim() || null,
      status,
      updated: timestamp,
    }
  }

  return {
    registry,
    summary: plan.summary,
    tasks: plan.tasks,
    title: plan.title,
    version: 1,
  }
}
