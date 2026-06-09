import type { PlanTask } from './types.ts'

export function buildPlanningModePrompt(activePlanName?: string): string {
  return [
    '[PLAN MODE ACTIVATED]',
    'Goal:',
    '- inspect codebase.',
    '- ask clarification when needed before creating a plan.',
    '- find the best plan to achieve the user intent.',
    '',
    'Rules:',
    '- Use read-only exploration tools freely.',
    '- Never call raw `write` or `edit` in planning mode.',
    '- Use `plan_create` to create new plans.',
    '- Use `plan_revise` to revise existing plans after review.',
    '- Bash tool is forbidden.',
    '- Do not execute the plan, just create it and refine it until it looks good.',
    "- Don't implement anything.",
    activePlanName ? `- Focused plan: ${activePlanName}` : '- No focused plan yet.',
  ].join('\n')
}

export function buildExecutionModePrompt(activePlanName: string, tasks: PlanTask[]): string {
  const remaining = tasks.filter(task => task.status === 'pending' || task.status === 'blocked')
  const nextTask = remaining[0]

  return [
    '[EXECUTION PLAN ACTIVATED]',
    `Active plan: ${activePlanName}`,
    nextTask ? `Current task: ${nextTask.id}. ${nextTask.text}` : 'No remaining task.',
    'Rules:',
    '- Work task by task.',
    '- Use `plan_update_tasks` whenever a task status changes, including completion.',
    '- Use `plan_add_task` for deferred follow-up work.',
    remaining.length > 0
      ? `Remaining: ${remaining.map(task => `${task.id}. ${task.text}`).join(' | ')}`
      : 'Remaining: none',
  ].join('\n')
}
