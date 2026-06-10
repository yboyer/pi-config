import type { Model } from '@earendil-works/pi-ai'
import type {
  ExtensionAPI,
  SessionStartEvent,
  SlashCommandInfo,
  Theme,
} from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

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

function colorText(text: string, rgb: Rgb): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[0m`
}

interface ShineConfig {
  pos: number
  strength: number
}

function gradientColor(t: number, shine?: ShineConfig): Rgb {
  const wrapped = ((t % 1) + 1) % 1
  const scaled = wrapped * (GRADIENT_STOPS.length - 1)
  const idx = Math.floor(scaled)
  const next = Math.min(idx + 1, GRADIENT_STOPS.length - 1)
  const blend = scaled - idx
  const a = GRADIENT_STOPS[idx]!
  const b = GRADIENT_STOPS[next]!
  let rv = Math.round(a[0] + (b[0] - a[0]) * blend)
  let gv = Math.round(a[1] + (b[1] - a[1]) * blend)
  let bv = Math.round(a[2] + (b[2] - a[2]) * blend)
  if (shine) {
    const intensity = Math.max(0, 1 - Math.abs(shine.pos - t) * 8) * shine.strength
    rv = Math.min(255, Math.round(rv + (255 - rv) * intensity))
    gv = Math.min(255, Math.round(gv + (255 - gv) * intensity))
    bv = Math.min(255, Math.round(bv + (255 - bv) * intensity))
  }
  return [rv, gv, bv]
}

function toGradient(lines: readonly string[], phase = 0, shine?: ShineConfig): string[] {
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
      result += colorText(char, gradientColor(t, shine))
    }
    return result
  })
}

class OverlayComponent {
  constructor(protected theme: Theme) {}

  protected BOX = {
    tl: '╭',
    tr: '╮',
    bl: '╰',
    br: '╯',
    h: '─',
    v: '│',
  }

  protected borderColor(text: string): string {
    return this.theme.fg('border', text)
  }

  protected box(
    lines: string[],
    width: number,
    title?: string,
    titlePosition: 'center' | 'left' = 'center'
  ): string[] {
    const innerW = Math.max(1, width - 2)
    const result: string[] = []

    const titleStr = title ? truncateToWidth(` ${title} `, innerW) : ''
    const titleW = visibleWidth(titleStr)
    const topLineBefore =
      titlePosition === 'center'
        ? this.BOX.h.repeat(Math.floor((innerW - titleW) / 2))
        : this.BOX.h.repeat(3)

    const topLineAfter = this.BOX.h.repeat(Math.max(0, innerW - titleW - topLineBefore.length))

    // Top border with optional title
    result.push(
      ' ' +
        this.borderColor(this.BOX.tl) +
        this.borderColor(topLineBefore) +
        this.theme.fg('muted', titleStr) +
        this.borderColor(topLineAfter) +
        this.borderColor(this.BOX.tr) +
        ' '
    )

    // Content lines
    for (const line of lines) {
      result.push(
        ' ' +
          this.borderColor(this.BOX.v) +
          truncateToWidth(line, innerW, '...', true) +
          this.borderColor(this.BOX.v) +
          ' '
      )
    }

    // Bottom border
    result.push(` ${this.borderColor(`${this.BOX.bl}${this.BOX.h.repeat(innerW)}${this.BOX.br}`)} `)

    return result
  }

  render(width: number): string[] {
    const th = this.theme
    return this.box(
      ['', ' Content', '', ` ${th.fg('dim', 'Esc/Enter = close')}`, ''],
      width,
      'Template'
    )
  }
}

class WelcomeCard extends OverlayComponent {
  private animStart: number | null = null
  private animTimer: ReturnType<typeof setInterval> | null = null
  private model: Pick<Model<'any'>, 'id' | 'provider'>
  private commands: SlashCommandInfo[]
  private projectName: string
  private sessionName?: string

  static maxWidth = 80

  // private PI_LOGO = [
  //   //
  //   '███████  ',
  //   '██   ██  ',
  //   '█████  ██',
  //   '██     ██',
  // ]
  private PI_LOGO = [
    //
    '███████████',
    '  ██  ██ π ',
    '  ██  ██   ',
    '  ▀▀  ██   ',
  ]

  private INTRO_MS = 3000
  private INTRO_TICK_MS = 33
  private INTRO_SWEEPS = 3
  private INTRO_SHINE_TRAVERSALS = 3
  private REST_FRAME = toGradient(this.PI_LOGO, 0)

  constructor({
    theme,
    model,
    commands,
    projectName,
    sessionName,
  }: {
    theme: Theme
    model: Pick<Model<'any'>, 'id' | 'provider'>
    commands: SlashCommandInfo[]
    projectName: string
    sessionName?: string
  }) {
    super(theme)
    this.model = model
    this.commands = commands
    this.projectName = projectName
    this.sessionName = sessionName
  }

  private currentLogoFrame(): string[] {
    if (this.animStart == null) return this.REST_FRAME
    const elapsed = performance.now() - this.animStart
    const progress = Math.min(elapsed / this.INTRO_MS, 1)
    const eased = 1 - Math.pow(1 - progress, 3)
    const shineStrength = (1 - eased) ** 1.5

    return toGradient(this.PI_LOGO, eased * this.INTRO_SWEEPS, {
      pos: (((progress * this.INTRO_SHINE_TRAVERSALS) % 1) + 1) % 1,
      strength: shineStrength,
    })
  }

  playIntro(requestRender: () => void): void {
    this.stopAnimation()
    this.animStart = performance.now()
    requestRender()
    this.animTimer = setInterval(() => {
      requestRender()
      if (performance.now() - (this.animStart ?? 0) >= this.INTRO_MS) this.stopAnimation()
    }, this.INTRO_TICK_MS)
  }

  private stopAnimation(): void {
    if (this.animTimer != null) {
      clearInterval(this.animTimer)
      this.animTimer = null
    }
    this.animStart = null
  }

  update(
    modelId: string,
    modelProvider: string,
    commands: SlashCommandInfo[],
    sessionName?: string
  ): void {
    this.model.id = modelId
    this.model.provider = modelProvider
    this.commands = commands
    this.sessionName = sessionName
  }

  private centerIn(text: string, width: number, rawLen?: number): string {
    const len = rawLen ?? visibleWidth(text)
    return len >= width ? text : ' '.repeat(Math.floor((width - len) / 2)) + text
  }

  render(termWidth: number): string[] {
    const boxWidth = Math.min(WelcomeCard.maxWidth, Math.max(0, termWidth - 2))
    if (boxWidth < 10) return []

    const tips = [
      {
        key: 'Ctrl+Z',
        description: 'Suspend to background',
        extra: '(fg to toggle back)',
      },
      {
        key: 'Option+Enter',
        description: 'Queue follow-up message',
      },
    ]

    const maxTipKeyLen = Math.max(
      ...tips.map(t => Math.max(...[t.key, t.description, t.extra ?? ''].map(s => s.length + 2)))
    )

    const logoRawWidth = Math.max(...this.PI_LOGO.map(l => l.length))
    const dualContent = boxWidth - 3
    const dualLeft = Math.floor(dualContent * 0.42)
    const dualRight = dualContent - dualLeft
    const showRight = dualLeft >= logoRawWidth + 4 && dualLeft >= maxTipKeyLen
    const leftCol = showRight ? dualLeft : boxWidth - 2
    const rightCol = showRight ? dualRight : 0

    const logoFrames = this.currentLogoFrame()

    const leftSeparator = ` ${this.borderColor(this.BOX.h.repeat(Math.max(0, leftCol - 2)))}`
    const rightSeparator = ` ${this.borderColor(this.BOX.h.repeat(Math.max(0, rightCol - 2)))}`

    // Left lines
    const leftLines: string[] = [
      '',
      ...logoFrames.map(l => this.centerIn(l, leftCol, logoRawWidth)),
      '',
      this.centerIn(this.theme.fg('muted', this.model.id), leftCol),
      this.centerIn(this.theme.fg('dim', this.model.provider), leftCol),
      '',
      leftSeparator,
      ...tips
        .flatMap(t => [
          '',
          this.centerIn(this.theme.fg('muted', t.key), leftCol),
          this.centerIn(this.theme.fg('dim', t.description), leftCol),
          t.extra ? this.centerIn(this.theme.fg('dim', t.extra), leftCol) : null,
        ])
        .filter(e => e !== null),
      '',
    ]

    const skills = this.commands.filter(c => c.source === 'skill')
    const extensions = this.commands.filter(c => c.source === 'extension')
    const prompts = this.commands.filter(c => c.source === 'prompt')

    // Right lines
    const rightLines: string[] = []

    const sections: {
      title: string
      elements: SlashCommandInfo[]
      limit?: number
      prefix?: string
    }[] = [
      {
        title: `Skills (${skills.length})`,
        elements: skills,
      },
      {
        title: `Extensions (${extensions.length})`,
        elements: extensions,
      },
      {
        title: `Prompts (${prompts.length})`,
        elements: prompts,
      },
    ]
    sections
      .filter(sectionData => sectionData.elements.length > 0)
      .flatMap((sectionData, i) => {
        const elements = sectionData.elements
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, sectionData.limit)

        return [
          i ? rightSeparator : null,
          ` ${this.theme.bold(colorText(sectionData.title, GRADIENT_STOPS[2]))}`,
          ...elements.map(c =>
            truncateToWidth(
              ` ${this.theme.fg('dim', sectionData.prefix ?? '/')}${this.theme.fg('muted', c.name)}`,
              rightCol
            )
          ),
        ].filter(e => e !== null)
      })
      .forEach(l => {
        rightLines.push(l)
      })

    if (!rightLines.length) rightLines.push(` ${this.theme.fg('dim', 'No commands loaded')}`)
    rightLines.push('')

    const lines: string[] = []

    const height = Math.max(leftLines.length, rightLines.length)
    for (let i = 0; i < height; i++) {
      const lRaw = leftLines[i] ?? ''
      const lPad = ' '.repeat(Math.max(0, leftCol - visibleWidth(lRaw)))
      if (showRight) {
        const rRaw = rightLines[i] ?? ''
        lines.push(`${lRaw}${lPad}${this.borderColor(this.BOX.v)}${rRaw}`)
      } else {
        lines.push(`${lRaw}${lPad}`)
      }
    }

    return this.box(
      lines,
      boxWidth,
      this.projectName + (this.sessionName ? ` - ${this.sessionName}` : ''),
      'left'
    )
  }
}

export default function (pi: ExtensionAPI) {
  let requestRender: (() => void) | undefined
  let card: WelcomeCard | undefined

  pi.on('session_start', async (event, ctx) => {
    if (!ctx.hasUI) return

    const allowedEvents: SessionStartEvent['reason'][] = ['reload', 'startup']
    const hasMessages = ctx.sessionManager.getEntries().filter(e => e.type === 'message').length > 0
    const isOverlay = allowedEvents.includes(event.reason) && hasMessages

    card = new WelcomeCard({
      theme: ctx.ui.theme,
      sessionName: ctx.sessionManager.getSessionName(),
      projectName: ctx.cwd.split('/').pop()!,
      model: {
        id: ctx.model?.id ?? 'no model selected',
        provider: ctx.model?.provider ?? '',
      },
      commands: pi.getCommands(),
    })

    if (isOverlay) {
      ctx.ui.custom(
        (tui, _theme, _kb, done) => {
          requestRender = () => tui.requestRender()
          card!.playIntro(requestRender)

          return {
            render: card!.render.bind(card),
            handleInput: done,
            invalidate: () => tui.requestRender(),
            dispose: () => {
              requestRender = undefined
            },
          }
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: 'center',
            width: WelcomeCard.maxWidth,
            margin: 2,
          },
        }
      )
    }

    ctx.ui.setHeader(tui => {
      requestRender = () => tui.requestRender()

      if (!isOverlay) {
        card!.playIntro(requestRender)
      }

      return {
        render(width) {
          return [
            // Add padding lines
            '',
            ...card!.render(width),
            '',
          ]
        },
        invalidate: () => tui.requestRender(),
        dispose: () => {
          requestRender = undefined
        },
      }
    })
  })

  pi.on('model_select', (event, ctx) => {
    card?.update(
      event.model.id,
      event.model.provider,
      pi.getCommands(),
      ctx.sessionManager.getSessionName()
    )
    requestRender?.()
  })

  pi.on('session_shutdown', (_event, ctx) => {
    requestRender = undefined
    if (ctx.hasUI) ctx.ui.setHeader(undefined)
  })
}
