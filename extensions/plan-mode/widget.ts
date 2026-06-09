import type { Theme } from '@earendil-works/pi-coding-agent'
import type { Component, TUI } from '@earendil-works/pi-tui'
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import { Box, Markdown, Spacer } from '@earendil-works/pi-tui'

import type { LoadedPlan } from './types.ts'
import { formatTaskLine, resolvedTaskCount } from './utils.ts'

export class WidgetPlanSummary implements Component {
  markdownTheme = getMarkdownTheme()

  constructor(
    private tui: TUI,
    private theme: Theme,
    private plan: LoadedPlan | undefined,
    private type: 'plan' | 'exec'
  ) {}

  invalidate() {
    this.tui.requestRender()
  }

  render(width: number): string[] {
    const box = new Box(1, 1, txt => this.theme.bg('customMessageBg', txt))

    if (!this.plan) {
      if (this.type === 'plan') {
        box.addChild(
          new Markdown(
            '📝 No active plan. Use `/plan focus` to select one or prompt a new plan.',
            0,
            0,
            this.markdownTheme
          )
        )
      } else {
        box.addChild(new Markdown('Not executing a plan.', 0, 0, this.markdownTheme))
      }
      return box.render(width)
    }

    if (this.type === 'plan') {
      box.addChild(new Markdown(`📝 Plan mode: **${this.plan.name}**`, 0, 0, this.markdownTheme))
    } else {
      box.addChild(
        new Markdown(
          `${this.plan.title} · ${resolvedTaskCount(this.plan.tasks)}/${this.plan.tasks.length}`,
          0,
          0,
          this.markdownTheme,
          { bold: true }
        )
      )
    }
    box.addChild(new Spacer(1))
    const tasks = new Box(0, 0)

    const firstPendingTaskIndex = this.plan.tasks.findIndex(
      task => task.status === 'pending' || task.status === 'blocked'
    )
    this.plan.tasks.forEach((task, index) => {
      tasks.addChild(
        new Markdown(formatTaskLine(task), 0, 0, this.markdownTheme, {
          bold: index === firstPendingTaskIndex,
          strikethrough: task.status === 'skipped',
        })
      )
    })
    box.addChild(tasks)

    return box.render(width)
  }
}
