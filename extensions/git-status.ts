import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'

import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'

const execFileAsync = promisify(execFile)
const WIDGET_ID = 'yboyer-git-status'
const REFRESH_INTERVAL_MS = 2_000

type SessionState = {
  theme?: Theme
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

export default function (pi: ExtensionAPI) {
  const sessionState: SessionState = {}
  const gitStatus = new GitStatus(sessionState)
  let interval: NodeJS.Timeout | undefined

  async function refresh(ctx: ExtensionContext) {
    if (!ctx.hasUI) return

    try {
      sessionState.theme = ctx.ui.theme

      const line = await gitStatus.getGitStatusLine({ cwd: ctx.cwd })
      ctx.ui.setStatus(WIDGET_ID, line)
    } catch {
      ctx.ui.setStatus(WIDGET_ID, undefined)
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    if (interval) clearInterval(interval)

    await refresh(ctx)
    interval = setInterval(() => {
      void refresh(ctx)
    }, REFRESH_INTERVAL_MS)
  })

  pi.on('input', async (_event, ctx) => {
    await refresh(ctx)
  })

  pi.on('tool_execution_end', async (_event, ctx) => {
    await refresh(ctx)
  })

  pi.on('session_shutdown', async () => {
    if (interval) {
      clearInterval(interval)
      interval = undefined
    }
  })
}
