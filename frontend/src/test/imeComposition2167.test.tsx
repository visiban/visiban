import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import CreateBoardModal from '../components/Board/CreateBoardModal'
import { isImeComposing } from '../utils/imeComposition'

vi.mock('../api/boards', () => ({
  listGroups: vi.fn().mockResolvedValue([]),
  listBoardTemplates: vi.fn().mockResolvedValue([
    {
      id: '1', name: 'Simple Kanban', slug: 'simple_kanban', description: '', icon: 'columns',
      lane_label: 'Team', lane_placeholder: 'e.g. Engineering',
      columns_json: [{ name: 'Backlog', color: '#6B7280', position: 0 }], sort_order: 40,
    },
  ]),
}))

describe('isImeComposing (#2167)', () => {
  it('detects isComposing, nested nativeEvent.isComposing and keyCode 229', () => {
    expect(isImeComposing({ isComposing: true })).toBe(true)
    expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true)
    expect(isImeComposing({ keyCode: 229 })).toBe(true)
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false)
  })
})

describe('CreateBoardModal Enter during IME composition (#2167)', () => {
  it('does not submit on a composing Enter, but submits on a normal Enter', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(<CreateBoardModal onConfirm={onConfirm} onCancel={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Simple Kanban')).toBeInTheDocument())
    const input = screen.getByPlaceholderText(/e.g. Q3 Pipeline/i)
    fireEvent.change(input, { target: { value: 'ボード' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce())
  })
})
