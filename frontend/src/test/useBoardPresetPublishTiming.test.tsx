import { describe, it, expect, afterEach, vi } from 'vitest'
import { useLayoutEffect } from 'react'
import { render } from '@testing-library/react'
import { useBoardPreset } from '../hooks/useBoardPreset'
import { getSnapshot, publishActivePreset } from '../boardPresets/activePresetStore'
import type { Board } from '../types'

// #871: `useBoardPreset` publishes the active preset in a LAYOUT effect so a Default
// board never paints the Classic face first. A passive effect runs after paint, so
// the discriminator is a later sibling's layout effect in the same commit: it sees
// the published snapshot only if the publish was itself a layout effect.
function Host() {
  useBoardPreset({
    boardId: 7,
    board: { default_preset: 'default', card_density: 'comfortable' } as unknown as Board,
    densityOverride: null,
    setDensityOverride: vi.fn(),
    localOverlay: null,
    setLocalOverlay: vi.fn(),
    clearLocalOverlay: vi.fn(),
    searchParams: new URLSearchParams(),
    setSearchParams: vi.fn(),
  } as unknown as Parameters<typeof useBoardPreset>[0])
  return null
}

function Probe({ onProbe }: { onProbe: (published: string | null | undefined) => void }) {
  useLayoutEffect(() => {
    const snap = getSnapshot()
    onProbe(snap ? snap.activePresetId : undefined)
  }, [onProbe])
  return null
}

describe('useBoardPreset publish timing (#871)', () => {
  afterEach(() => publishActivePreset(null))

  it('has published the active preset by the time later layout effects of the same commit run', () => {
    const seen: Array<string | null | undefined> = []
    // Probe is a later SIBLING: a child's layout effect would run before the host's.
    render(<><Host /><Probe onProbe={(v) => seen.push(v)} /></>)
    expect(seen[0]).toBe('default')
  })
})
