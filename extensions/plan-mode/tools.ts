import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { StringEnum } from '@earendil-works/pi-ai'
import { Type } from 'typebox'

import type { PlanModeRuntime } from './runtime.ts'
import {
  addDiscoveredTask,
  resolvePlanName,
  setPlanLifecycle,
  updateTaskStatuses,
  writePlanFiles,
} from './storage.ts'
import { buildTodosText } from './utils.ts'

function normalizeTaskInputs(
  tasks:
    | Array<{
        id?: number
        text: string
      }>
    | undefined
) {
  return tasks?.map((task, index) => ({
    id: task.id ?? index + 1,
    text: task.text,
  }))
}

function toolResult<T extends Record<string, unknown>>(
  text: string,
  details: T = {} as T
): AgentToolResult<T> {
  return {
    content: [{ type: 'text', text }],
    details,
  }
}

class ToolError extends Error {
  constructor(
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

const TOOL_NAMES = {
  create: 'plan_create',
  revise: 'plan_revise',
  updateTasks: 'plan_update_tasks',
  addTask: 'plan_add_task',
  status: 'plan_status',
  update: 'plan_update',
} as const

export function registerPlanTools(pi: ExtensionAPI, runtime: PlanModeRuntime) {
  pi.registerTool({
    name: TOOL_NAMES.create,
    label: 'Plan Create',
    description: 'Create a new plan and register it for later execution.',
    promptSnippet: 'Create a new plan without using raw write or edit.',
    promptGuidelines: ['Use plan_create for new plans in planning mode instead of write/edit.'],
    parameters: Type.Object({
      plan: Type.String({ description: 'Plan name; kebab-case only' }),
      title: Type.Optional(Type.String({ description: 'Plan title' })),
      summary: Type.Optional(Type.String({ description: 'Summary/context for plan' })),
      handoff: Type.Optional(Type.String({ description: 'Full handoff content' })),
      tasks: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.Optional(Type.Number({ minimum: 1 })),
            text: Type.String({ description: 'Task text' }),
          }),
          { description: 'Initial numbered tasks' }
        )
      ),
    }),
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const existing = await resolvePlanName(ctx.cwd, params.plan)
      if (existing) {
        throw new ToolError(`Plan already exists: ${existing}`, { name: existing })
      }

      const plan = runtime.rememberPlan(
        await writePlanFiles(ctx.cwd, params.plan, {
          handoff: params.handoff,
          summary: params.summary,
          tasks: normalizeTaskInputs(params.tasks),
          title: params.title,
        })
      )

      await runtime.setActivePlan(plan.name, ctx, false)
      await runtime.refreshUi(ctx)
      runtime.noteChangedPlan(plan.name)

      return toolResult(`Created ${plan.name}: ${plan.tasks.length} tasks`, { name: plan.name })
    },
  })

  pi.registerTool({
    name: TOOL_NAMES.revise,
    label: 'Plan Revise',
    description: 'Rewrite an existing plan in place: title, summary, handoff, and tasks.',
    promptSnippet: 'Revise plan files.',
    promptGuidelines: [
      'Use plan_revise to update an existing plan after review instead of editing plan storage files manually.',
    ],
    parameters: Type.Object({
      plan: Type.String({ description: 'Plan name' }),
      title: Type.Optional(Type.String({ description: 'New plan title' })),
      summary: Type.Optional(Type.String({ description: 'Summary/context' })),
      handoff: Type.Optional(Type.String({ description: 'Full handoff content' })),
      tasks: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.Optional(Type.Number({ minimum: 1 })),
            text: Type.String({ description: 'Task text' }),
          }),
          { description: 'Revised numbered tasks' }
        )
      ),
    }),
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const resolved = await resolvePlanName(ctx.cwd, params.plan)
      if (!resolved) {
        throw new ToolError(`Plan not found: ${params.plan}`, { plan: params.plan })
      }

      const plan = runtime.rememberPlan(
        await writePlanFiles(ctx.cwd, resolved, {
          handoff: params.handoff,
          summary: params.summary,
          tasks: normalizeTaskInputs(params.tasks),
          title: params.title,
        })
      )

      await runtime.setActivePlan(plan.name, ctx, false)
      await runtime.refreshUi(ctx)
      runtime.noteChangedPlan(plan.name)

      return toolResult(`Revised ${plan.name}: ${plan.tasks.length} tasks`, { name: plan.name })
    },
  })

  pi.registerTool({
    name: TOOL_NAMES.updateTasks,
    label: 'Plan Update Tasks',
    description: 'Mark one or several plan tasks done, skipped, or blocked in one call.',
    promptSnippet: 'Update one or multiple plan task states.',
    promptGuidelines: [
      'Use plan_update_tasks whenever task status changes during execution, even for a single task, including.',
    ],
    parameters: Type.Object({
      plan: Type.String({ description: 'Plan name' }),
      updates: Type.Array(
        Type.Object({
          task: Type.Number({ minimum: 1, description: 'Task number' }),
          status: StringEnum(['done', 'skipped', 'blocked'] as const, {
            description: 'New task status',
          }),
          note: Type.Optional(Type.String({ description: 'Optional note' })),
        }),
        { minItems: 1, description: 'Task updates' }
      ),
    }),
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const plan = await runtime.resolveTargetPlan(ctx, params.plan)
      if (!plan) {
        throw new ToolError('No plan resolved')
      }

      const updated = runtime.rememberPlan(
        await updateTaskStatuses(ctx.cwd, plan.name, params.updates)
      )
      await runtime.setActivePlan(updated.name, ctx, false)
      await runtime.refreshUi(ctx)

      return toolResult(`Updated ${updated.name}: ${params.updates.length} tasks`, {
        name: updated.name,
      })
    },
  })

  pi.registerTool({
    name: TOOL_NAMES.addTask,
    label: 'Plan Add Task',
    description: 'Capture a discovered follow-up task and append it to the active plan.',
    promptSnippet: 'Add deferred follow-up work to the plan.',
    promptGuidelines: ['Use plan_add_task when you discover new follow-up work during execution.'],
    parameters: Type.Object({
      plan: Type.String({ description: 'Plan name' }),
      text: Type.String({ description: 'Task text to append' }),
    }),
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const plan = await runtime.resolveTargetPlan(ctx, params.plan)
      if (!plan) {
        throw new ToolError('No plan resolved')
      }

      const updated = runtime.rememberPlan(await addDiscoveredTask(ctx.cwd, plan.name, params.text))
      await runtime.setActivePlan(updated.name, ctx, false)
      await runtime.refreshUi(ctx)

      return toolResult(
        `Added follow-up task ${updated.tasks[updated.tasks.length - 1]?.id} to ${updated.name}`,
        { name: updated.name }
      )
    },
  })

  pi.registerTool({
    name: TOOL_NAMES.status,
    label: 'Plan Status',
    description:
      'Read-only plan snapshot. Returns one plan or a progress table when several plans are active.',
    promptSnippet: 'Inspect current plan progress without mutating state.',
    promptGuidelines: [
      'Use plan_status before making plan changes if you need current task state.',
    ],
    parameters: Type.Object({
      plan: Type.String({ description: 'Plan name' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const plan = await runtime.resolveTargetPlan(ctx, params.plan, true)
      if (!plan) {
        return toolResult('No active plan', { name: params.plan })
      }

      return toolResult(buildTodosText(plan), { name: plan.name })
    },
  })

  pi.registerTool({
    name: TOOL_NAMES.update,
    label: 'Plan Update',
    description: 'Set plan lifecycle: in-progress, done, superseded, or abandoned.',
    promptSnippet: 'Close or reopen a plan.',
    promptGuidelines: [
      'Use plan_update for superseded or abandoned plans. Use done only after every task is resolved.',
    ],
    parameters: Type.Object({
      plan: Type.String({ description: 'Plan name' }),
      status: StringEnum(['in-progress', 'done', 'superseded', 'abandoned'] as const, {
        description: 'Lifecycle status',
      }),
      reason: Type.Optional(Type.String({ description: 'Reason for superseded or abandoned' })),
    }),
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (
        (params.status === 'superseded' || params.status === 'abandoned') &&
        !params.reason?.trim()
      ) {
        throw new ToolError('Reason required for superseded or abandoned')
      }

      const plan = await runtime.resolveTargetPlan(ctx, params.plan)
      if (!plan) {
        throw new ToolError('No plan resolved')
      }

      const updated = runtime.rememberPlan(
        await setPlanLifecycle(ctx.cwd, plan.name, params.status, params.reason)
      )

      return toolResult(`Plan ${updated.name} -> ${updated.derivedStatus}`, { name: updated.name })
    },
  })
}

export function unregisterPlanTools(pi: ExtensionAPI) {
  const planTools: string[] = Object.values(TOOL_NAMES)

  pi.setActiveTools(
    pi
      .getAllTools()
      .filter(tool => !planTools.includes(tool.name))
      .map(tool => tool.name)
  )
}
