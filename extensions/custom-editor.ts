import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'

import type { ExtensionAPI, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent'
import type { EditorTheme, TUI } from '@earendil-works/pi-tui'
import { CustomEditor } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

const execFileAsync = promisify(execFile)

type SessionState = {
  cwd: string
  model: string
  sessionName: string | undefined
  thinking: string
  theme?: Theme
}

const LINE = '─'

function fitBorder(
  left: string,
  right: string,
  width: number,
  border: (text: string) => string,
  fill: (text: string) => string = border
): string {
  if (width <= 0) return ''
  if (width === 1) return border('─')

  let leftText = left
  let rightText = right
  const fixedWidth = 2
  const minimumGap = 3

  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(rightText) > 0
  ) {
    rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), '')
  }
  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(leftText) > 0
  ) {
    leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), '')
  }

  const gapWidth = Math.max(
    0,
    width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText)
  )
  return `${border('─')}${leftText}${fill('─'.repeat(gapWidth))}${rightText}${border('─')}`
}

class GitStatus {
  private static RESET = '\x1b[0m'
  private static COLORS: Record<string, [number, number, number]> = {
    white: [171, 178, 191],
    added: [82, 215, 93],
    deleted: [224, 108, 116],
    modified: [97, 175, 238],
    renamed: [198, 119, 220],
    committable: [86, 182, 194],
    unstaged: [228, 192, 122],
  }

  constructor(private sessionState: SessionState) {}

  private static customFg([r, g, b]: [number, number, number], text: string) {
    return `\x1b[38;2;${r};${g};${b}m${text}${GitStatus.RESET}`
  }

  private static async runGit(args: string[], cwd: string) {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
    })
    return stdout.trimEnd()
  }

  private static async directoryExists(path: string) {
    try {
      const stats = await stat(path)
      return stats.isDirectory()
    } catch {
      return false
    }
  }

  private static async getBranch(cwd: string) {
    const branch = await GitStatus.runGit(['branch', '--show-current'], cwd)
    if (branch.length > 0) return branch

    const head = await GitStatus.runGit(['rev-parse', '--short', 'HEAD'], cwd)
    return head.length > 0 ? `detached@${head}` : 'unknown'
  }

  private static async getStatusSummary(cwd: string) {
    const [status, localCommit, remoteCommit, commonBase] = await Promise.all([
      GitStatus.runGit(['status', '--porcelain'], cwd),
      GitStatus.runGit(['rev-parse', '@'], cwd),
      GitStatus.runGit(['rev-parse', '@{u}'], cwd),
      GitStatus.runGit(['merge-base', '@', '@{u}'], cwd),
    ])

    const [rebaseMerge, rebaseApply] = await Promise.all([
      GitStatus.runGit(['rev-parse', '--git-path', 'rebase-merge'], cwd),
      GitStatus.runGit(['rev-parse', '--git-path', 'rebase-apply'], cwd),
    ])

    const [isRebaseMerge, isRebaseApply] = await Promise.all([
      GitStatus.directoryExists(rebaseMerge),
      GitStatus.directoryExists(rebaseApply),
    ])

    return GitStatus.formatStatusSummary(status, {
      commonBase,
      isRebaseApply,
      isRebaseMerge,
      localCommit,
      remoteCommit,
    })
  }

  private static formatStatusSummary(
    statusOutput: string,
    gitState: {
      commonBase: string
      isRebaseApply: boolean
      isRebaseMerge: boolean
      localCommit: string
      remoteCommit: string
    }
  ) {
    let unstaged = 0
    let added = 0
    let deleted = 0
    let modified = 0
    let renamed = 0

    if (statusOutput.length > 0) {
      for (const line of statusOutput.split('\n')) {
        if (line.startsWith('??')) {
          unstaged += 1
          added += 1
          continue
        }

        const indexStatus = line[0]
        const worktreeStatus = line[1]

        if (indexStatus === ' ') unstaged += 1
        if (indexStatus === 'A') added += 1
        if (indexStatus === 'D' || worktreeStatus === 'D') deleted += 1
        if (indexStatus === 'M' || worktreeStatus === 'M') modified += 1
        if (indexStatus === 'R') renamed += 1
      }
    }

    const segments = []
    if (added > 0) segments.push(`${added}+`)
    if (deleted > 0) segments.push(`${deleted}-`)
    if (modified > 0) segments.push(`${modified}*`)
    if (renamed > 0) segments.push(`${renamed}>`)

    let remote: 'pull' | 'push' | 'both' | null = null
    const hasUpstream =
      !gitState.remoteCommit.includes('fatal:') &&
      !gitState.remoteCommit.includes('no upstream') &&
      !gitState.remoteCommit.includes('unknown revision') &&
      gitState.remoteCommit.length > 0

    if (hasUpstream && gitState.localCommit !== gitState.remoteCommit) {
      if (gitState.commonBase === gitState.remoteCommit) {
        remote = 'push'
      } else if (gitState.commonBase === gitState.localCommit) {
        remote = 'pull'
      } else {
        remote = 'both'
      }
    }

    const rebase = gitState.isRebaseMerge || gitState.isRebaseApply ? '\uE0A0' : null

    if (remote) segments.push(remote)
    if (rebase) segments.push(rebase)

    let committable: string | null = null
    if (statusOutput.length > 0) {
      committable = unstaged > 0 ? `${unstaged}⚡︎` : '✔'
      segments.push(committable)
    }

    return {
      added,
      committable,
      deleted,
      modified,
      remote,
      unstaged,
      rebase,
      renamed,
      summary: segments.join(' '),
    }
  }

  async getGitStatusLine({ cwd }: { cwd: string }): Promise<string> {
    await GitStatus.runGit(['rev-parse', '--is-inside-work-tree'], cwd)
    const [branch, statusSummary] = await Promise.all([
      GitStatus.getBranch(cwd),
      GitStatus.getStatusSummary(cwd),
    ])

    const added = GitStatus.customFg(
      GitStatus.COLORS.added,
      statusSummary.added ? ` ${statusSummary.added}+` : ''
    )
    const deleted = GitStatus.customFg(
      GitStatus.COLORS.deleted,
      statusSummary.deleted ? ` ${statusSummary.deleted}-` : ''
    )
    const modified = GitStatus.customFg(
      GitStatus.COLORS.modified,
      statusSummary.modified ? ` ${statusSummary.modified}*` : ''
    )
    const renamed = GitStatus.customFg(
      GitStatus.COLORS.renamed,
      statusSummary.renamed ? ` ${statusSummary.renamed}>` : ''
    )

    const committable = statusSummary.unstaged
      ? GitStatus.customFg(GitStatus.COLORS.unstaged, ` ${statusSummary.unstaged}⚡︎`)
      : GitStatus.customFg(GitStatus.COLORS.committable, ' ✔')

    let remote = ''
    switch (statusSummary.remote) {
      case 'push':
        remote = GitStatus.customFg(GitStatus.COLORS.white, ' ⇡')
        break
      case 'pull':
        remote = GitStatus.customFg(GitStatus.COLORS.white, ' ⇣')
        break
      case 'both':
        remote = GitStatus.customFg(GitStatus.COLORS.white, ' ⇣⇡')
        break
      default:
        remote = ''
    }
    const rebase = statusSummary.rebase
      ? GitStatus.customFg(GitStatus.COLORS.white, ` ${statusSummary.rebase}`)
      : ''

    return `${this.sessionState.theme?.fg('dim', `(${branch})`) ?? `(${branch})`}${added}${deleted}${modified}${renamed}${committable}${remote}${rebase}`
  }
}

class BorderStatusEditor extends CustomEditor {
  private gitStatusEditor: GitStatus

  private gitStatusLine = ''
  private REFRESH_INTERVAL_MS = 2_000

  private formatInputWithCommandHighlight(paddingX: number, input: string): string {
    const commandMatch = input.match(/\s\/([\w:-]+)(.*)$/)
    if (!commandMatch) return input

    const command = `${' '.repeat(paddingX)}/${commandMatch[1]}`
    const rest = commandMatch[2]
    const styledCommand = this.sessionState.theme?.fg('accent', command) ?? command
    return `${styledCommand}${rest}`
  }

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private sessionState: SessionState
  ) {
    super(tui, theme, keybindings)
    this.sessionState = sessionState

    this.gitStatusEditor = new GitStatus(sessionState)

    void this.refreshGitStatus()
    setInterval(() => {
      void this.refreshGitStatus()
    }, this.REFRESH_INTERVAL_MS)
  }

  refresh() {
    this.tui.requestRender()
  }

  private async refreshGitStatus() {
    try {
      const newLine = await this.gitStatusEditor.getGitStatusLine({ cwd: this.sessionState.cwd })

      if (newLine !== this.gitStatusLine) {
        this.gitStatusLine = newLine
        this.tui.requestRender()
      }
    } catch {
      if (this.gitStatusLine !== '') {
        this.gitStatusLine = ''
        this.tui.requestRender()
      }
    }
  }

  private formatCwd(cwd: string): string {
    const home = process.env.HOME
    if (home && cwd.startsWith(home)) {
      return `~${cwd.slice(home.length)}`
    }
    return cwd
  }

  render(width: number): string[] {
    const lines = super.render(width)
    if (lines.length < 2) return lines

    // Style input line with command highlight
    const inputLineIdx = lines.findIndex(line => !line.includes(LINE) && line.trim().length > 0)
    if (inputLineIdx >= 0 && inputLineIdx < lines.length) {
      lines[inputLineIdx] = this.formatInputWithCommandHighlight(
        this.getPaddingX(),
        lines[inputLineIdx]
      )
    }

    const topLeft = this.borderColor(
      ` ${this.sessionState.model}${this.sessionState.thinking !== 'off' ? ` · ${this.sessionState.thinking}` : ''} `
    )
    const bottomLeft = ''
    // const bottomLeft = this.sessionState.sessionName ? ` Session: ${this.sessionState.sessionName} ` : ''
    const topRight = this.gitStatusLine ? ` ${this.gitStatusLine} ` : ''
    const bottomRight =
      this.sessionState.theme?.fg('dim', ` ${this.formatCwd(this.sessionState.cwd)} `) ?? ''

    lines[0] = fitBorder(topLeft, topRight, width, this.borderColor)
    lines.splice(1, 0, '')
    lines.splice(
      lines.findLastIndex(line => line.includes(LINE)),
      0,
      ''
    )
    lines.splice(
      lines.findLastIndex(line => line.includes(LINE)),
      1,
      fitBorder(bottomLeft, bottomRight, width, this.borderColor)
    )
    return lines
  }
}

export default function (pi: ExtensionAPI) {
  const sessionState: SessionState = {
    cwd: process.cwd(),
    model: 'no model',
    sessionName: undefined,
    thinking: 'off',
    theme: undefined,
  }

  let editor: BorderStatusEditor | undefined

  pi.on('model_select', event => {
    sessionState.model = event.model.id
    editor?.refresh()
  })

  pi.on('thinking_level_select', event => {
    sessionState.thinking = event.level
    editor?.refresh()
  })

  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI) return
    sessionState.cwd = ctx.cwd
    sessionState.model = ctx.model?.id ?? 'no model'
    sessionState.sessionName = ctx.sessionManager.getSessionName()
    sessionState.thinking = pi.getThinkingLevel()
    sessionState.theme = ctx.ui.theme

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      if (editor) {
        editor.refresh()
        return editor
      }
      editor = new BorderStatusEditor(tui, theme, keybindings, sessionState)
      return editor
    })
  })

  pi.on('session_shutdown', (_event, ctx) => {
    if (!ctx.hasUI) return
    ctx.ui.setEditorComponent(undefined)
  })
}
