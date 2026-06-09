import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'

import type { PlanModeRuntime } from './runtime.ts'
import type { LoadedPlan } from './types.ts'
import { resolvePlanName } from './storage.ts'
import { PLAN_STATE_ENTRY, resolvedTaskCount, slugify, statusEmoji, toModelRef } from './utils.ts'

const CLEAR_FOCUSED_PLAN_LABEL = 'Clear focused plan'
const CLEAR_FOCUSED_PLAN_ALIASES = new Set(['clear', 'none'])

function buildExecutionKickoff(plan: LoadedPlan): string {
  const remaining = plan.tasks
    .filter(task => task.status === 'pending' || task.status === 'blocked')
    .map(task => `${task.id}. ${task.text}`)
    .join('\n')

  const rules = [
    'Execution rules:',
    `- Active plan: ${plan.name}`,
    '- Work task by task in plan order.',
    '- Use `plan_update_tasks` for every task status change, including done, skipped, and blocked.',
    '- Use `plan_add_task` for deferred follow-up work.',
    '- Use `plan_status` if you need current progress snapshot.',
  ].join('\n')

  const remainingText = remaining ? `\n\nRemaining tasks:\n${remaining}` : ''
  return `${plan.handoff.trim()}\n\n${rules}${remainingText}`.trim()
}

export function registerPlanCommands(pi: ExtensionAPI, runtime: PlanModeRuntime): void {
  async function choosePlan(
    ctx: ExtensionContext,
    plans: LoadedPlan[],
    title: string
  ): Promise<LoadedPlan | null | undefined> {
    const labels = plans.map(
      plan =>
        `${statusEmoji(plan.derivedStatus)} ${plan.name} · ${resolvedTaskCount(plan.tasks)}/${plan.tasks.length} · ${plan.title}`
    )
    const options = runtime.state.activePlan ? [...labels, CLEAR_FOCUSED_PLAN_LABEL] : labels

    if (options.length === 0) {
      ctx.ui.notify('No plans on disk', 'warning')
      return undefined
    }

    const selected = await ctx.ui.select(title, options)
    if (!selected) return undefined
    if (selected === CLEAR_FOCUSED_PLAN_LABEL) return null

    const index = labels.indexOf(selected)
    return index >= 0 ? plans[index] : undefined
  }

  async function clearFocusedPlan(ctx: ExtensionContext) {
    await runtime.setActivePlan(undefined, ctx, false)
    if (ctx.hasUI) ctx.ui.notify('Focused plan cleared', 'info')
  }

  async function startExecutionSession(planName: string, ctx: ExtensionCommandContext) {
    const plan = await runtime.loadResolvedPlan(ctx.cwd, planName)
    if (!plan) {
      ctx.ui.notify(`Plan not found: ${planName}`, 'error')
      return
    }
    if (plan.tasks.length === 0) {
      ctx.ui.notify(`Plan ${plan.name} has no tasks in PLAN.md`, 'error')
      return
    }
    if (!plan.handoff.trim()) {
      ctx.ui.notify(`Plan ${plan.name} has empty START-PROMPT.md`, 'error')
      return
    }

    const model = await runtime.pickModel('Pick execution model', ctx)
    if (!model) return

    const executionModel = toModelRef(model)
    const { bootstrap, previousState } = await runtime.prepareExecutionLaunch(
      plan.name,
      executionModel,
      ctx
    )

    const kickoff = buildExecutionKickoff(plan)
    const result = await ctx.newSession({
      async setup(sessionManager) {
        sessionManager.appendCustomEntry(PLAN_STATE_ENTRY, bootstrap)
        sessionManager.appendSessionInfo(`plan:${plan.name}`)
      },
      async withSession(replacementCtx) {
        replacementCtx.ui.notify(`Executing plan: ${plan.name}`, 'info')
        await replacementCtx.sendUserMessage(kickoff)
      },
    })

    if (result.cancelled) {
      await runtime.restoreStateSnapshot(previousState, ctx)
      ctx.ui.notify('Execution session cancelled', 'warning')
    }
  }

  async function resumeExecution(ctx: ExtensionCommandContext, requestedPlan?: string) {
    const plans = (await runtime.listResolvedPlans(ctx.cwd)).filter(
      candidate => candidate.derivedStatus === 'in-progress'
    )
    if (plans.length === 0) {
      ctx.ui.notify('No in-progress plans on disk', 'warning')
      return
    }

    let plan: LoadedPlan | undefined | null
    if (requestedPlan?.trim()) {
      const resolved =
        (await resolvePlanName(ctx.cwd, requestedPlan.trim())) ?? slugify(requestedPlan.trim())
      plan =
        plans.find(item => item.name === resolved) ??
        (await runtime.loadResolvedPlan(ctx.cwd, resolved))
    } else if (runtime.state.activePlan) {
      plan = plans.find(item => item.name === runtime.state.activePlan)
    }

    if (!plan) {
      plan = await choosePlan(ctx, plans, 'Resume which plan?')
    }
    if (!plan) return

    await runtime.setActivePlan(plan.name, ctx, false)
    await startExecutionSession(plan.name, ctx)
  }

  pi.registerCommand('plan', {
    description: 'Enter plan mode, resume execution, or focus a plan',
    getArgumentCompletions(prefix: string) {
      const envs = ['resume', 'focus']
      const items = envs.map(e => ({ value: e, label: e }))
      const filtered = items.filter(i => i.value.startsWith(prefix))
      return filtered.length > 0 ? filtered : null
    },
    async handler(args, ctx) {
      const prompt = args.trim()

      if (prompt.startsWith('resume')) {
        const target = prompt.slice('resume'.length).trim()
        await resumeExecution(ctx, target || undefined)
        return
      }

      if (prompt.startsWith('focus')) {
        const target = prompt.slice('focus'.length).trim()
        const plans = await runtime.listResolvedPlans(ctx.cwd)

        let selected: LoadedPlan | null | undefined
        if (target) {
          if (CLEAR_FOCUSED_PLAN_ALIASES.has(target.toLowerCase())) {
            await clearFocusedPlan(ctx)
            return
          }

          const resolved = (await resolvePlanName(ctx.cwd, target)) ?? slugify(target)
          selected = plans.find(plan => plan.name === resolved)
        } else {
          selected = await choosePlan(ctx, plans, 'Focus which plan?')
        }

        if (selected === null) {
          await clearFocusedPlan(ctx)
          return
        }

        if (!selected && target) {
          ctx.ui.notify(`Plan not found: ${target}`, 'error')
          return
        }

        await runtime.setActivePlan(selected?.name, ctx, !!selected?.name)
        return
      }

      if (!prompt) {
        await runtime.togglePlanningMode(ctx)
        return
      }

      await runtime.togglePlanningMode(ctx, prompt)
    },
  })
}
