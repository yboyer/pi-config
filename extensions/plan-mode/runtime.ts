import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent'

import type { LoadedPlan, ModelRef, SessionPlanModeState } from './types.ts'
import { listPlans, readPlan, resolvePlanName } from './storage.ts'
import {
  cloneSessionState,
  DEFAULT_SESSION_STATE,
  explicitPlanResolutionHint,
  modelRefKey,
  normalizeSessionState,
  PLAN_STATE_ENTRY,
  PLAN_WIDGET_KEY,
  slugify,
  toModelRef,
} from './utils.ts'
import { WidgetPlanSummary } from './widget.ts'

function getLastStateEntry(entries: SessionEntry[]): SessionPlanModeState | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as SessionEntry & { customType?: string; data?: unknown }
    if (entry.type === 'custom' && entry.customType === PLAN_STATE_ENTRY && entry.data) {
      return entry.data as SessionPlanModeState
    }
  }
  return undefined
}

export type PlanModeRuntime = {
  applyModel(ref: ModelRef | undefined, ctx: ExtensionContext): Promise<void>
  clearChangedPlans(): void
  exitPlanningMode(ctx: ExtensionContext): Promise<void>
  invalidatePlanCache(name?: string): void
  lastChangedPlan(): string | undefined
  listResolvedPlans(cwd: string): Promise<LoadedPlan[]>
  loadFocusedPlan(cwd: string): Promise<LoadedPlan | undefined>
  loadResolvedPlan(cwd: string, name: string): Promise<LoadedPlan | undefined>
  maybeFinishExecution(ctx: ExtensionContext): Promise<void>
  noteChangedPlan(name: string | undefined): void
  prepareExecutionLaunch(
    planName: string,
    executionModel: ModelRef | undefined,
    ctx: ExtensionContext
  ): Promise<{ bootstrap: SessionPlanModeState; previousState: SessionPlanModeState }>
  persistState(): void
  pickModel(title: string, ctx: ExtensionContext): Promise<Model<Api> | undefined>
  planningMenuOpen(): boolean
  refreshUi(ctx: ExtensionContext): Promise<void>
  rememberPlan(plan: LoadedPlan): LoadedPlan
  resolveTargetPlan(
    ctx: ExtensionContext,
    requested?: string,
    allowSummary?: boolean
  ): Promise<LoadedPlan | undefined>
  restoreOriginalConfig(ctx: ExtensionContext): Promise<void>
  restoreStateSnapshot(snapshot: SessionPlanModeState, ctx: ExtensionContext): Promise<void>
  restoreSession(ctx: ExtensionContext): Promise<void>
  setActivePlan(name: string | undefined, ctx: ExtensionContext, notify?: boolean): Promise<void>
  setPlanningMenuOpen(value: boolean): void
  state: SessionPlanModeState
  togglePlanningMode(ctx: ExtensionContext, prompt?: string): Promise<void>
}

export function createPlanModeRuntime(pi: ExtensionAPI): PlanModeRuntime {
  let state = cloneSessionState(DEFAULT_SESSION_STATE)
  let lastChangedPlanThisTurn: string | undefined
  let isPlanningMenuOpen = false
  const resolvedPlanCache = new Map<string, LoadedPlan | undefined>()
  let resolvedPlansListCache: LoadedPlan[] | undefined

  function persistState() {
    pi.appendEntry(PLAN_STATE_ENTRY, cloneSessionState(state))
  }

  async function restoreStateSnapshot(snapshot: SessionPlanModeState, ctx: ExtensionContext) {
    state = normalizeSessionState(snapshot)
    persistState()
    await refreshUi(ctx)
  }

  function invalidatePlanCache(name?: string) {
    if (!name) {
      resolvedPlanCache.clear()
      resolvedPlansListCache = undefined
      return
    }

    resolvedPlanCache.delete(name)
    resolvedPlansListCache = undefined
  }

  function rememberPlan(plan: LoadedPlan): LoadedPlan {
    resolvedPlanCache.set(plan.name, plan)
    resolvedPlansListCache = undefined
    return plan
  }

  async function loadResolvedPlan(cwd: string, name: string): Promise<LoadedPlan | undefined> {
    if (resolvedPlanCache.has(name)) return resolvedPlanCache.get(name)

    const plan = await readPlan(cwd, name)

    if (plan?.name && plan.name !== name) {
      resolvedPlanCache.delete(name)
    }

    if (plan?.name) {
      resolvedPlanCache.set(plan.name, plan)
    }
    if (plan?.name && plan.name !== name) {
      resolvedPlanCache.set(name, plan)
    } else if (!plan) {
      resolvedPlanCache.set(name, undefined)
    }

    return plan
  }

  async function listResolvedPlans(cwd: string): Promise<LoadedPlan[]> {
    if (resolvedPlansListCache) return resolvedPlansListCache

    const names = Array.from(new Set((await listPlans(cwd)).map(plan => plan.name)))
    const plans = await Promise.all(names.map(name => loadResolvedPlan(cwd, name)))
    resolvedPlansListCache = plans.filter((plan): plan is LoadedPlan => Boolean(plan))
    return resolvedPlansListCache
  }

  async function pickModel(title: string, ctx: ExtensionContext): Promise<Model<Api> | undefined> {
    const models = [...ctx.modelRegistry.getAvailable()].sort((left, right) => {
      const provider = left.provider.localeCompare(right.provider)
      if (provider !== 0) return provider
      return left.id.localeCompare(right.id)
    })

    if (models.length === 0) {
      ctx.ui.notify('No configured model available', 'error')
      return undefined
    }

    if (!ctx.hasUI || models.length === 1) {
      return ctx.model ?? models[0]
    }

    const currentKey = modelRefKey(toModelRef(ctx.model))
    const labels = models.map(model => {
      const key = `${model.provider}/${model.id}`
      return key === currentKey ? `${key} (current)` : key
    })

    const selected = await ctx.ui.select(title, labels)
    if (!selected) return undefined

    const index = labels.indexOf(selected)
    return index >= 0 ? models[index] : undefined
  }

  async function applyModel(ref: ModelRef | undefined, ctx: ExtensionContext): Promise<void> {
    if (!ref) return

    const model = ctx.modelRegistry.find(ref.provider, ref.id)
    if (!model) {
      ctx.ui.notify(`Model not found: ${ref.provider}/${ref.id}`, 'warning')
      return
    }
    const success = await pi.setModel(model)
    if (!success) {
      ctx.ui.notify(`No auth for ${ref.provider}/${ref.id}`, 'warning')
    }
  }

  async function loadFocusedPlan(cwd: string): Promise<LoadedPlan | undefined> {
    if (!state.activePlan) return undefined

    const plan = await loadResolvedPlan(cwd, state.activePlan)
    if (!plan) {
      state = normalizeSessionState({ ...state, activePlan: undefined })
      persistState()
      return undefined
    }
    if (plan.name !== state.activePlan) {
      state = normalizeSessionState({ ...state, activePlan: plan.name })
      persistState()
    }
    return plan
  }

  async function resolveTargetPlan(
    ctx: ExtensionContext,
    requested?: string,
    allowSummary = false
  ): Promise<LoadedPlan | undefined> {
    if (requested?.trim()) {
      const resolved =
        (await resolvePlanName(ctx.cwd, requested.trim())) ?? slugify(requested.trim())
      const plan = await loadResolvedPlan(ctx.cwd, resolved)
      if (!plan) throw new Error(`Plan not found: ${requested.trim()}`)
      return plan
    }

    const focused = await loadFocusedPlan(ctx.cwd)
    if (focused) return focused

    const plans = await listResolvedPlans(ctx.cwd)
    const inProgress = plans.filter(plan => plan.derivedStatus === 'in-progress')
    if (inProgress.length === 1) return inProgress[0]
    if (allowSummary && inProgress.length > 1) return undefined
    if (inProgress.length === 0) throw new Error('No in-progress plan')
    throw new Error(explicitPlanResolutionHint(inProgress.map(plan => plan.name)))
  }

  async function setActivePlan(
    name: string | undefined,
    ctx: ExtensionContext,
    notify = true
  ): Promise<void> {
    if (!name) {
      state = normalizeSessionState({ ...state, activePlan: undefined })
      persistState()
      await refreshUi(ctx)
      return
    }

    const resolved = (await resolvePlanName(ctx.cwd, name)) ?? slugify(name)
    const plan = await loadResolvedPlan(ctx.cwd, resolved)
    if (!plan) throw new Error(`Plan not found: ${name}`)

    state = normalizeSessionState({ ...state, activePlan: plan.name })
    persistState()
    await refreshUi(ctx)
    if (notify && ctx.hasUI) ctx.ui.notify(`Active plan: ${plan.name}`, 'info')
  }

  async function prepareExecutionLaunch(
    planName: string,
    executionModel: ModelRef | undefined,
    ctx: ExtensionContext
  ): Promise<{ bootstrap: SessionPlanModeState; previousState: SessionPlanModeState }> {
    const bootstrap = normalizeSessionState({
      activePlan: planName,
      executionMode: true,
      executionModel,
      originalModel: state.originalModel ?? toModelRef(ctx.model),
      originalThinking: state.originalThinking,
      planningMode: false,
    })

    const previousState = cloneSessionState(state)
    state = normalizeSessionState({
      ...state,
      activePlan: planName,
      executionMode: false,
      executionModel: undefined,
      planningMode: false,
      planningModel: undefined,
    })
    persistState()
    await refreshUi(ctx)

    return { bootstrap, previousState }
  }

  async function restoreOriginalConfig(ctx: ExtensionContext) {
    const originalModel = state.originalModel
    const originalThinking = state.originalThinking

    await applyModel(originalModel, ctx)
    pi.setThinkingLevel(originalThinking)

    state = normalizeSessionState({
      ...state,
      executionMode: false,
      executionModel: undefined,
      originalModel: undefined,
      planningMode: false,
      planningModel: undefined,
    })
    persistState()
  }

  async function exitPlanningMode(ctx: ExtensionContext) {
    if (!state.planningMode) return
    await restoreOriginalConfig(ctx)
    await refreshUi(ctx)
    if (ctx.hasUI) ctx.ui.notify('Plan mode disabled', 'info')
  }

  async function togglePlanningMode(ctx: ExtensionContext, prompt?: string) {
    if (state.executionMode) {
      ctx.ui.notify(
        'Execution active. Finish current plan or use /plan resume for another plan.',
        'warning'
      )
      return
    }

    if (state.planningMode) {
      if (!prompt) {
        await exitPlanningMode(ctx)
        return
      }

      pi.sendUserMessage(prompt)
      return
    }

    state = normalizeSessionState({
      ...state,
      originalModel: toModelRef(ctx.model),
      originalThinking: pi.getThinkingLevel(),
    })

    const model = await pickModel('Pick planning model', ctx)
    if (!model) return

    state = normalizeSessionState({
      ...state,
      executionMode: false,
      executionModel: undefined,
      planningMode: true,
      planningModel: toModelRef(model),
    })

    const success = await pi.setModel(model)
    if (!success) {
      ctx.ui.notify(`No auth for ${model.provider}/${model.id}`, 'error')
      await restoreOriginalConfig(ctx)
      return
    }

    pi.setThinkingLevel(state.originalThinking)
    persistState()
    await refreshUi(ctx)

    ctx.ui.notify(`Plan mode enabled: ${model.provider}/${model.id}`, 'info')

    if (prompt) {
      pi.sendUserMessage(prompt)
    }
  }

  async function maybeFinishExecution(ctx: ExtensionContext) {
    if (!state.executionMode) return

    if (!state.activePlan) {
      await restoreOriginalConfig(ctx)
      await refreshUi(ctx)
      if (ctx.hasUI) ctx.ui.notify('Execution stopped: active plan missing', 'warning')
      return
    }

    const activePlanName = state.activePlan
    const plan = await loadFocusedPlan(ctx.cwd)
    if (!plan) {
      await restoreOriginalConfig(ctx)
      await refreshUi(ctx)
      if (ctx.hasUI) {
        ctx.ui.notify(`Execution stopped: active plan missing (${activePlanName})`, 'warning')
      }
      return
    }

    if (plan.derivedStatus === 'in-progress') {
      await refreshUi(ctx)
      return
    }

    await restoreOriginalConfig(ctx)
    await refreshUi(ctx)
    if (ctx.hasUI) ctx.ui.notify(`Plan ended: ${plan.name}`, 'info')
  }

  async function refreshUi(ctx: ExtensionContext) {
    if (!ctx.hasUI) return

    const focused = await loadFocusedPlan(ctx.cwd)

    if (state.executionMode) {
      ctx.ui.setWidget(PLAN_WIDGET_KEY, (tui, theme) => {
        return new WidgetPlanSummary(tui, theme, focused, 'exec')
      })
      return
    }

    if (state.planningMode) {
      ctx.ui.setWidget(PLAN_WIDGET_KEY, (tui, theme) => {
        return new WidgetPlanSummary(tui, theme, focused, 'plan')
      })
      return
    }

    ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined)
  }

  function noteChangedPlan(name: string | undefined) {
    if (name) lastChangedPlanThisTurn = name
  }

  function clearChangedPlans() {
    lastChangedPlanThisTurn = undefined
  }

  function lastChangedPlan(): string | undefined {
    return lastChangedPlanThisTurn
  }

  function planningMenuOpen(): boolean {
    return isPlanningMenuOpen
  }

  function setPlanningMenuOpen(value: boolean) {
    isPlanningMenuOpen = value
  }

  async function restoreSession(ctx: ExtensionContext) {
    state = cloneSessionState(DEFAULT_SESSION_STATE)
    invalidatePlanCache()

    const restored = getLastStateEntry(ctx.sessionManager.getEntries())
    if (restored) {
      state = normalizeSessionState(restored)
    }

    if (state.activePlan) {
      const resolved = await resolvePlanName(ctx.cwd, state.activePlan)
      state = normalizeSessionState({ ...state, activePlan: resolved })
    }

    if (state.planningMode) {
      await applyModel(state.planningModel, ctx)
      pi.setThinkingLevel(state.originalThinking)
    } else if (state.executionMode) {
      await applyModel(state.executionModel, ctx)
      pi.setThinkingLevel(state.originalThinking)
    }

    persistState()
    clearChangedPlans()
    await maybeFinishExecution(ctx)
    await refreshUi(ctx)
  }

  return {
    get state() {
      return state
    },
    set state(next: SessionPlanModeState) {
      state = normalizeSessionState(next)
    },
    persistState,
    invalidatePlanCache,
    rememberPlan,
    loadResolvedPlan,
    listResolvedPlans,
    pickModel,
    applyModel,
    loadFocusedPlan,
    resolveTargetPlan,
    setActivePlan,
    restoreOriginalConfig,
    exitPlanningMode,
    togglePlanningMode,
    maybeFinishExecution,
    refreshUi,
    noteChangedPlan,
    lastChangedPlan,
    prepareExecutionLaunch,
    clearChangedPlans,
    planningMenuOpen,
    setPlanningMenuOpen,
    restoreStateSnapshot,
    restoreSession,
  }
}
