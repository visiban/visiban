import { describe, it, expect } from 'vitest'
import { DISMISS_LAYER_ATTR, hasOpenDismissLayer } from '../utils/dismissLayer'

describe('hasOpenDismissLayer', () => {
  it('finds a marked descendant and nothing else', () => {
    const host = document.createElement('div')
    expect(hasOpenDismissLayer(host)).toBe(false)
    const layer = document.createElement('div')
    layer.setAttribute(DISMISS_LAYER_ATTR, '')
    host.appendChild(layer)
    expect(hasOpenDismissLayer(host)).toBe(true)
    layer.remove()
    expect(hasOpenDismissLayer(host)).toBe(false)
  })

  it('is false with no host', () => {
    expect(hasOpenDismissLayer(null)).toBe(false)
  })
})
