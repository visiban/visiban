/**
 * useDragSensors (#1287) against the real @dnd-kit DndContext — no mocking of
 * the dnd library. Complements cardDragDrop.test.tsx, which covers collision
 * and onDragEnd wiring with the *default* sensors; this file covers the
 * activation constraints that decide whether a gesture is a drag at all.
 *
 * jsdom notes:
 *   - TouchSensor attaches touchmove/touchend to the touched element itself
 *     (touch events keep targeting the original element), so move/end are
 *     dispatched on the card, not on document.
 *   - jsdom has TouchEvent but no Touch constructor, so `touches` and
 *     `changedTouches` are defined directly on each event instance.
 *   - MouseSensor attaches mousemove/mouseup to document.
 *   - The touch hold uses real timers: dnd-kit's delay is a plain setTimeout,
 *     and faking timers also fakes requestAnimationFrame, which dnd-kit uses
 *     while a drag is active.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, act, renderHook } from '@testing-library/react'
import { DndContext, KeyboardSensor, TouchSensor, closestCenter, useDraggable, useDroppable } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { MOUSE_ACTIVATION, PrimaryButtonMouseSensor, TOUCH_ACTIVATION, useDragSensors } from '../hooks/useDragSensors'

const COL_B: DOMRect = Object.assign(
  { left: 300, top: 0, right: 500, bottom: 300, width: 200, height: 300, x: 300, y: 0 },
  { toJSON: () => ({}) },
) as DOMRect

function DroppableColumn({ id, rect }: { id: string; rect: DOMRect }) {
  const { setNodeRef } = useDroppable({ id })
  return (
    <div
      ref={(el) => {
        if (el) {
          el.getBoundingClientRect = () => rect
          setNodeRef(el)
        }
      }}
      data-testid={id}
    />
  )
}

function DraggableCard({ id }: { id: string }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id })
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} data-testid={id}>
      Card
    </div>
  )
}

function TestBoard({ onDragStart, onDragEnd }: { onDragStart: () => void; onDragEnd: (e: DragEndEvent) => void }) {
  const sensors = useDragSensors()
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <DraggableCard id="card-1" />
      <DroppableColumn id="col-b" rect={COL_B} />
    </DndContext>
  )
}

function touch(type: string, x: number, y: number): TouchEvent {
  const event = new TouchEvent(type, { bubbles: true, cancelable: true })
  const point = [{ clientX: x, clientY: y, identifier: 0 }]
  // touchend has no active touches; the lifted finger is in changedTouches.
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : point })
  Object.defineProperty(event, 'changedTouches', { value: point })
  return event
}

function mouse(type: string, x: number, y: number, button = 0): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, button, clientX: x, clientY: y })
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('useDragSensors — touch (#1287)', () => {
  it('press-and-hold then move drags the card to the drop target', async () => {
    const onDragStart = vi.fn()
    const onDragEnd = vi.fn()
    const { getByTestId } = render(<TestBoard onDragStart={onDragStart} onDragEnd={onDragEnd} />)
    const card = getByTestId('card-1')

    await act(async () => {
      card.dispatchEvent(touch('touchstart', 100, 150))
      await wait(TOUCH_ACTIVATION.delay + 50)
    })
    expect(onDragStart).toHaveBeenCalledOnce()

    await act(async () => {
      card.dispatchEvent(touch('touchmove', 400, 150))
    })
    await act(async () => {
      card.dispatchEvent(touch('touchend', 400, 150))
    })

    expect(onDragEnd).toHaveBeenCalledOnce()
    const event: DragEndEvent = onDragEnd.mock.calls[0][0]
    expect(event.active.id).toBe('card-1')
    expect(event.over?.id).toBe('col-b')
  })

  it('a swipe that moves before the hold completes never starts a drag (the board keeps scrolling)', async () => {
    const onDragStart = vi.fn()
    const onDragEnd = vi.fn()
    const { getByTestId } = render(<TestBoard onDragStart={onDragStart} onDragEnd={onDragEnd} />)
    const card = getByTestId('card-1')

    await act(async () => {
      card.dispatchEvent(touch('touchstart', 100, 150))
      // Beyond the 5px tolerance, well inside the 250ms hold.
      card.dispatchEvent(touch('touchmove', 100 + TOUCH_ACTIVATION.tolerance + 20, 150))
      await wait(TOUCH_ACTIVATION.delay + 50)
      card.dispatchEvent(touch('touchend', 125, 150))
    })

    expect(onDragStart).not.toHaveBeenCalled()
    expect(onDragEnd).not.toHaveBeenCalled()
  })

  it('a quick tap never starts a drag', async () => {
    const onDragStart = vi.fn()
    const { getByTestId } = render(<TestBoard onDragStart={onDragStart} onDragEnd={vi.fn()} />)
    const card = getByTestId('card-1')

    await act(async () => {
      card.dispatchEvent(touch('touchstart', 100, 150))
      card.dispatchEvent(touch('touchend', 100, 150))
      await wait(TOUCH_ACTIVATION.delay + 50)
    })

    expect(onDragStart).not.toHaveBeenCalled()
  })
})

describe('useDragSensors — mouse (unchanged desktop behavior)', () => {
  it('movement under 5px does not start a drag, so a click still opens the card', async () => {
    const onDragStart = vi.fn()
    const { getByTestId } = render(<TestBoard onDragStart={onDragStart} onDragEnd={vi.fn()} />)

    await act(async () => {
      getByTestId('card-1').dispatchEvent(mouse('mousedown', 100, 150))
      document.dispatchEvent(mouse('mousemove', 100 + MOUSE_ACTIVATION.distance - 2, 150))
      document.dispatchEvent(mouse('mouseup', 100 + MOUSE_ACTIVATION.distance - 2, 150))
    })

    expect(onDragStart).not.toHaveBeenCalled()
  })

  it('movement past 5px drags the card to the drop target', async () => {
    const onDragEnd = vi.fn()
    const { getByTestId } = render(<TestBoard onDragStart={vi.fn()} onDragEnd={onDragEnd} />)

    getByTestId('card-1').dispatchEvent(mouse('mousedown', 100, 150))
    await act(async () => {
      document.dispatchEvent(mouse('mousemove', 400, 150))
    })
    await act(async () => {
      document.dispatchEvent(mouse('mouseup', 400, 150))
    })

    expect(onDragEnd).toHaveBeenCalledOnce()
    expect(onDragEnd.mock.calls[0][0].over?.id).toBe('col-b')
  })
})

describe('useDragSensors — mouse buttons', () => {
  it('a middle-button press and move never starts a drag (primary button only, as PointerSensor was)', async () => {
    const onDragStart = vi.fn()
    const { getByTestId } = render(<TestBoard onDragStart={onDragStart} onDragEnd={vi.fn()} />)

    await act(async () => {
      getByTestId('card-1').dispatchEvent(mouse('mousedown', 100, 150, 1))
      document.dispatchEvent(mouse('mousemove', 400, 150, 1))
      document.dispatchEvent(mouse('mouseup', 400, 150, 1))
    })

    expect(onDragStart).not.toHaveBeenCalled()
  })
})

describe('useDragSensors — sensor set', () => {
  it('uses mouse + touch only by default (the board grid has no keyboard drag)', () => {
    const { result } = renderHook(() => useDragSensors())
    expect(result.current.map((s) => s.sensor)).toEqual([PrimaryButtonMouseSensor, TouchSensor])
  })

  it('adds the keyboard sensor on request, preserving DndContext default keyboard reordering', () => {
    const { result } = renderHook(() => useDragSensors({ keyboard: true }))
    expect(result.current.map((s) => s.sensor)).toEqual([PrimaryButtonMouseSensor, TouchSensor, KeyboardSensor])
  })
})
