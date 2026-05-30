import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'

const execFileAsync = promisify(execFile)
const STATUS_KEY = 'copilot-usage'
const REFRESH_INTERVAL_MS = 1 * 60 * 1000
const GH_ARGS = ['api', '/copilot_internal/user']

type PremiumInteractionsSnapshot = {
  overage_count?: number
  overage_permitted?: boolean
  percent_remaining?: number
  quota_id?: string
  quota_remaining?: number
  unlimited?: boolean
  timestamp_utc?: string
  has_quota?: boolean
  quota_reset_at?: number
  token_based_billing?: boolean
  remaining?: number
  entitlement?: number
}

type CopilotUserResponse = {
  login: string
  copilot_plan?: string
  quota_reset_date?: string
  quota_reset_date_utc?: string
  quota_snapshots?: {
    premium_interactions?: PremiumInteractionsSnapshot
  }
}

type UsageState = (
  | {
    type: 'error'
    error: string
  }
  | {
    account: string
    type: 'success'
    percentage: number
    used: number
    entitlement: number
  }
  | {
    type: 'loading'
  }
) & {
  details: string
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    maximumFractionDigits: 1,
  }).format(value)
}

function formatDate(value?: string): string {
  if (!value) return 'unknown'

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat('fr-FR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  }).format(date)
}

function buildUsageState(payload: CopilotUserResponse): UsageState {
  const snapshot = payload.quota_snapshots?.premium_interactions
  if (!snapshot) {
    return {
      type: 'error',
      error: 'unavailable',
      details: 'Missing `premium_interactions`',
    }
  }

  if (snapshot.unlimited) {
    return {
      account: payload.login,
      type: 'success',
      entitlement: Infinity,
      percentage: 0,
      used: 0,
      details: 'No monthly quota for `premium_interactions` plan.',
    }
  }

  const entitlement = Number(snapshot.entitlement ?? 0)
  const remaining = Number(snapshot.quota_remaining ?? snapshot.remaining ?? 0)
  const percentRemaining = Number(snapshot.percent_remaining ?? 0)
  const used = Math.floor(Math.max(0, entitlement - remaining))
  const percentUsed = Math.floor(Math.max(0, Math.min(100, 100 - percentRemaining)))
  const resetAt = formatDate(payload.quota_reset_date_utc ?? payload.quota_reset_date)
  const overage = snapshot.overage_permitted ? 'yes' : 'no'
  const plan = payload.copilot_plan ?? 'unknown'

  return {
    account: payload.login,
    type: 'success',
    percentage: percentUsed,
    used,
    entitlement,
    details: `Plan: ${plan} · remaining: ${formatNumber(remaining)} · reset: ${resetAt} · overage: ${overage}`,
  }
}

async function fetchUsage(): Promise<UsageState> {
  const { stdout } = await execFileAsync('gh', GH_ARGS, {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  })

  const payload = JSON.parse(stdout) as CopilotUserResponse
  return buildUsageState(payload)
}

function formatStatusText(theme: Theme, state: UsageState): string {
  const account = state.type === 'success' ? ` (${state.account})` : ''
  const prefix = theme.fg('dim', `Copilot${account}: `)

  if (state.type === 'error') {
    return `${prefix}${theme.fg('warning', state.error)}`
  }

  if (state.type === 'loading') {
    return `${prefix}${theme.fg('dim', 'loading…')}`
  }

  let percentageStr: string
  if (state.percentage >= 90) {
    percentageStr = theme.fg('error', '100%')
  } else if (state.percentage >= 70) {
    percentageStr = theme.fg('warning', `${formatNumber(state.percentage)}%`)
  } else {
    percentageStr = `${formatNumber(state.percentage)}%`
  }

  return theme.fg(
    'text',
    `${prefix}${percentageStr} ${theme.fg('dim', `(${formatNumber(state.used)}/${formatNumber(state.entitlement)})`)}`
  )
}

function setStatus(ctx: ExtensionContext, state: UsageState) {
  ctx.ui.setStatus(STATUS_KEY, formatStatusText(ctx.ui.theme, state))
}

export default function (pi: ExtensionAPI) {
  let interval: NodeJS.Timeout | undefined
  let refreshPromise: Promise<void> | undefined

  const refresh = async (ctx: ExtensionContext, notify = false) => {
    if (refreshPromise) return refreshPromise

    refreshPromise = (async () => {
      try {
        const usage = await fetchUsage()
        const theme = ctx.ui.theme

        setStatus(ctx, usage)
        if (notify)
          ctx.ui.notify(
            theme.fg('text', `${formatStatusText(theme, usage)} — ${usage.details}`),
            'info'
          )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setStatus(ctx, {
          type: 'error',
          error: 'error',
          details: `Copilot Fetch error: ${message}`,
        })
        if (notify) ctx.ui.notify(`Copilot Fetch error: ${message}`, 'error')
      }
    })()

    try {
      await refreshPromise
    } finally {
      refreshPromise = undefined
    }
  }

  pi.registerCommand('copilot-usage', {
    description: 'Refresh and display current usage of Copilot Premium requests',
    async handler(_args, ctx) {
      await refresh(ctx, true)
    },
  })

  pi.on('session_start', async (_event, ctx) => {
    setStatus(ctx, {
      type: 'loading',
      details: 'loading…',
    })
    await refresh(ctx, false)

    if (interval) clearInterval(interval)
    interval = setInterval(() => {
      void refresh(ctx, false)
    }, REFRESH_INTERVAL_MS)
  })

  pi.on('input', async (_event, ctx) => {
    await refresh(ctx)
  })

  pi.on('turn_end', async (_event, ctx) => {
    await refresh(ctx)
  })

  pi.on('session_shutdown', async () => {
    if (interval) {
      clearInterval(interval)
      interval = undefined
    }
  })
}
