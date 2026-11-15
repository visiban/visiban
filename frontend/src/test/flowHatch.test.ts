import { describe, expect, it } from 'vitest'
import { HATCH } from '../components/Board/flowMetrics/flowRowData'
import { HATCH_CSS, HATCH_GROUND_COLOR, HATCH_PERIOD, HATCH_SPEC, HATCH_STRIPE_COLOR, HATCH_SVG } from '../components/Board/flowMetrics/hatch'

describe('the shared bottleneck hatch (#2285)', () => {
  it('derives the CSS gradient and the SVG pattern from one spec', () => {
    expect(HATCH).toBe(HATCH_CSS)
    expect(HATCH_PERIOD).toBe(HATCH_SPEC.stripe + HATCH_SPEC.gap)
    expect(HATCH_CSS).toContain(`${HATCH_SPEC.angle + 90}deg`)
    expect(HATCH_CSS).toContain(HATCH_STRIPE_COLOR)
    expect(HATCH_CSS).toContain(HATCH_GROUND_COLOR)
    expect(HATCH_CSS).toContain(`${HATCH_PERIOD}px)`)
    expect(HATCH_SVG.pattern.patternTransform).toBe(`rotate(${HATCH_SPEC.angle})`)
    expect(HATCH_SVG.stripe.strokeWidth).toBe(HATCH_SPEC.stripe)
    expect(HATCH_SVG.stripe.stroke).toBe(HATCH_STRIPE_COLOR)
    expect(HATCH_SVG.ground.fill).toBe(HATCH_GROUND_COLOR)
  })

  it('uses a named warning token, not a raw color', () => {
    expect(HATCH_STRIPE_COLOR).toContain('--warning')
    expect(HATCH_GROUND_COLOR).toContain('--warning')
    expect(HATCH_CSS).not.toMatch(/#[0-9a-f]{3,6}/i)
  })
})
