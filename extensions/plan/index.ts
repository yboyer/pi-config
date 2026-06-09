import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'
import { stripFrontmatter } from '@earendil-works/pi-coding-agent'

const PLAN_SESSION_TYPE = 'plan-session'
const PLAN_PROMPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'plan.md')

type PlanSessionData = {
  sourcePath: string
  systemPrompt: string
}

function systemPromptOptionsToText(systemPromptOptions: BuildSystemPromptOptions): string {
  const lines: string[] = ['']

  if (systemPromptOptions.toolSnippets) {
    lines.push('Available tools:')
    for (const [name, description] of Object.entries(systemPromptOptions.toolSnippets)) {
      lines.push(`- ${name}: ${description}`)
    }

    lines.push('') // Add an empty line after the tools section
    lines.push(
      'In addition to the tools above, you may have access to other custom tools depending on the project.'
    )
    lines.push('') // Add an empty line after the custom tools note
  }

  if (systemPromptOptions.promptGuidelines) {
    lines.push('Guidelines:')
    for (const guideline of systemPromptOptions.promptGuidelines) {
      lines.push(`- ${guideline}`)
    }
  }

  if (systemPromptOptions.skills) {
    lines.push('<available_skills>')
    for (const skill of systemPromptOptions.skills) {
      if (skill.disableModelInvocation) {
        continue
      }
      lines.push(`  <skill>`)
      lines.push(`    <name>${skill.name}</name>`)
      lines.push(`    <description>${skill.description}</description>`)
      lines.push(`    <location>${skill.baseDir}</location>`)
      lines.push(`  </skill>`)
    }
    lines.push('</available_skills>')
  }
  lines.push(`Current date: ${new Date().toISOString().split('T')[0]}`)
  lines.push(`Current working directory: ${process.cwd()}`)

  return lines.join('\n')
}

function getPlanSessionData(entries: SessionEntry[]): PlanSessionData | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]

    if (entry.type !== 'custom' || entry.customType !== PLAN_SESSION_TYPE) {
      continue
    }

    const data = entry.data as PlanSessionData | undefined
    if (!data || typeof data.systemPrompt !== 'string' || !data.systemPrompt.trim()) {
      return undefined
    }

    return {
      sourcePath: typeof data.sourcePath === 'string' ? data.sourcePath : PLAN_PROMPT_PATH,
      systemPrompt: data.systemPrompt,
    }
  }

  return undefined
}

async function loadPlanPrompt(): Promise<PlanSessionData> {
  if (!existsSync(PLAN_PROMPT_PATH)) {
    throw new Error(`Prompt introuvable: ${PLAN_PROMPT_PATH}`)
  }

  const rawContent = await readFile(PLAN_PROMPT_PATH, 'utf-8')
  const systemPrompt = stripFrontmatter(rawContent).trim()

  if (!systemPrompt) {
    throw new Error(`Prompt vide: ${PLAN_PROMPT_PATH}`)
  }

  return {
    sourcePath: PLAN_PROMPT_PATH,
    systemPrompt,
  }
}

export default function plan(pi: ExtensionAPI) {
  let planSessionData: PlanSessionData | undefined

  pi.registerCommand('plan', {
    description: 'Start new planning session',
    async handler(args, ctx) {
      if (!ctx.hasUI) {
        return
      }

      const userPrompt = args.trim()
      if (!userPrompt) {
        ctx.ui.notify(
          'Please provide a brief description for the plan. Usage: /plan [description]',
          'info'
        )
        return
      }

      const shouldStartNewSession = await ctx.ui.confirm(
        'New /plan session?',
        `Create a new planning session?`
      )

      if (!shouldStartNewSession) {
        ctx.ui.notify('Cancelled', 'info')
        return
      }

      let planPrompt: PlanSessionData
      try {
        planPrompt = await loadPlanPrompt()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(message, 'error')
        return
      }

      const result = await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        async setup(sessionManager) {
          sessionManager.appendCustomEntry(PLAN_SESSION_TYPE, planPrompt)
        },
        async withSession(replacementCtx) {
          replacementCtx.sendUserMessage(userPrompt)
        },
      })

      if (result.cancelled) {
        ctx.ui.notify('Session creation cancelled', 'info')
      }
    },
  })

  pi.on('session_start', async (_event, ctx) => {
    const planSession = getPlanSessionData(ctx.sessionManager.getEntries())
    if (!planSession) {
      return undefined
    }

    planSessionData = planSession
    ctx.ui.notify(
      `Planning session detected. System prompt loaded from ${planSession.sourcePath}.`,
      'info'
    )
  })

  pi.on('before_agent_start', async event => {
    if (!planSessionData) {
      return undefined
    }

    return {
      systemPrompt: `${planSessionData.systemPrompt}\n\n${systemPromptOptionsToText(event.systemPromptOptions)}`,
    }
  })
}
