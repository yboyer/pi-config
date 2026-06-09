import { relative, resolve } from 'node:path'

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { isToolCallEventType } from '@earendil-works/pi-coding-agent'

import type { PlanModeRuntime } from './runtime.ts'
import { buildExecutionModePrompt, buildPlanningModePrompt } from './prompts.ts'
import { isSafePlanCommand, PLAN_WIDGET_KEY } from './utils.ts'

function pathNotInPlansDir(cwd: string, inputPath: string): boolean {
  const rootPlanDir = resolve(cwd, '.plans')
  const absoluteInput = resolve(cwd, inputPath)

  // If the relative path starts with '..', it means the input is outside the plans directory.
  return relative(rootPlanDir, absoluteInput).startsWith('..')
}

export function registerPlanEvents(pi: ExtensionAPI, runtime: PlanModeRuntime) {
  async function showPlanningMenu(ctx: ExtensionContext, fallbackPlanName?: string) {
    if (!runtime.state.planningMode || !ctx.hasUI || runtime.planningMenuOpen()) return

    const plans = await runtime.listResolvedPlans(ctx.cwd)
    const candidates = fallbackPlanName
      ? plans.filter(candidate => candidate.name === fallbackPlanName)
      : plans.filter(candidate => candidate.derivedStatus === 'in-progress')
    const plan = candidates[0]
    if (!plan) return

    runtime.setPlanningMenuOpen(true)
    try {
      const choice = await ctx.ui.select('Plan mode — next step?', [
        'Execute Plan',
        'Add additional instructions',
        'Exit plan mode',
      ])

      switch (choice) {
        case 'Execute Plan':
          ctx.ui.notify(`Run /plan resume ${plan.name}`, 'info')
          break

        case 'Add additional instructions': {
          const extra = await ctx.ui.editor('Add additional instructions', '')
          if (extra?.trim()) {
            pi.sendUserMessage(extra.trim())
          }
          break
        }

        default:
          await runtime.exitPlanningMode(ctx)
      }
    } finally {
      runtime.setPlanningMenuOpen(false)
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    await runtime.restoreSession(ctx)
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    if (!ctx.hasUI) return

    ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined)
  })

  pi.on('before_agent_start', async (event, ctx) => {
    if (runtime.state.planningMode) {
      const activePlan = await runtime.loadFocusedPlan(ctx.cwd)
      const planningPrompt = buildPlanningModePrompt(activePlan?.name)

      return { systemPrompt: `${event.systemPrompt}\n\n${planningPrompt}` }
    }

    if (runtime.state.executionMode && runtime.state.activePlan) {
      const plan = await runtime.loadFocusedPlan(ctx.cwd)
      if (!plan) {
        await runtime.maybeFinishExecution(ctx)
        return undefined
      }

      const executionPrompt = buildExecutionModePrompt(runtime.state.activePlan, plan.tasks)

      return { systemPrompt: `${event.systemPrompt}\n\n${executionPrompt}` }
    }

    return undefined
  })

  pi.on('agent_start', async () => {
    runtime.clearChangedPlans()
    runtime.invalidatePlanCache()
  })

  pi.on('tool_call', async (event, ctx) => {
    if (
      (isToolCallEventType('write', event) || isToolCallEventType('edit', event)) &&
      pathNotInPlansDir(ctx.cwd, event.input.path)
    ) {
      return {
        block: true,
        reason:
          'Plan mode blocked direct file modifications. Use the appropriate plan tools to modify files within a plan.',
      }
    }

    // In planning mode, block all commands
    if (!runtime.state.planningMode) return undefined

    if (isToolCallEventType('bash', event)) {
      if (!isSafePlanCommand(event.input.command)) {
        return {
          block: true,
          reason: `Plan mode blocked bash command: ${event.input.command}`,
        }
      }
    }

    return undefined
  })

  pi.on('tool_result', async (event, ctx) => {
    if (event.isError) return

    if (
      ['plan_create', 'plan_revise', 'plan_update_tasks', 'plan_add_task', 'plan_update'].includes(
        event.toolName
      )
    ) {
      const explicitPlan = typeof event.input.plan === 'string' ? event.input.plan : undefined
      runtime.noteChangedPlan(runtime.state.activePlan ?? explicitPlan)
      await runtime.refreshUi(ctx)
      await runtime.maybeFinishExecution(ctx)
    }
  })

  pi.on('turn_end', async (_event, ctx) => {
    if (!runtime.state.executionMode) return
    await runtime.maybeFinishExecution(ctx)
  })

  pi.on('agent_end', async (_event, ctx) => {
    const latest = runtime.lastChangedPlan()
    if (!runtime.state.planningMode || !latest) return

    await runtime.setActivePlan(latest, ctx, false)
    await showPlanningMenu(ctx, runtime.state.activePlan)
  })
}
