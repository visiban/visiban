import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import ColumnPolicyPopover from '../components/Board/ColumnPolicyPopover'
import HealthStatusPopover from '../components/Common/HealthStatusPopover'
import SwimlaneFieldsPopover from '../components/Board/SwimlaneFieldsPopover'
import SelectDropdown from '../components/Common/SelectDropdown'
import ColorSwatchPicker from '../components/Common/ColorSwatchPicker'
import CardContextMenu from '../components/Card/CardContextMenu'
import { COLUMN_COLORS } from '../constants/colors'
import { stubVisualViewport, clearVisualViewport } from './visualViewportStub'

// #2161: the height caps and horizontal clamps of the anchored popovers follow
// the visible viewport (on-screen keyboard, pinch zoom), not the layout
// viewport. Each case runs without `visualViewport` (jsdom's default, falling
// back to the window) and with a stubbed one that is shorter and narrower.

afterEach(() => { clearVisualViewport(); vi.restoreAllMocks() })

const rectAt = (left: number, top = 100) =>
  ({ top, bottom: top + 20, left, right: left + 30, width: 30, height: 20, x: left, y: top, toJSON: () => ({}) }) as DOMRect

type Mode = { name: string; setup: () => void; cap: () => string; maxLeft: (width: number) => number }
const MODES: Mode[] = [
  {
    name: 'without visualViewport',
    setup: () => clearVisualViewport(),
    cap: () => `${window.innerHeight - 16}px`,
    maxLeft: (w) => window.innerWidth - 8 - w,
  },
  {
    name: 'with a smaller visualViewport',
    setup: () => { stubVisualViewport({ height: 300, width: 500 }) },
    cap: () => '284px',
    maxLeft: (w) => 500 - 8 - w,
  },
]

describe.each(MODES)('anchored popovers $name (#2161)', (mode) => {
  it('ColumnPolicyPopover caps its body and clamps left', () => {
    mode.setup()
    render(
      <ColumnPolicyPopover
        columnName="Review"
        policy={{ v: 1, entry: ['Has an owner'], done: ['Reviewed'], mode: 'confirm' }}
        anchorRect={rectAt(window.innerWidth - 10)}
        onDismiss={vi.fn()}
        triggerRef={createRef<HTMLButtonElement>()}
      />,
    )
    expect(screen.getByRole('region').style.maxHeight).toBe(`calc(${mode.cap()} - 6rem)`)
    expect(screen.getByRole('dialog').style.left).toBe(`${mode.maxLeft(340)}px`)
  })

  it('HealthStatusPopover clamps left', () => {
    mode.setup()
    render(
      <HealthStatusPopover
        entityKind="board" entityName="Roadmap" parentName={null}
        health_status={null} effective_health_status={null} health_status_source={null}
        anchorRect={rectAt(window.innerWidth - 10)}
        triggerRef={createRef<HTMLButtonElement>()}
        onDismiss={vi.fn()} onSave={vi.fn()}
      />,
    )
    expect(screen.getByRole('dialog').style.left).toBe(`${mode.maxLeft(320)}px`)
  })

  it('SwimlaneFieldsPopover caps its list and clamps left', () => {
    mode.setup()
    render(
      <SwimlaneFieldsPopover
        swimlaneName="Acme" entries={[]} anchorRect={rectAt(window.innerWidth - 10)}
        onDismiss={vi.fn()} triggerRef={createRef<HTMLButtonElement>()}
      />,
    )
    expect(screen.getByRole('dialog').style.left).toBe(`${mode.maxLeft(256)}px`)
    const capped = Array.from(document.querySelectorAll<HTMLElement>('[style*="max-height"]'))
    expect(capped.map((e) => e.style.maxHeight)).toContain(`calc(${mode.cap()} - 5.5rem)`)
  })

  it('SelectDropdown caps its menu', async () => {
    mode.setup()
    render(<SelectDropdown value="a" onChange={vi.fn()} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />)
    await userEvent.click(screen.getByRole('combobox'))
    const panel = screen.getByRole('listbox').parentElement as HTMLElement
    expect(panel.style.maxHeight).toBe(mode.cap())
  })

  it('ColorSwatchPicker custom popover caps its height and clamps left', async () => {
    mode.setup()
    render(<ColorSwatchPicker colors={COLUMN_COLORS} value="#3B82F6" onChange={vi.fn()} allowCustom groupLabel="Color" />)
    await userEvent.click(screen.getByTitle('Custom color'))
    const panel = screen.getByRole('dialog')
    expect(panel.style.maxHeight).toBe(mode.cap())
    expect(panel.className).not.toContain('100dvh')
  })

  it('CardContextMenu caps its menu', () => {
    mode.setup()
    render(
      <CardContextMenu
        anchor={{ top: 100, bottom: 100, left: 50 }} label="Card actions: X"
        entries={[{ id: 'open', label: 'Open card', group: 'primary' } as never]}
        columns={[]} members={[]} onAction={vi.fn()} onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole('menu').style.maxHeight).toBe(mode.cap())
  })
})

describe('anchored popovers follow the visual viewport live (#2161)', () => {
  it('SelectDropdown list cap follows a visualViewport resize (the keyboard opening)', async () => {
    const { vv } = stubVisualViewport({ height: 600, width: 500 })
    render(<SelectDropdown value="a" onChange={vi.fn()} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />)
    await userEvent.click(screen.getByRole('combobox'))
    const panel = () => screen.getByRole('listbox').parentElement as HTMLElement
    expect(panel().style.maxHeight).toBe('584px')
    act(() => {
      vv.height = 250
      vv.dispatchEvent(new Event('resize'))
    })
    expect(panel().style.maxHeight).toBe('234px')
  })

  it('CardContextMenu clamps an anchor near the right edge into the visible box', () => {
    stubVisualViewport({ height: 600, width: 500 })
    render(
      <CardContextMenu
        anchor={{ top: 100, bottom: 100, left: 600 }} label="Card actions: X"
        entries={[{ id: 'open', label: 'Open card', group: 'primary' } as never]}
        columns={[]} members={[]} onAction={vi.fn()} onClose={vi.fn()}
      />,
    )
    // jsdom lays out nothing, so the measured width is 0: left = vv right edge - margin.
    expect(screen.getByRole('menu').style.left).toBe('492px')
  })
})
