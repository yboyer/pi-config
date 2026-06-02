import path from 'node:path'

import type { Model } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

type Rgb = [number, number, number]
const GRADIENT_STOPS: ReadonlyArray<Rgb> = [
  [255, 92, 200], // hot pink
  [200, 110, 255], // violet
  [120, 130, 255], // periwinkle
  [80, 200, 255], // cyan
  [200, 230, 255], // ice white
  [255, 190, 80], // amber
  [255, 130, 50], // orange
]

interface ShineConfig {
  pos: number
  strength: number
}

function gradientColor(t: number, shine?: ShineConfig): string {
  const wrapped = ((t % 1) + 1) % 1
  const scaled = wrapped * (GRADIENT_STOPS.length - 1)
  const idx = Math.floor(scaled)
  const next = Math.min(idx + 1, GRADIENT_STOPS.length - 1)
  const blend = scaled - idx
  const a = GRADIENT_STOPS[idx]!
  const b = GRADIENT_STOPS[next]!
  let r = Math.round(a[0] + (b[0] - a[0]) * blend)
  let g = Math.round(a[1] + (b[1] - a[1]) * blend)
  let bv = Math.round(a[2] + (b[2] - a[2]) * blend)
  if (shine) {
    const intensity = Math.max(0, 1 - Math.abs(shine.pos - t) * 8) * shine.strength
    r = Math.min(255, Math.round(r + (255 - r) * intensity))
    g = Math.min(255, Math.round(g + (255 - g) * intensity))
    bv = Math.min(255, Math.round(bv + (255 - bv) * intensity))
  }
  return `\x1b[38;2;${r};${g};${bv}m`
}

function gradientLogo(lines: readonly string[], phase = 0, shine?: ShineConfig): string[] {
  const rows = lines.length
  const span = Math.max(1, Math.max(...lines.map(l => l.length)) + rows - 1)
  return lines.map((line, y) => {
    let result = ''
    for (let x = 0; x < line.length; x++) {
      const char = line[x]!
      if (char === ' ') {
        result += char
        continue
      }
      const t = ((((x + (rows - 1 - y)) / span + phase) % 1) + 1) % 1
      result += gradientColor(t, shine) + char + RESET
    }
    return result
  })
}

const PI_LOGO = [
  '▀██████████▀',
  ' ╘██    ██  ',
  '  ██    ██  ',
  '  ██    ██  ',
  ' ▄██▄  ▄██▄ ',
] as const

const INTRO_MS = 3000
const INTRO_TICK_MS = 33
const INTRO_SWEEPS = 3
const INTRO_SHINE_TRAVERSALS = 3
const REST_FRAME = gradientLogo(PI_LOGO, 0)

const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }

const dim = (s: string) => `${DIM}${s}${RESET}`
const bold = (s: string) => `${BOLD}${s}${RESET}`
const muted = (s: string) => `\x1b[38;2;160;170;185m${s}${RESET}`
const accent = (s: string) => `\x1b[38;2;120;130;255m${s}${RESET}`
const subtle = (s: string) => `\x1b[38;2;90;100;120m${s}${RESET}`

function centerIn(text: string, width: number, rawLen?: number): string {
  const len = rawLen ?? visibleWidth(text)
  return len >= width ? text : ' '.repeat(Math.floor((width - len) / 2)) + text
}

const projectName = () => path.basename(process.cwd()) || 'session'

type Command = { name: string; description?: string; source: string }

class WelcomeCard {
  #animStart: number | null = null
  #animTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private modelId: string,
    private modelProvider: string,
    private commands: Command[]
  ) {}

  #currentLogoFrame(): string[] {
    if (this.#animStart == null) return REST_FRAME
    const elapsed = performance.now() - this.#animStart
    const progress = Math.min(elapsed / INTRO_MS, 1)
    const eased = 1 - Math.pow(1 - progress, 3)
    const shineStrength = (1 - eased) ** 1.5
    return gradientLogo(PI_LOGO, eased * INTRO_SWEEPS, {
      pos: (((progress * INTRO_SHINE_TRAVERSALS) % 1) + 1) % 1,
      strength: shineStrength,
    })
  }

  playIntro(requestRender: () => void): void {
    this.#stopAnimation()
    this.#animStart = performance.now()
    requestRender()
    this.#animTimer = setInterval(() => {
      requestRender()
      if (performance.now() - (this.#animStart ?? 0) >= INTRO_MS) this.#stopAnimation()
    }, INTRO_TICK_MS)
  }

  #stopAnimation(): void {
    if (this.#animTimer != null) {
      clearInterval(this.#animTimer)
      this.#animTimer = null
    }
    this.#animStart = null
  }

  update(modelId: string, modelProvider: string, commands: Command[]): void {
    this.modelId = modelId
    this.modelProvider = modelProvider
    this.commands = commands
  }

  render(termWidth: number): string[] {
    const boxWidth = Math.min(100, Math.max(0, termWidth - 2))
    if (boxWidth < 10) return []

    const logoRawWidth = Math.max(...PI_LOGO.map(l => l.length))
    const dualContent = boxWidth - 3
    const dualLeft = Math.floor(dualContent * 0.42)
    const dualRight = dualContent - dualLeft
    const showRight = dualLeft >= logoRawWidth + 4 && dualRight >= 24
    const leftCol = showRight ? dualLeft : boxWidth - 2
    const rightCol = showRight ? dualRight : 0

    const logoFrames = this.#currentLogoFrame()

    const leftSeparator = ` ${subtle(BOX.h.repeat(Math.max(0, leftCol - 2)))}`
    const rightSeparator = ` ${subtle(BOX.h.repeat(Math.max(0, rightCol - 2)))}`

    const leftLines: string[] = [
      '',
      ...logoFrames.map(l => centerIn(l, leftCol, logoRawWidth)),
      '',
      centerIn(muted(this.modelId), leftCol),
      centerIn(subtle(this.modelProvider), leftCol),
      '',
      leftSeparator,
      centerIn(dim('Ctrl+Z'), leftCol),
      centerIn(subtle('Suspend to background'), leftCol),
      centerIn(subtle('(fg to toggle back)'), leftCol),
      '',
      centerIn(dim('Option+Enter'), leftCol),
      centerIn(subtle('Queue follow-up message'), leftCol),
    ]

    const skills = this.commands
      .filter(c => c.source === 'skill')
      .sort((a, b) => a.name.localeCompare(b.name))
    const extensions = this.commands
      .filter(c => c.source === 'extension')
      .sort((a, b) => a.name.localeCompare(b.name))
    const prompts = this.commands
      .filter(c => c.source === 'prompt')
      .sort((a, b) => a.name.localeCompare(b.name))

    const rightLines: string[] = []
    const section = (label: string, prefix: string, items: Command[], limit = Infinity) => {
      if (!items.length) return
      if (rightLines.length > 0) rightLines.push(rightSeparator)
      rightLines.push(` ${bold(accent(label))}`)
      for (const c of items.slice(0, limit))
        rightLines.push(truncateToWidth(` ${dim(prefix)}${muted(c.name)}`, rightCol))
    }
    section(`Skills (${skills.length})`, '/', skills)
    section(`Extensions (${extensions.length})`, '/', extensions, 4)
    section(`Prompts (${prompts.length})`, '/', prompts, 4)
    if (!rightLines.length) rightLines.push(` ${subtle('No commands loaded')}`)
    rightLines.push('')

    const v = subtle(BOX.v)
    const lines: string[] = []

    const title = ` ${projectName()} `
    const prefix = BOX.h.repeat(3)
    const titleVisLen = prefix.length + title.length
    lines.push(
      subtle(BOX.tl) +
        subtle(prefix) +
        muted(title) +
        subtle(BOX.h.repeat(Math.max(0, boxWidth - 2 - titleVisLen))) +
        subtle(BOX.tr)
    )

    const height = Math.max(leftLines.length, rightLines.length)
    for (let i = 0; i < height; i++) {
      const lRaw = leftLines[i] ?? ''
      const lPad = ' '.repeat(Math.max(0, leftCol - visibleWidth(lRaw)))
      if (showRight) {
        const rRaw = rightLines[i] ?? ''
        const rPad = ' '.repeat(Math.max(0, rightCol - visibleWidth(rRaw)))
        lines.push(`${v}${lRaw}${lPad}${v}${rRaw}${rPad}${v}`)
      } else {
        lines.push(`${v}${lRaw}${lPad}${v}`)
      }
    }

    lines.push(subtle(BOX.bl) + subtle(BOX.h.repeat(boxWidth - 2)) + subtle(BOX.br))
    return lines
  }
}

export default function (pi: ExtensionAPI) {
  let requestRender: (() => void) | undefined
  let currentModelId = 'no model selected'
  const model: Pick<Model<'custom'>, 'id' | 'provider'> = {
    id: 'no model selected',
    provider: '',
  }
  let card: WelcomeCard | undefined

  function installHeader(ctx: ExtensionContext) {
    card = new WelcomeCard(model.id, model.provider, pi.getCommands())
    ctx.ui.setHeader(tui => {
      requestRender = () => tui.requestRender()
      card!.playIntro(requestRender)
      return {
        render: (width: number) => {
          card!.update(currentModelId, model.provider, pi.getCommands())
          return card!.render(width)
        },
        invalidate: () => tui.requestRender(),
      }
    })
  }

  pi.on('session_start', (_event, ctx) => {
    currentModelId = ctx.model?.id ?? 'no model selected'
    model.id = ctx.model?.id ?? model.id
    model.provider = ctx.model?.provider ?? model.provider
    if (ctx.hasUI) installHeader(ctx)
  })

  pi.on('model_select', event => {
    currentModelId = event.model.id
    model.id = event.model.id
    model.provider = event.model.provider
    requestRender?.()
  })

  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setHeader(undefined)
  })
}
