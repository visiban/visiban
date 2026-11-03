/**
 * Board presets registry (#1146): the code-defined presets and the pure resolution
 * rules — what the board renders, how applying writes the per-user keys, what
 * "Modified" means, and which preset is active when none was chosen in this tab.
 */
import { describe, it, expect } from 'vitest'
import {
  BOARD_PRESET_IDS,
  BOARD_PRESET_SCHEMA_VERSION,
  effectiveDisplay,
  formatPresetDifference,
  getBoardPreset,
  listBoardPresets,
  overlayLabel,
  parsePresetParam,
  planPresetApply,
  presetDifferences,
  presetDisplay,
  presetSummary,
  resolveActivePresetId,
  type BoardPreset,
  type PresetBoard,
} from '../boardPresets/registry'

const classic = getBoardPreset('classic') as BoardPreset
const dflt = getBoardPreset('default') as BoardPreset
const noKeys = { densityOverride: null, localOverlay: null }

function board(overrides: Partial<PresetBoard> = {}): PresetBoard {
  return { card_density: 'comfortable', default_preset: null, ...overrides }
}

describe('preset definitions', () => {
  it('ships exactly Classic and Default, in that order, with the backend ids', () => {
    expect(listBoardPresets().map((p) => p.id)).toEqual(['classic', 'default'])
    expect(BOARD_PRESET_IDS).toEqual(['classic', 'default'])
    expect(listBoardPresets().map((p) => p.name)).toEqual(['Classic', 'Default'])
  })

  it('versions every preset with the current schema version', () => {
    expect(BOARD_PRESET_SCHEMA_VERSION).toBe(1)
    for (const p of listBoardPresets()) expect(p.schemaVersion).toBe(1)
  })

  it('pins the Classic bundle as the no-op bundle (current behavior)', () => {
    // Classic is the #871 escape hatch: board density, no overlay, the board's own
    // card-face fields, no filter, no attention reference. Any change here changes
    // what "current behavior" means for every install that picks it.
    expect(classic.bundle).toMatchInlineSnapshot(`
      {
        "attention": null,
        "density": null,
        "fields": null,
        "filter": null,
        "overlay": "none",
      }
    `)
  })

  it('ships Default with Standard density and an empty attention reference', () => {
    expect(dflt.bundle).toEqual({ fields: null, density: 'standard', overlay: 'none', filter: null, attention: null })
  })

  it('carries no domain semantics: no preset names a field, label or filter', () => {
    for (const p of listBoardPresets()) {
      expect(p.bundle.fields).toBeNull()
      expect(p.bundle.filter).toBeNull()
      expect(p.bundle.attention).toBeNull()
    }
  })

  it('resolves unknown, empty and stale ids to null', () => {
    expect(getBoardPreset(null)).toBeNull()
    expect(getBoardPreset(undefined)).toBeNull()
    expect(getBoardPreset('')).toBeNull()
    expect(getBoardPreset('standup')).toBeNull()
    expect(getBoardPreset('Classic')).toBeNull()
  })

  it('parses ?preset= values', () => {
    expect(parsePresetParam('classic')).toBe('classic')
    expect(parsePresetParam('default')).toBe('default')
    expect(parsePresetParam('bogus')).toBeNull()
    expect(parsePresetParam(null)).toBeNull()
  })

  it('summarizes each preset in one line', () => {
    expect(presetSummary(classic)).toBe('Board density · No overlay')
    expect(presetSummary(dflt)).toBe('Standard density · No overlay')
  })

  it('labels unknown overlays as no overlay', () => {
    expect(overlayLabel('card-count')).toBe('Card count')
    expect(overlayLabel('dwell-time')).toBe('No overlay')
  })
})

describe('effectiveDisplay — URL > user > board default > board', () => {
  it('with no board default and no keys, is exactly the pre-preset resolution', () => {
    for (const card_density of ['comfortable', 'standard', 'dense'] as const) {
      expect(effectiveDisplay(board({ card_density }), noKeys)).toEqual({ density: card_density, overlay: 'none' })
    }
    expect(effectiveDisplay(board(), { densityOverride: 'dense', localOverlay: 'card-count' })).toEqual({
      density: 'dense', overlay: 'card-count',
    })
  })

  it('uses the board default preset under a member with no keys', () => {
    expect(effectiveDisplay(board({ default_preset: 'default' }), noKeys)).toEqual({ density: 'standard', overlay: 'none' })
  })

  it('lets each of the member keys beat the board default independently', () => {
    const b = board({ default_preset: 'default' })
    expect(effectiveDisplay(b, { densityOverride: 'dense', localOverlay: null })).toEqual({ density: 'dense', overlay: 'none' })
    expect(effectiveDisplay(b, { densityOverride: null, localOverlay: 'card-count' })).toEqual({
      density: 'standard', overlay: 'card-count',
    })
  })

  it('ignores an unknown default preset id', () => {
    expect(effectiveDisplay(board({ default_preset: 'standup' }), noKeys)).toEqual({ density: 'comfortable', overlay: 'none' })
  })

  it('decays a stored overlay this build does not know to none', () => {
    expect(effectiveDisplay(board(), { densityOverride: null, localOverlay: 'dwell-time' }).overlay).toBe('none')
  })
})

describe('planPresetApply', () => {
  it('Classic removes the density key and stores no overlay', () => {
    expect(planPresetApply(classic, board())).toEqual({ densityOverride: null, localOverlay: 'none' })
  })

  it('Default stores its density and overlay', () => {
    expect(planPresetApply(dflt, board())).toEqual({ densityOverride: 'standard', localOverlay: 'none' })
  })

  it('choosing the board default clears both keys so the member follows the board again', () => {
    expect(planPresetApply(dflt, board({ default_preset: 'default' }))).toEqual({ densityOverride: null, localOverlay: null })
    expect(planPresetApply(classic, board({ default_preset: 'classic' }))).toEqual({ densityOverride: null, localOverlay: null })
  })

  it('Classic over a density-setting board default writes the board density explicitly', () => {
    // Removing the key would let the board default's Standard show through.
    expect(planPresetApply(classic, board({ card_density: 'dense', default_preset: 'default' }))).toEqual({
      densityOverride: 'dense', localOverlay: 'none',
    })
  })

  it('always lands on exactly what the preset displays', () => {
    for (const default_preset of [null, 'classic', 'default']) {
      for (const card_density of ['comfortable', 'standard', 'dense'] as const) {
        for (const preset of listBoardPresets()) {
          const b = board({ card_density, default_preset })
          const plan = planPresetApply(preset, b)
          const shown = effectiveDisplay(b, { densityOverride: plan.densityOverride, localOverlay: plan.localOverlay })
          expect(presetDifferences(preset, b, shown)).toEqual([])
        }
      }
    }
  })
})

describe('presetDifferences', () => {
  it('is empty when the board matches the preset', () => {
    expect(presetDifferences(dflt, board(), presetDisplay(dflt, board()))).toEqual([])
  })

  it('names each changed element with current and preset values', () => {
    const diffs = presetDifferences(dflt, board(), { density: 'dense', overlay: 'card-count' })
    expect(diffs).toEqual([
      { element: 'density', current: 'Dense', preset: 'Standard' },
      { element: 'overlay', current: 'Card count', preset: 'No overlay' },
    ])
    expect(diffs.map(formatPresetDifference)).toEqual([
      'Density: Dense (preset: Standard)',
      'Overlay: Card count (preset: No overlay)',
    ])
  })

  it('compares Classic density against the board density', () => {
    expect(presetDifferences(classic, board({ card_density: 'dense' }), { density: 'dense', overlay: 'none' })).toEqual([])
    expect(presetDifferences(classic, board({ card_density: 'dense' }), { density: 'standard', overlay: 'none' })).toHaveLength(1)
  })
})

describe('resolveActivePresetId', () => {
  it('is none with no applied preset and no board default', () => {
    expect(resolveActivePresetId(board(), null)).toBeNull()
  })

  it('is the board default when the member applied none', () => {
    expect(resolveActivePresetId(board({ default_preset: 'default' }), null)).toBe('default')
  })

  it('is the preset the member applied, over the board default', () => {
    expect(resolveActivePresetId(board(), 'default')).toBe('default')
    expect(resolveActivePresetId(board({ default_preset: 'default' }), 'classic')).toBe('classic')
  })

  it('ignores an unknown or stale marker', () => {
    expect(resolveActivePresetId(board(), 'standup')).toBeNull()
    expect(resolveActivePresetId(board({ default_preset: 'classic' }), 'standup')).toBe('classic')
  })
})
