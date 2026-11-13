/// <reference types="node" />
import { readFileSync } from 'node:fs'
import tw from '../../tailwind.config.js?raw'
import { describe, expect, it } from 'vitest'
import { INVITE_STATUS_STYLES } from '../constants/invites'
import { AGING_STAGE_CLASSES, staleBadgeToneClass, urgencyBadgeToneClass } from '../utils/agingTint'
import { CHOICE_COLORS } from '../constants/choiceColors'
import { HEALTH_STATUS_STYLES, HEALTH_STATUS_TEXT } from '../constants/healthStatus'

// #1550: every on-tint text token must be declared in both theme blocks of index.css and exposed
// to Tailwind. Read from disk: Vitest stubs CSS imports (`?raw` on a .css file comes back empty).
const css = readFileSync('src/index.css', 'utf8')
const darkBlock = css.slice(css.indexOf(':root,'), css.indexOf('[data-theme="light"] {'))
const lightBlock = css.slice(css.indexOf('[data-theme="light"] {'))
const tokens = ['danger', 'warning', 'success', 'info', 'muted', 'urgent']

describe('on-tint text tokens', () => {
  it.each(tokens)('%s-on-tint is declared in both the dark and light theme blocks', (t) => {
    expect(darkBlock).toContain(`--${t}-on-tint:`)
    expect(lightBlock).toContain(`--${t}-on-tint:`)
    if (t === 'urgent') {
      expect(darkBlock).toContain('--urgent:')
      expect(lightBlock).toContain('--urgent:')
    }
  })

  it.each(tokens)('%s-on-tint is exposed in the tailwind config', (t) => {
    expect(tw).toContain(`"${t}-on-tint": "rgb(var(--${t}-on-tint) / <alpha-value>)"`)
  })
})

describe('INVITE_STATUS_STYLES', () => {
  it('uses on-tint text and never a high-alpha same-hue fill', () => {
    expect(INVITE_STATUS_STYLES.pending).toBe('bg-success/20 text-success-on-tint')
    expect(INVITE_STATUS_STYLES.expired).toBe('bg-danger/20 text-danger-on-tint')
    expect(INVITE_STATUS_STYLES.revoked).toContain('line-through')
    expect(INVITE_STATUS_STYLES.used).not.toContain('line-through')
    for (const cls of Object.values(INVITE_STATUS_STYLES)) expect(cls).not.toMatch(/\/(40|50|60)/)
  })
})

// #1594: pin the contrast claimed in index.css / CLAUDE.md for the urgent pair on its /20 fill.
const rgbOf = (block: string, name: string): number[] => {
  const line = block.split('\n').find((l) => l.trim().startsWith(`--${name}:`))
  if (!line) throw new Error(`--${name} missing`)
  return line.slice(line.indexOf(':') + 1).split(';')[0].trim().split(/\s+/).map(Number)
}
const lum = (c: number[]) => {
  const [r, g, b] = c.map((v) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('urgent-on-tint contrast (#1594)', () => {
  it.each([
    ['dark', darkBlock, 9.4],
    ['light', lightBlock, 6.7],
  ])('%s theme: text holds >= 4.5:1 on the /20 fill over surface and sunken', (_n, block, pinned) => {
    const fill = rgbOf(block, 'urgent')
    const text = rgbOf(block, 'urgent-on-tint')
    for (const surf of ['surface', 'surface-sunken']) {
      const bg = rgbOf(block, surf)
      const tint = fill.map((v, i) => 0.2 * v + 0.8 * bg[i])
      const r = ratio(text, tint)
      expect(r).toBeGreaterThanOrEqual(4.5)
      expect(r).toBeGreaterThanOrEqual(pinned)
    }
  })
})

// #2046: CLAUDE.md § System signals puts `text-warning-on-tint` / `text-danger-on-tint` on untinted
// card surfaces, because plain `warning` (orange-600) is 3.56:1 on white (#2029). Pin the claimed ratios.
describe('system-signal on-tint text on untinted surfaces (#2046)', () => {
  it.each([
    ['dark', 'warning-on-tint', darkBlock, 8.6],
    ['dark', 'danger-on-tint', darkBlock, 7.7],
    ['light', 'warning-on-tint', lightBlock, 6.9],
    ['light', 'danger-on-tint', lightBlock, 7.9],
  ])('%s theme: %s holds the documented ratio on surface and surface-sunken', (_theme, name, block, pinned) => {
    const text = rgbOf(block, name)
    for (const surf of ['surface', 'surface-sunken']) {
      const r = ratio(text, rgbOf(block, surf))
      expect(r).toBeGreaterThanOrEqual(4.5)
      expect(r).toBeGreaterThanOrEqual(pinned)
    }
  })
})

// #2060: toast titles use success-on-tint / info-on-tint on bg-surface and on the info shell
// (bg-primary/15 over bg-surface). Pin the ratios recorded in frontend/CLAUDE.md § Color tokens.
describe('toast on-tint text (#2060)', () => {
  it.each([
    ['dark', 'success-on-tint', darkBlock, 10.4, 9.1],
    ['dark', 'info-on-tint', darkBlock, 8.1, 7.0],
    ['light', 'success-on-tint', lightBlock, 7.1, 5.7],
    ['light', 'info-on-tint', lightBlock, 8.7, 7.0],
  ])('%s theme: %s holds AA on surface and on the primary/15 shell', (_theme, name, block, onSurface, onShell) => {
    const text = rgbOf(block, name)
    const surface = rgbOf(block, 'surface')
    const shell = rgbOf(block, 'primary').map((v, i) => 0.15 * v + 0.85 * surface[i])
    expect(ratio(text, surface)).toBeGreaterThanOrEqual(onSurface)
    expect(ratio(text, shell)).toBeGreaterThanOrEqual(onShell)
    expect(Math.min(ratio(text, surface), ratio(text, shell))).toBeGreaterThanOrEqual(4.5)
  })
})

// Hue, alpha and opacity are parsed from the real stage classes, so changing a
// stage's fill or opacity re-runs these checks against the new values.
const parse = (stage: keyof typeof AGING_STAGE_CLASSES) => {
  const { overlayClass, bodyOpacityClass } = AGING_STAGE_CLASSES[stage]
  const fill = /\bbg-([a-z-]+)\/(\d+)\b/.exec(overlayClass ?? '')
  const op = /^opacity-(\d+)$/.exec(bodyOpacityClass)
  if (!fill || !op) throw new Error(`unparseable classes for ${stage}`)
  return { hue: fill[1], alpha: Number(fill[2]) / 100, opacity: Number(op[1]) / 100 }
}
const blend = (top: number[], bottom: number[], a: number) => top.map((v, i) => a * v + (1 - a) * bottom[i])

// #1841: pin the card aging ramp contrast recorded in frontend/CLAUDE.md § Card aging ramp.
// The overlay is `bg-<hue>/<alpha>` over the card's bg-surface; the card body (title and
// urgency badge) renders at the stage's opacity, so its effective color is the text blended
// toward that composite. Each stage lists the text tokens that may sit on it.
describe('card aging ramp contrast (#1841)', () => {
  type Stage = [name: string, hue: string, alpha: number, opacity: number, texts: string[]]
  const withTexts = (stage: 'warning' | 'stale' | 'stale2x' | 'stale3x', texts: string[]): Stage => {
    const { hue, alpha, opacity } = parse(stage)
    return [stage, hue, alpha, opacity, texts]
  }
  const stages: Stage[] = [
    withTexts('warning', ['fg', 'warning-on-tint', 'danger-on-tint', 'info-on-tint']),
    withTexts('stale', ['fg', 'warning-on-tint', 'danger-on-tint', 'info-on-tint']),
    withTexts('stale2x', ['fg', 'danger-on-tint', 'info-on-tint']),
    withTexts('stale3x', ['fg', 'danger-on-tint', 'info-on-tint']),
  ]

  it.each(stages)('%s: card title and badge text hold >= 4.5:1 in both themes', (_n, hue, alpha, opacity, texts) => {
    for (const block of [darkBlock, lightBlock]) {
      const tint = blend(rgbOf(block, hue), rgbOf(block, 'surface'), alpha)
      for (const t of texts) {
        expect(ratio(blend(rgbOf(block, t), tint, opacity), tint)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('amber warning-on-tint is sub-AA on the red stages, which is why due-soon moves to danger-on-tint there', () => {
    const { hue, alpha, opacity } = parse('stale3x')
    const tint = blend(rgbOf(lightBlock, hue), rgbOf(lightBlock, 'surface'), alpha)
    expect(ratio(blend(rgbOf(lightBlock, 'warning-on-tint'), tint, opacity), tint)).toBeLessThan(4.5)
  })

  it.each([
    ['dark', darkBlock, 3.2],
    ['light', lightBlock, 6.9],
  ])('%s theme: the 3x inset ring holds >= 3:1 against its own fill', (_n, block, pinned) => {
    const sev = rgbOf(block, 'stale-severe')
    const r = ratio(sev, blend(sev, rgbOf(block, 'surface'), parse('stale3x').alpha))
    expect(r).toBeGreaterThanOrEqual(3)
    expect(r).toBeGreaterThanOrEqual(pinned)
  })

  // #1863: the warning stage's AgingCue is a hollow bar in text-warning-on-tint inside the
  // opacity-90 card body. A non-text graphic needs 3:1; pin the recorded 6.25 / 5.53.
  it.each([
    ['dark', darkBlock, 6.25],
    ['light', lightBlock, 5.53],
  ])('%s theme: the warning-stage hollow-bar cue holds >= 3:1 on its tint', (_n, block, pinned) => {
    const { hue, alpha, opacity } = parse('warning')
    const tint = blend(rgbOf(block, hue), rgbOf(block, 'surface'), alpha)
    const r = ratio(blend(rgbOf(block, 'warning-on-tint'), tint, opacity), tint)
    expect(r).toBeGreaterThanOrEqual(3)
    expect(r).toBeCloseTo(pinned, 2)
  })

  it('stale-severe is declared in both themes and exposed to tailwind', () => {
    expect(darkBlock).toContain('--stale-severe:')
    expect(lightBlock).toContain('--stale-severe:')
    expect(tw).toContain('"stale-severe": "rgb(var(--stale-severe) / <alpha-value>)"')
  })
})


// CardItem plus every component it mounts inside the metadata row (nested ones included:
// MultiSelectChips mounts ChoiceValue). The #1844 import guard below keeps this list complete.
const CARD_FACE_FILES = ['CardItem', 'CustomFieldLink', 'MultiSelectChips', 'ChoiceValue', 'ExternalRefGlyph', 'AgingCue', 'UrgencyGlyph', 'ThresholdMark']
// `text-<x>` utilities that are not a color: size, alignment, wrap and overflow.
const NOT_COLOR = new Set([
  'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl',
  'left', 'center', 'right', 'justify', 'start', 'end',
  'ellipsis', 'clip', 'wrap', 'nowrap', 'balance', 'pretty',
])
const TEXT_UTILITY = /\btext-(\[[^\]]*\]|[a-z0-9][a-z0-9-]*)(\/\d+)?/g

// #1844: metadata text on a tinted card face. CardItem puts AGING_STAGE_CLASSES[stage].metaClass
// (`card-aging-meta`) on the metadata row; index.css rescopes the row's text tokens to on-tint values
// there. Everything below is derived from the real CSS and stage classes, and the ratios are the ones
// recorded in frontend/CLAUDE.md § Card aging ramp.
describe('card metadata on an aging tint (#1844)', () => {
  const scopeStart = css.indexOf('.card-aging-meta {')
  const scope = css.slice(scopeStart, css.indexOf('}', scopeStart))
  const remap: Record<string, string> = Object.fromEntries(
    [...scope.matchAll(/--([a-z-]+):\s*var\(--([a-z-]+)\);/g)].map((m) => [m[1], m[2]]),
  )
  const resolve = (block: string, token: string) => rgbOf(block, remap[token] ?? token)
  // Every plain text token the metadata row renders, in CardItem and in the child components it
  // mounts there (CustomFieldLink, MultiSelectChips). The source scan below keeps this list honest.
  const META = ['fg-secondary', 'fg-tertiary', 'fg-muted', 'fg-faint', 'info', 'danger', 'success']
  const TINTED = ['warning', 'stale', 'stale2x', 'stale3x'] as const
  // Sibling components CardItem imports that never render inside the row: they are portaled.
  const PORTALED = ['CardPeekPopover', 'CustomFieldQuickEditPopover', 'CardContextMenu'] // CardContextMenu: type-only import in CardItem; the menu itself is portaled (#2059)
  const themes = [
    ['dark', darkBlock],
    ['light', lightBlock],
  ] as const
  // Pinned floor per stage: the lowest ratio among META after the rescope.
  const floors: Record<(typeof TINTED)[number], [dark: number, light: number]> = {
    warning: [5.59, 6.41],
    stale: [4.78, 5.27],
    stale2x: [4.97, 5.06],
    stale3x: [5.08, 4.55],
  }
  const metaRatio = (block: string, stage: (typeof TINTED)[number], color: number[]) => {
    const { hue, alpha, opacity } = parse(stage)
    const tint = blend(rgbOf(block, hue), rgbOf(block, 'surface'), alpha)
    return ratio(blend(color, tint, opacity), tint)
  }

  it('rescopes exactly the metadata text tokens that fall below 4.5:1 on a tint', () => {
    expect(scopeStart).toBeGreaterThan(-1)
    expect(remap).toEqual({
      'fg-tertiary': 'muted-on-tint',
      'fg-muted': 'muted-on-tint',
      'fg-faint': 'muted-on-tint',
      info: 'info-on-tint',
      danger: 'danger-on-tint',
      success: 'success-on-aging-tint',
    })
  })

  it('success-on-aging-tint is declared in both theme blocks and kept out of tailwind', () => {
    expect(darkBlock).toContain('--success-on-aging-tint:')
    expect(lightBlock).toContain('--success-on-aging-tint:')
    expect(tw).not.toContain('success-on-aging-tint')
  })

  // fg-secondary is not rescoped; frontend/CLAUDE.md says it currently renders the same tone as
  // muted-on-tint. If either token moves, this fails and the doc sentence must be revisited.
  it('fg-secondary currently equals muted-on-tint in both themes', () => {
    for (const [, block] of themes) expect(rgbOf(block, 'fg-secondary')).toEqual(rgbOf(block, 'muted-on-tint'))
  })

  it.each(TINTED.flatMap((st) => themes.map(([n, b], i) => [st, n, b, i] as const)))(
    '%s, %s theme: every metadata text token holds >= 4.5:1',
    (stage, _n, block, i) => {
      const worst = Math.min(...META.map((t) => metaRatio(block, stage, resolve(block, t))))
      expect(worst).toBeGreaterThanOrEqual(4.5)
      expect(worst).toBeGreaterThanOrEqual(floors[stage][i] - 0.005)
    },
  )

  it('without the rescope every remapped token is sub-AA on at least one stage, in each theme it fails', () => {
    for (const t of Object.keys(remap)) {
      const worst = Math.min(...themes.flatMap(([, b]) => TINTED.map((st) => metaRatio(b, st, rgbOf(b, t)))))
      expect(worst, t).toBeLessThan(4.5)
    }
    // The ratios the issue reported for fg-tertiary at the 3x stage.
    expect(metaRatio(darkBlock, 'stale3x', rgbOf(darkBlock, 'fg-tertiary'))).toBeCloseTo(3.85, 2)
    expect(metaRatio(lightBlock, 'stale3x', rgbOf(lightBlock, 'fg-tertiary'))).toBeCloseTo(3.88, 2)
  })

  // Still true of the token (#1862 changed the card face, not the token): this is why the row's
  // untinted text moved to fg-tertiary rather than the tint being retuned.
  it('fg-muted is already sub-AA on an untinted dark card, so no overlay or opacity tuning could fix it', () => {
    expect(ratio(rgbOf(darkBlock, 'fg-muted'), rgbOf(darkBlock, 'surface'))).toBeCloseTo(3.07, 2)
  })

  it('choice badges and multi-select chips keep >= 4.5:1 under the stage opacity', () => {
    const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
    for (const stage of TINTED) {
      const { hue, alpha, opacity } = parse(stage)
      for (const [n, block] of themes) {
        const tint = blend(rgbOf(block, hue), rgbOf(block, 'surface'), alpha)
        const onTint = (fg: number[], bg: number[]) => ratio(blend(fg, tint, opacity), blend(bg, tint, opacity))
        for (const [key, spec] of Object.entries(CHOICE_COLORS)) {
          const pair = spec[n]
          expect(onTint(hex(pair.fg), hex(pair.bg)), `${stage} ${n} ${key}`).toBeGreaterThanOrEqual(4.5)
        }
        // MultiSelectChips: bg-surface-hover text-fg-secondary (fg-secondary is not rescoped).
        expect(onTint(resolve(block, 'fg-secondary'), rgbOf(block, 'surface-hover'))).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('every sibling component CardItem and the row components import is scanned or portaled', () => {
    for (const f of CARD_FACE_FILES) {
      const src = readFileSync(`src/components/Card/${f}.tsx`, 'utf8')
      for (const m of src.matchAll(/from "\.\/([A-Za-z]+)"/g)) {
        expect(CARD_FACE_FILES.includes(m[1]) || PORTALED.includes(m[1]), `${f}.tsx imports ./${m[1]}`).toBe(true)
      }
    }
  })

  // A new metadata element in a color outside META (for example plain `text-warning` or
  // `text-primary-soft`) would not be rescoped, so it fails here until it is either rescoped or listed
  // with a reason. Every `text-<x>` utility is checked except size, alignment, wrap and overflow ones,
  // and an opacity modifier (`text-fg-muted/60`) on any text color is rejected: the pinned ratios
  // assume full-opacity text.
  it('every text color on the card face is covered by the rescope or listed with a reason', () => {
    const allowed = new Set([
      ...META,
      'fg', // card title and the aging tooltip (bg-sunken); pinned in the #1841 ramp test above
      'on-primary', // selection checkbox tick on its solid bg-primary-emphasis fill, outside the metadata row
    ])
    for (const f of CARD_FACE_FILES) {
      const src = readFileSync(`src/components/Card/${f}.tsx`, 'utf8')
      for (const m of src.matchAll(TEXT_UTILITY)) {
        const [whole, name, alpha] = m
        if (NOT_COLOR.has(name)) continue
        expect(alpha, `${f}.tsx uses ${whole}: no opacity modifier on card-face text`).toBeUndefined()
        if (name.endsWith('-on-tint')) continue // explicit on-tint token, as the urgency badge uses
        expect(allowed.has(name), `${f}.tsx uses ${whole}`).toBe(true)
      }
    }
  })

  // The rescope rebinds the token, not just its text utility, so a fill, border, ring or decoration
  // in a rebound token inside the row would also shift. Each such use must be listed here with a reason.
  it('every non-text utility on a rebound token is listed with a reason', () => {
    const intended = new Set([
      'border-fg-tertiary', // dotted quick-edit underline under a chip value: follows the rescoped text tone
      'ring-info', // transient context-menu target outline on the card root (#2059), outside the metadata row
      'bg-info', // context-target bg-info/10 fill on the card root (CardItem), outside the metadata row (and dropped under a tint)
    ])
    // Literal regex (no RegExp constructor); the token list must match the rescope exactly.
    const rebound = ['fg-tertiary', 'fg-muted', 'fg-faint', 'info', 'danger', 'success']
    expect([...rebound].sort()).toEqual(Object.keys(remap).sort())
    const re = /\b(?:bg|border|ring|outline|fill|stroke|decoration|divide|shadow|from|via|to|accent|caret|placeholder)-(?:fg-tertiary|fg-muted|fg-faint|info|danger|success)(?![a-z-])/g
    for (const f of CARD_FACE_FILES) {
      const src = readFileSync(`src/components/Card/${f}.tsx`, 'utf8')
      for (const [cls] of src.matchAll(re)) expect(intended.has(cls), `${f}.tsx uses ${cls}`).toBe(true)
    }
  })
})

// #1862: the same card face with no tint, where every text element sits directly on bg-surface.
// fg-muted (3.07:1 dark) and the dense empty-field ghost's fg-faint (1.93 dark / 2.56 light) were
// below 4.5:1 there, so those elements moved to fg-tertiary, and so did the sibling surfaces that
// carry the same metadata or the same custom-field names:
// - CustomFieldValueDisplay: its chip and row-chip variants are the same chip on the swimlane label
//   panel. AdminOnlyFieldGlyph: the row chip mounts it.
// - CardPeekPopover: at comfortable density it carries the metadata moved off the face.
// - SwimlaneFieldsPopover, SwimlaneFieldEditRow: the swimlane field names outside the row chip.
// - ArchivedCardsPanel: archived cards are bg-sunken rows inside a bg-surface panel.
// Each file lists every background its text sits on; the check takes the worst. The values are the
// ones recorded in frontend/CLAUDE.md § Card aging ramp. LensIssueCard is deferred to #2030 (its
// hover:bg-surface-hover puts even fg-tertiary at 4.04:1 dark, so it needs a design call).
describe('untinted card face text (#1862)', () => {
  const FILES: Record<string, string[]> = {
    ...Object.fromEntries(CARD_FACE_FILES.map((f) => [`Card/${f}`, ['surface']])),
    'Card/CustomFieldValueDisplay': ['surface'],
    'Common/AdminOnlyFieldGlyph': ['surface'],
    'Card/CardPeekPopover': ['surface'],
    'Board/SwimlaneFieldsPopover': ['surface'],
    'Board/SwimlaneFieldEditRow': ['surface'],
    'Board/ArchivedCardsPanel': ['surface', 'surface-sunken'],
  }
  // A token that may sit below 4.5:1 on its file's backgrounds, with its reason.
  const EXEMPT: Record<string, string> = {
    'on-primary': 'selection checkbox tick on its solid bg-primary-emphasis fill, not on bg-surface',
    success: '#2029: light green-600 is 3.30:1 on white (the checklist-complete count)',
  }
  // Exact non-text elements cut out of a file before it is scanned, each with its reason. Only the
  // matched element is exempt; every other class in the file is still checked.
  const NON_TEXT: Record<string, [element: string, reason: string]> = {
    'Board/ArchivedCardsPanel': ['<span className="text-fg-faint text-2xl">📦</span>', 'empty-state emoji, which paints its own colors'],
  }
  const read = (f: string) => readFileSync(`src/components/${f}.tsx`, 'utf8')
  const used = new Map<string, Set<string>>(Object.keys(FILES).map((f) => [f, new Set<string>()]))
  for (const f of Object.keys(FILES)) {
    const src = NON_TEXT[f] ? read(f).replace(NON_TEXT[f][0], '') : read(f)
    for (const [, name] of src.matchAll(TEXT_UTILITY)) if (!NOT_COLOR.has(name)) used.get(f)!.add(name)
  }
  // Tones CardItem gets from utils, not class literals: the untinted urgency badge, and the stale
  // badge tone (which only renders on a tint, but is checked on bare surface too).
  const strip = (cls: string) => cls.replace(/^text-/, '')
  for (const tone of ['danger', 'warning', 'info'] as const) used.get('Card/CardItem')!.add(strip(urgencyBadgeToneClass(tone, 'none')))
  used.get('Card/CardItem')!.add(strip(staleBadgeToneClass('none')))
  const allUsed = new Set([...used.values()].flatMap((s) => [...s]))
  const onBg = (block: string, t: string, bg = 'surface') => ratio(rgbOf(block, t), rgbOf(block, bg))

  it('each non-text exemption matches exactly one element, and is the only fg-faint in its file', () => {
    for (const [f, [element]] of Object.entries(NON_TEXT)) {
      const src = read(f)
      expect(src.split(element).length - 1, `${f}: ${element}`).toBe(1)
      expect(src.match(/\btext-fg-faint\b/g), `${f}: fg-faint outside ${element}`).toHaveLength(1)
    }
  })

  it('never uses fg-muted or fg-faint for text', () => {
    for (const [f, tokens] of used) {
      expect(tokens.has('fg-muted'), `${f} uses text-fg-muted`).toBe(false)
      expect(tokens.has('fg-faint'), `${f} uses text-fg-faint`).toBe(false)
    }
    // The ratios the issue reported, which is why: the tokens themselves are unchanged.
    expect(onBg(darkBlock, 'fg-muted')).toBeCloseTo(3.07, 2)
    expect(onBg(darkBlock, 'fg-muted', 'surface-sunken')).toBeCloseTo(3.75, 2)
    expect(onBg(darkBlock, 'fg-faint')).toBeCloseTo(1.93, 2)
    expect(onBg(lightBlock, 'fg-faint')).toBeCloseTo(2.56, 2)
  })

  it('feeds both util tones to the guard', () => {
    expect(staleBadgeToneClass('none')).toBe('text-warning-on-tint')
    expect(onBg(darkBlock, 'warning-on-tint')).toBeCloseTo(8.67, 2)
    expect(onBg(lightBlock, 'warning-on-tint')).toBeCloseTo(7.31, 2)
    expect(used.get('Card/CardItem')!.has('warning-on-tint')).toBe(true)
  })

  // Worst: light danger on bg-sunken (ArchivedCardsPanel) 4.62; dark danger on bg-surface 5.29.
  it.each([
    ['dark', darkBlock, 5.29],
    ['light', lightBlock, 4.62],
  ])('%s theme: every other text token used holds >= 4.5:1 on each of its backgrounds', (_n, block, floor) => {
    const ratios: number[] = []
    for (const [f, tokens] of used) {
      for (const t of tokens) {
        if (t in EXEMPT) continue
        for (const bg of FILES[f]) {
          const r = onBg(block, t, bg)
          expect(r, `${f}: ${t} on ${bg}`).toBeGreaterThanOrEqual(4.5)
          ratios.push(r)
        }
      }
    }
    expect(allUsed).toContain('fg-tertiary')
    expect(Math.min(...ratios)).toBeCloseTo(floor, 2)
  })

  it('fg-tertiary, the tone the muted and ghost text moved to, is 5.71 / 7.58 on surface and 6.96 / 7.24 on sunken', () => {
    expect(onBg(darkBlock, 'fg-tertiary')).toBeCloseTo(5.71, 2)
    expect(onBg(lightBlock, 'fg-tertiary')).toBeCloseTo(7.58, 2)
    expect(onBg(darkBlock, 'fg-tertiary', 'surface-sunken')).toBeCloseTo(6.96, 2)
    expect(onBg(lightBlock, 'fg-tertiary', 'surface-sunken')).toBeCloseTo(7.24, 2)
  })

  // When this fails, #2029 has fixed the light success token: drop the exemption above and
  // the matching note in frontend/CLAUDE.md.
  it('the success exemption is still needed: it is sub-AA on white in light mode', () => {
    expect(allUsed.has('success')).toBe(true)
    expect(onBg(lightBlock, 'success')).toBeCloseTo(3.30, 2)
  })

  // #871: the untinted due-soon badge and the due pill moved off plain `warning` (orange-600, 3.56:1
  // on white in light mode, #2029) onto `warning-on-tint`, so the exemption is gone. No card-face file
  // may use plain `text-warning` again, and the replacement holds 8.67:1 dark / 7.31:1 light on surface
  //, with the surface and surface-sunken floors pinned by the #2046 describe above.
  it('plain warning is no longer used on the card face, and its on-tint replacement clears AA', () => {
    expect(allUsed.has('warning')).toBe(false)
    expect(urgencyBadgeToneClass('warning', 'none')).toBe('text-warning-on-tint')
    expect(onBg(lightBlock, 'warning')).toBeCloseTo(3.56, 2) // why the swap was needed
    expect(onBg(darkBlock, 'warning-on-tint')).toBeGreaterThanOrEqual(8.6)
    expect(onBg(lightBlock, 'warning-on-tint')).toBeGreaterThanOrEqual(7.3)
  })

  // Narrow, dated exemption (2026-11-13, #871 / #1146): the Classic preset keeps the pre-#871 card
  // face byte for byte, so its untinted due-soon badge is still plain `text-warning` (3.56:1 on white
  // in light mode, #2029). It is NOT added to `used` above, because it is reachable only through
  // `urgencyBadgeToneClass(…, 'none', classicFace = true)`, never a class literal in a card-face file
  // (the test above proves that). Every other tone and stage is identical under Classic. When Classic
  // retires, or #2029 fixes the light warning token, drop the `classicFace` branch, this test and the
  // matching note in frontend/CLAUDE.md § Board presets.
  it('the one gated exception: Classic keeps plain warning on the untinted due-soon badge only', () => {
    expect(urgencyBadgeToneClass('warning', 'none', true)).toBe('text-warning')
    expect(onBg(lightBlock, 'warning')).toBeCloseTo(3.56, 2)
    for (const tone of ['danger', 'warning', 'info'] as const) {
      for (const stage of ['warning', 'stale', 'stale2x', 'stale3x'] as const) {
        expect(urgencyBadgeToneClass(tone, stage, true), `${tone} on ${stage}`).toBe(urgencyBadgeToneClass(tone, stage))
      }
      if (tone !== 'warning') expect(urgencyBadgeToneClass(tone, 'none', true)).toBe(urgencyBadgeToneClass(tone, 'none'))
    }
    // CardItem reaches the Classic tone only through the gate, never by a literal.
    const cardItem = readFileSync('src/components/Card/CardItem.tsx', 'utf8')
    expect(cardItem).toMatch(/urgencyBadgeToneClass\(urgency\.tone, aging\.stage, classicFace\)/)
  })
})

// #1857: leftovers missed by the #1550 / #1237 / #831 sweeps. Source-level guards so they stay fixed.
describe('design-system leftovers (#1857)', () => {
  const read = (p: string) => readFileSync(p, 'utf8')

  it('RoleInfoTooltip trigger respects the 12px typography floor', () => {
    const src = read('src/components/Common/RoleInfoTooltip.tsx')
    expect(src).not.toMatch(/text-\[(\d|1[01])px\]/)
    expect(src).toContain('text-xs')
  })

  it('ActivityTabPanel has no raw hex colors and its tokens are declared in both themes', () => {
    expect(read('src/components/Card/ActivityTabPanel.tsx')).not.toMatch(/["'`]#[0-9a-fA-F]{3,8}["'`]/)
    for (const t of ['activity-date', 'activity-assign']) {
      expect(darkBlock).toContain(`--${t}:`)
      expect(lightBlock).toContain(`--${t}:`)
      expect(tw).toContain(`"${t}": "rgb(var(--${t}) / <alpha-value>)"`)
    }
  })
})

// #1133: health pills are `bg-<hue>/20` with on-tint text (HEALTH_STATUS_STYLES), on every
// surface they sit on (the board's Row 1 and the group header on canvas/sunken, list rows and
// the group tree on surface). Pin the four pairings at the #1550 floor of 5.26:1, both themes.
describe('health status pairings (#1133)', () => {
  const pair = (cls: string) => {
    const fill = /\bbg-([a-z-]+)\/20\b/.exec(cls)
    const text = /\btext-([a-z-]+-on-tint)\b/.exec(cls)
    if (!fill || !text) throw new Error(`unparseable health classes: ${cls}`)
    return { fill: fill[1], text: text[1] }
  }

  it('every state uses a /20 tint, a /60 border and on-tint text, with a hollow neutral for No status', () => {
    for (const cls of Object.values(HEALTH_STATUS_STYLES)) {
      expect(cls).toMatch(/\bbg-[a-z-]+\/20\b/)
      expect(cls).toMatch(/\bborder-[a-z-]+\/60\b/)
      expect(cls).toMatch(/\btext-[a-z-]+-on-tint\b/)
    }
    expect(pair(HEALTH_STATUS_STYLES.none)).toEqual({ fill: 'fg-muted', text: 'muted-on-tint' })
    for (const v of ['on_track', 'at_risk', 'off_track'] as const) {
      expect(HEALTH_STATUS_TEXT[v]).toBe(`text-${pair(HEALTH_STATUS_STYLES[v]).text}`)
    }
  })

  it.each([
    ['dark', darkBlock],
    ['light', lightBlock],
  ])('%s theme: every pairing holds >= 5.26:1 on canvas, sunken and surface', (_n, block) => {
    for (const [state, cls] of Object.entries(HEALTH_STATUS_STYLES)) {
      const { fill, text } = pair(cls)
      for (const surf of ['canvas', 'surface-sunken', 'surface']) {
        const tint = blend(rgbOf(block, fill), rgbOf(block, surf), 0.2)
        expect(ratio(rgbOf(block, text), tint), `${state} on ${surf}`).toBeGreaterThanOrEqual(5.26)
      }
    }
  })
})
