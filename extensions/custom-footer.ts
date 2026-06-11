import { stripVTControlCharacters } from 'node:util'

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}

function sanitizeStatusText(text: string): string {
  return (
    stripVTControlCharacters(text)
      .replace(/[\r\n\t\f\v]+/g, ' ')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: needed
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

function removeColorCodes(text: string): string {
  // ANSI color codes are of the form \x1b[...m
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Removes ANSI color
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME
  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`
  }
  return cwd
}

export default function (pi: ExtensionAPI) {
  function installFooter(ctx: ExtensionContext) {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender())

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          const extensionStatuses = footerData.getExtensionStatuses()
          const extensionStatusesClone = new Map(extensionStatuses) // Clone to avoid mutating original
          extensionStatusesClone.forEach((value, key) => {
            // Sanitize status text to prevent control characters from breaking the footer layout
            const sanitized = sanitizeStatusText(value)
            extensionStatusesClone.set(key, sanitized)
          })

          // Compute tokens from ctx (already accessible to extensions)
          let totalInput = 0
          let totalOutput = 0
          let totalCost = 0
          let totalCacheRead = 0
          let totalCacheWrite = 0
          for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === 'message' && entry.message.role === 'assistant') {
              const m = entry.message
              totalInput += m.usage.input
              totalOutput += m.usage.output
              totalCacheRead += m.usage.cacheRead
              totalCacheWrite += m.usage.cacheWrite
              totalCost += m.usage.cost.total
            }
          }

          // Build stats line
          const statsParts = []
          statsParts.push(`↑${formatTokens(totalInput)}`)
          statsParts.push(`↓${formatTokens(totalOutput)}`)
          statsParts.push(`R${formatTokens(totalCacheRead)}`)
          statsParts.push(`W${formatTokens(totalCacheWrite)}`)

          // Show cost with "(sub)" indicator if using OAuth subscription
          const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false
          if (totalCost || usingSubscription) {
            statsParts.push('•')
            const costStr = `$${totalCost.toFixed(3)}`
            statsParts.push(costStr)
          }

          if (ctx.model?.provider === 'github-copilot') {
            statsParts.push('•')
            statsParts.push(extensionStatusesClone.get('copilot-usage') ?? '')
            extensionStatusesClone.delete('copilot-usage') // Remove from extension statuses to avoid duplication in the extension status line
          }

          let statsLeft = statsParts.join(' ')

          let statsLeftWidth = visibleWidth(statsLeft)

          // If statsLeft is too wide, truncate it
          if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, '...')
            statsLeftWidth = visibleWidth(statsLeft)
          }

          // Calculate available space for padding (minimum 2 spaces between stats and model)
          const minPadding = 2

          const rightSide = ''

          const rightSideWidth = visibleWidth(rightSide)
          const totalNeeded = statsLeftWidth + minPadding + rightSideWidth

          let statsLine: string
          if (totalNeeded <= width) {
            // Both fit - add padding to right-align model
            const padding = ' '.repeat(width - statsLeftWidth - rightSideWidth)
            statsLine = statsLeft + padding + rightSide
          } else {
            // Need to truncate right side
            const availableForRight = width - statsLeftWidth - minPadding
            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(rightSide, availableForRight, '')
              const truncatedRightWidth = visibleWidth(truncatedRight)
              const padding = ' '.repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth))
              statsLine = statsLeft + padding + truncatedRight
            } else {
              // Not enough space for right side at all
              statsLine = statsLeft
            }
          }

          // Apply dim to each part separately. statsLeft may contain color codes (for context %)
          // that end with a reset, which would clear an outer dim wrapper. So we dim the parts
          // before and after the colored section independently.
          const dimStatsLeft = theme.fg('dim', statsLeft)
          const remainder = statsLine.slice(statsLeft.length) // padding + rightSide
          const dimRemainder = theme.fg('dim', remainder)

          const lines = [dimStatsLeft + dimRemainder]

          const bottomLines: string[] = []
          // bottomLines.push(theme.fg('muted', formatCwd(ctx.sessionManager.getCwd())))
          if (extensionStatusesClone.has('yboyer-git-status')) {
            // bottomLines[0] += ` ${extensionStatusesClone.get('yboyer-git-status')!}`
            extensionStatusesClone.delete('yboyer-git-status')
          }

          // Add extension statuses on a single line, sorted by key alphabetically
          if (extensionStatusesClone.size > 0) {
            const sortedStatuses = Array.from(extensionStatusesClone.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, text]) => {
                const cleanText = removeColorCodes(text)
                // Dim git status to differentiate from core stats, but keep accent color for branch name if present
                if (key === 'mcp') {
                  return theme.fg('border', cleanText)
                }
                return theme.fg('dim', cleanText)
              })
              .map(sanitizeStatusText)
              .filter(text => text.trim().length > 0)
            const statusLine = sortedStatuses.join(' ')

            if (statusLine.length > 0) {
              // Truncate to terminal width with dim ellipsis for consistency with footer style
              lines.push(truncateToWidth(statusLine, width, theme.fg('dim', '...')))
            }
          }

          return [...lines, ...bottomLines]
        },
      }
    })
  }

  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI) return
    installFooter(ctx)
  })

  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setFooter(undefined)
  })
}
