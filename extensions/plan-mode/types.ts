export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type ModelRef = {
  id: string
  provider: string
}

export type PlanStatus = 'in-progress' | 'done' | 'superseded' | 'abandoned'
export type PlanExplicitStatus = 'superseded' | 'abandoned' | null
export type TaskStatus = 'pending' | 'done' | 'skipped' | 'blocked'
export type TaskUpdateStatus = 'done' | 'skipped' | 'blocked'

export type PlanRegistryEntry = {
  completed: string | null
  created: string
  explicitStatus?: PlanExplicitStatus
  reason?: string | null
  status: PlanStatus
  updated: string
}

export type PlanTask = {
  createdAt: string
  id: number
  note?: string
  source: 'plan' | 'discovered'
  status: TaskStatus
  text: string
  updatedAt: string
}

export type PlanStateFile = {
  registry: PlanRegistryEntry
  summary: string
  tasks: PlanTask[]
  title: string
  version: 1
}

export type LoadedPlan = {
  derivedStatus: PlanStatus
  dir: string
  handoff: string
  name: string
  planPath: string
  registry: PlanRegistryEntry | undefined
  startPromptPath: string
  statePath: string
  summary: string
  tasks: PlanTask[]
  title: string
}

export type PlanFileData = {
  handoff: string
  summary: string
  tasks: Array<Pick<PlanTask, 'id' | 'text'>>
  title: string
}

export type SessionPlanModeStateBase = {
  activePlan?: string
  originalModel?: ModelRef
  originalThinking: ThinkingLevel
}

export type IdleSessionPlanModeState = SessionPlanModeStateBase & {
  executionMode: false
  executionModel?: undefined
  planningMode: false
  planningModel?: undefined
}

export type PlanningSessionPlanModeState = SessionPlanModeStateBase & {
  executionMode: false
  executionModel?: undefined
  planningMode: true
  planningModel?: ModelRef
}

export type ExecutionSessionPlanModeState = SessionPlanModeStateBase & {
  activePlan: string
  executionMode: true
  executionModel?: ModelRef
  planningMode: false
  planningModel?: undefined
}

export type SessionPlanModeState =
  | IdleSessionPlanModeState
  | PlanningSessionPlanModeState
  | ExecutionSessionPlanModeState
