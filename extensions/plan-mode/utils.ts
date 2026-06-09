import type { Api, Model } from '@earendil-works/pi-ai'

import type { LoadedPlan, ModelRef, PlanStatus, PlanTask, SessionPlanModeState } from './types.ts'

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
]

const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*- /i,
  /^\s*wget\s+-O\s*-/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
]

export const PLAN_WIDGET_KEY = 'plan-todos'
export const PLAN_STATE_ENTRY = 'plan-mode-state'

export const DEFAULT_SESSION_STATE: SessionPlanModeState = {
  executionMode: false,
  originalThinking: 'medium',
  planningMode: false,
}

function cloneModelRef(ref: ModelRef | undefined): ModelRef | undefined {
  return ref ? { ...ref } : undefined
}

export function normalizeSessionState(
  state: Partial<SessionPlanModeState> | undefined
): SessionPlanModeState {
  const activePlan =
    typeof state?.activePlan === 'string' && state.activePlan.trim() ? state.activePlan : undefined
  const originalThinking = state?.originalThinking ?? DEFAULT_SESSION_STATE.originalThinking
  const originalModel = cloneModelRef(state?.originalModel)
  const planningModel = cloneModelRef(state?.planningModel)
  const executionModel = cloneModelRef(state?.executionModel)

  if (state?.executionMode && activePlan) {
    return {
      activePlan,
      executionMode: true,
      executionModel,
      originalModel,
      originalThinking,
      planningMode: false,
    }
  }

  if (state?.planningMode) {
    return {
      activePlan,
      executionMode: false,
      originalModel,
      originalThinking,
      planningMode: true,
      planningModel,
    }
  }

  return {
    activePlan,
    executionMode: false,
    originalModel,
    originalThinking,
    planningMode: false,
  }
}

export function isSafePlanCommand(command: string): boolean {
  const isDestructive = DESTRUCTIVE_PATTERNS.some(pattern => pattern.test(command))
  const isSafe = SAFE_PATTERNS.some(pattern => pattern.test(command))
  return !isDestructive && isSafe
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function titleFromSlug(name: string): string {
  return name
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

// ok
export function toModelRef(model: Model<Api> | undefined): ModelRef | undefined {
  if (!model) return undefined
  return { provider: model.provider, id: model.id }
}

// ok
export function modelRefKey(ref: ModelRef | undefined): string | undefined {
  if (!ref) return undefined
  return `${ref.provider}/${ref.id}`
}

export function resolvedTaskCount(tasks: PlanTask[]): number {
  return tasks.filter(task => task.status === 'done' || task.status === 'skipped').length
}

export function formatTaskLine(task: PlanTask): string {
  let prefix = '[ ]'
  if (task.status === 'done') prefix = '[✓]'
  else if (task.status === 'skipped') prefix = '[⇢]'
  else if (task.status === 'blocked') prefix = '[✗]'

  const suffix = task.status === 'blocked' && task.note ? ` — ${task.note}` : ''
  return `${prefix} ${task.text}${suffix}`
}

export function buildTodosText(plan: LoadedPlan): string {
  const header = `${plan.title} (${resolvedTaskCount(plan.tasks)}/${plan.tasks.length})`
  const lines = plan.tasks.map(formatTaskLine)
  return [header, ...lines].join('\n')
}

export function buildPlansSummaryText(plans: LoadedPlan[]): string {
  return plans
    .map(plan => ({
      name: plan.name,
      resolved: resolvedTaskCount(plan.tasks),
      status: plan.derivedStatus,
      title: plan.title,
      total: plan.tasks.length,
    }))
    .map(row => {
      const progress = row.total > 0 ? `${row.resolved}/${row.total}` : '0/0'
      return `${row.name} · ${row.status} · ${progress} · ${row.title}`
    })
    .join('\n')
}

export function withStatusPrefix(mode: 'plan' | 'exec', extra?: string): string {
  if (mode === 'plan') return extra ? `📝 plan ${extra}` : '📝 plan'
  return extra ? `📋 exec ${extra}` : '📋 exec'
}

export function cloneSessionState(state: SessionPlanModeState): SessionPlanModeState {
  return normalizeSessionState(state)
}

export function explicitPlanResolutionHint(planNames: string[]): string {
  if (planNames.length === 0) return 'No in-progress plans.'
  return `Choose explicit plan: ${planNames.join(', ')}`
}

export function statusEmoji(status: PlanStatus): string {
  switch (status) {
    case 'done':
      return '✓'
    case 'superseded':
      return '⇢'
    case 'abandoned':
      return '✗'
    default:
      return '…'
  }
}
