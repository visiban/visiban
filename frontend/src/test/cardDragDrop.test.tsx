/**
 * Card drag-and-drop tests using the real @dnd-kit DndContext — no mocking of
 * the dnd library itself.  This complements the mocked-DndContext tests in
 * boardView.test.tsx which focus on BoardView's onDragEnd business logic;
 * these tests verify that dnd-kit's PointerSensor actually activates and that
 * onDragEnd fires with the correct active/over IDs when pointer events are
 * dispatched in jsdom.
 *
 * jsdom polyfill notes:
 *   - PointerEvent is not implemented by jsdom; the test setup file polyfills
 *     it as a MouseEvent subclass so dnd-kit's isPrimary / button checks pass.
 *   - setPointerCapture / releasePointerCapture are stubbed to no-ops since
 *     jsdom doesn't implement pointer capture.
 *   - dnd-kit attaches pointermove/pointerup listeners to getOwnerDocument()
 *     (= document), so move/up events are dispatched on document.
 *   - Collision detection reads getBoundingClientRect(); we patch each
 *     droppable element's method to return known coordinates.
 *   - Each event phase is wrapped in act() to flush React's batched state
 *     updates (DndContext's dragStart/dragEnd dispatches) before the next
 *     event fires.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import {
  DndContext,
  useDroppable,
  useDraggable,
  closestCenter,
  pointerWithin,
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'

beforeAll(() => {
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
})

// ─── Minimal test harness ────────────────────────────────────────────────────

interface ColProps {
  id: string
  rect: DOMRect
}

function DroppableColumn({ id, rect }: ColProps) {
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

const COL_A: DOMRect = Object.assign(
  { left: 0, top: 0, right: 200, bottom: 300, width: 200, height: 300, x: 0, y: 0 },
  { toJSON: () => ({}) },
) as DOMRect

const COL_B: DOMRect = Object.assign(
  { left: 300, top: 0, right: 500, bottom: 300, width: 200, height: 300, x: 300, y: 0 },
  { toJSON: () => ({}) },
) as DOMRect

function TestBoard({ onDragEnd }: { onDragEnd: (e: DragEndEvent) => void }) {
  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <DroppableColumn id="col-a" rect={COL_A} />
      <DraggableCard id="card-1" />
      <DroppableColumn id="col-b" rect={COL_B} />
    </DndContext>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Construct a real PointerEvent (the polyfill in setup.ts makes this available
// in jsdom).  We need genuine PointerEvent instances because dnd-kit's
// PointerSensor guards on event.isPrimary and event.button — properties that
// fireEvent.pointerDown does not set (it produces a plain Event in jsdom).
function pev(type: string, init: PointerEventInit): PointerEvent {
  return new PointerEvent(type, { bubbles: true, cancelable: true, ...init })
}

// Simulate a complete drag: pointerdown on the draggable element, then
// pointermove on document (where PointerSensor attaches its listeners via
// getOwnerDocument), then pointerup to end the drag.  The default DndContext
// sensors have no activationConstraint so the drag starts on pointerdown.
// Each phase is wrapped in act() so React flushes dragStart/dragEnd state
// updates before the next event fires.
async function drag(
  el: HTMLElement,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
) {
  const base: PointerEventInit = { pointerId: 1, buttons: 1, isPrimary: true, pointerType: 'mouse' }
  el.dispatchEvent(pev('pointerdown', { ...base, clientX: fromX, clientY: fromY, button: 0 }))
  await act(async () => {
    document.dispatchEvent(pev('pointermove', { ...base, clientX: toX, clientY: toY }))
  })
  await act(async () => {
    document.dispatchEvent(pev('pointerup', { ...base, clientX: toX, clientY: toY }))
  })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('card drag-and-drop — real DndContext, no dnd-kit mocking', () => {
  it('fires onDragEnd with the target column when card is dropped on col-b', async () => {
    const handleDragEnd = vi.fn()
    const { getByTestId } = render(<TestBoard onDragEnd={handleDragEnd} />)

    // clientX: 400 is inside COL_B (x: 300–500)
    await drag(getByTestId('card-1'), 100, 150, 400, 150)

    expect(handleDragEnd).toHaveBeenCalledOnce()
    const event: DragEndEvent = handleDragEnd.mock.calls[0][0]
    expect(event.active.id).toBe('card-1')
    expect(event.over?.id).toBe('col-b')
  })

  it('fires onDragEnd with over: null when card is released outside any column', async () => {
    const handleDragEnd = vi.fn()
    // Use pointerWithin so that a pointer outside all droppable rects yields
    // over: null.  closestCenter would return the nearest column even at (600, 150).
    const { getByTestId } = render(
      <DndContext collisionDetection={pointerWithin} onDragEnd={handleDragEnd}>
        <DroppableColumn id="col-a" rect={COL_A} />
        <DraggableCard id="card-1" />
        <DroppableColumn id="col-b" rect={COL_B} />
      </DndContext>,
    )

    // clientX: 600 is past both columns (COL_A: 0–200, COL_B: 300–500)
    await drag(getByTestId('card-1'), 100, 150, 600, 150)

    expect(handleDragEnd).toHaveBeenCalledOnce()
    const event: DragEndEvent = handleDragEnd.mock.calls[0][0]
    expect(event.active.id).toBe('card-1')
    expect(event.over).toBeNull()
  })

  it('fires onDragEnd with col-a when card is dropped back on its origin column', async () => {
    const handleDragEnd = vi.fn()
    const { getByTestId } = render(<TestBoard onDragEnd={handleDragEnd} />)

    // clientX: 100 stays inside COL_A (x: 0–200)
    await drag(getByTestId('card-1'), 100, 150, 100, 200)

    expect(handleDragEnd).toHaveBeenCalledOnce()
    const event: DragEndEvent = handleDragEnd.mock.calls[0][0]
    expect(event.active.id).toBe('card-1')
    expect(event.over?.id).toBe('col-a')
  })
})
