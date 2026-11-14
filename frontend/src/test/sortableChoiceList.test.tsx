/**
 * SortableChoiceList (#2190): the drop and focus logic behind the choice-row
 * keyboard reorder. jsdom has no layout, so the arrow-key move itself is covered
 * by e2e/choice-keyboard-reorder.spec.ts; here DndContext is replaced with one
 * that hands its props to the test, which calls them as dnd-kit would.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import type { Announcements, DragEndEvent } from '@dnd-kit/core'
import SortableChoiceList, { CHOICE_DRAG_ESCAPE_PRIORITY } from '../components/Board/SortableChoiceList'
import { useEscapeStack } from '../hooks/useEscapeStack'

type CapturedProps = {
  onDragStart?: () => void
  onDragEnd?: (e: DragEndEvent) => void
  onDragCancel?: () => void
  accessibility?: { announcements: Announcements }
}
const dnd: { props: CapturedProps } = { props: {} }

vi.mock('@dnd-kit/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dnd-kit/core')>()),
  DndContext: ({ children, ...props }: CapturedProps & { children: React.ReactNode }) => {
    dnd.props = props
    return <>{children}</>
  },
}))

function Host({ initial, onMove }: { initial: string[]; onMove?: (from: number, to: number) => void }) {
  const [choices, setChoices] = useState(initial)
  return (
    <SortableChoiceList
      choices={choices}
      onMove={(from, to) => {
        onMove?.(from, to)
        setChoices((c) => { const n = [...c]; n.splice(to, 0, n.splice(from, 1)[0]); return n })
      }}
      renderRow={(choice) => <span>{choice}</span>}
    />
  )
}

const end = (from: number, to: number | null, activatorEvent: Event) =>
  ({ active: { id: `choice-${from}` }, over: to === null ? null : { id: `choice-${to}` }, activatorEvent } as unknown as DragEndEvent)

describe('SortableChoiceList (#2190)', () => {
  it('names each handle by the choice text, else its position', () => {
    render(<Host initial={['Red', '  ', ' Blue ']} />)
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Drag to reorder choice Red', 'Drag to reorder choice 2', 'Drag to reorder choice Blue',
    ])
  })

  it('a keyboard drop moves the choice and focus follows it to its new row', () => {
    const onMove = vi.fn()
    render(<Host initial={['Red', 'Green', 'Blue']} onMove={onMove} />)
    screen.getByRole('button', { name: 'Drag to reorder choice Red' }).focus()
    act(() => { dnd.props.onDragEnd!(end(0, 2, new KeyboardEvent('keydown', { key: ' ' }))) })
    expect(onMove).toHaveBeenCalledWith(0, 2)
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Drag to reorder choice Green', 'Drag to reorder choice Blue', 'Drag to reorder choice Red',
    ])
    expect(screen.getByRole('button', { name: 'Drag to reorder choice Red' })).toHaveFocus()
  })

  it('a mouse drop moves the choice without moving focus', () => {
    const onMove = vi.fn()
    render(<Host initial={['Red', 'Green']} onMove={onMove} />)
    act(() => { dnd.props.onDragEnd!(end(1, 0, new MouseEvent('mousedown'))) })
    expect(onMove).toHaveBeenCalledWith(1, 0)
    expect(document.body).toHaveFocus()
  })

  it('a drop on itself or outside the list moves nothing', () => {
    const onMove = vi.fn()
    render(<Host initial={['Red', 'Green']} onMove={onMove} />)
    act(() => { dnd.props.onDragEnd!(end(1, 1, new KeyboardEvent('keydown'))) })
    act(() => { dnd.props.onDragEnd!(end(1, null, new KeyboardEvent('keydown'))) })
    expect(onMove).not.toHaveBeenCalled()
  })

  it('announces by choice name and position, never by internal id', () => {
    render(<Host initial={['Red', 'Green', 'Blue']} />)
    const a = dnd.props.accessibility!.announcements
    const active = { id: 'choice-0' } as never
    const over = { id: 'choice-2' } as never
    expect(a.onDragStart({ active })).toBe('Picked up choice Red, at position 1 of 3.')
    expect(a.onDragOver({ active, over })).toBe('choice Red moved to position 3 of 3.')
    expect(a.onDragOver({ active, over: null })).toBeUndefined()
    expect(a.onDragEnd({ active, over })).toBe('choice Red dropped at position 3 of 3.')
    expect(a.onDragEnd({ active, over: null })).toBe('choice Red dropped.')
    expect(a.onDragCancel({ active, over: null })).toBe('Reorder canceled. choice Red returned to position 1 of 3.')
  })

  it('Escape during a drag is not passed on to the modal below; outside a drag it is', () => {
    const modalEscape = vi.fn()
    function Modal() { useEscapeStack(modalEscape, 40); return <Host initial={['Red', 'Green']} /> }
    expect(CHOICE_DRAG_ESCAPE_PRIORITY).toBeGreaterThan(40.6)
    render(<Modal />)
    act(() => { dnd.props.onDragStart!() })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(modalEscape).not.toHaveBeenCalled()
    act(() => { dnd.props.onDragCancel!() })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(modalEscape).toHaveBeenCalledTimes(1)
    // A drop also ends the drag.
    act(() => { dnd.props.onDragStart!() })
    act(() => { dnd.props.onDragEnd!(end(0, 0, new KeyboardEvent('keydown'))) })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(modalEscape).toHaveBeenCalledTimes(2)
  })
})
