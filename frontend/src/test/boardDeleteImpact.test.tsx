import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import BoardDeleteImpactNotice from '../components/Board/BoardDeleteImpact'
import { getBoardDeleteImpact } from '../api/boards'

vi.mock('../api/boards', () => ({ getBoardDeleteImpact: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('BoardDeleteImpactNotice (#2208)', () => {
  it('names the parent boards the deleter can open', async () => {
    vi.mocked(getBoardDeleteImpact).mockResolvedValue({ child_cards: 1, parent_boards: [{ id: 3, name: 'Pipeline' }, { id: 4, name: 'Sales' }], hidden_parent_boards: false, parent_cards: 0 })
    render(<BoardDeleteImpactNotice boardId={9} />)
    const note = await screen.findByTestId('board-delete-impact')
    expect(note).toHaveTextContent('1 card here is a child of cards on Pipeline and Sales. Those parents lose it from their rollups and Children tabs.')
    expect(getBoardDeleteImpact).toHaveBeenCalledWith(9)
  })

  it('never names a board the deleter cannot open', async () => {
    vi.mocked(getBoardDeleteImpact).mockResolvedValue({ child_cards: 3, parent_boards: [], hidden_parent_boards: true, parent_cards: 0 })
    render(<BoardDeleteImpactNotice boardId={9} />)
    expect(await screen.findByTestId('board-delete-impact')).toHaveTextContent("3 cards here are children of cards on another board you can't open.")
  })

  it('says parent cards keep their children as ordinary cards', async () => {
    vi.mocked(getBoardDeleteImpact).mockResolvedValue({ child_cards: 0, parent_boards: [], hidden_parent_boards: false, parent_cards: 2 })
    render(<BoardDeleteImpactNotice boardId={9} />)
    expect(await screen.findByTestId('board-delete-impact')).toHaveTextContent('2 cards here have children on other boards. They stay there as ordinary cards.')
  })

  it('renders nothing with no links, or when the read fails', async () => {
    vi.mocked(getBoardDeleteImpact).mockResolvedValueOnce({ child_cards: 0, parent_boards: [], hidden_parent_boards: false, parent_cards: 0 })
    const { rerender } = render(<BoardDeleteImpactNotice boardId={9} />)
    await waitFor(() => expect(getBoardDeleteImpact).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    vi.mocked(getBoardDeleteImpact).mockRejectedValueOnce(new Error('403'))
    rerender(<BoardDeleteImpactNotice boardId={10} />)
    await waitFor(() => expect(getBoardDeleteImpact).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('mounts a polite live region before the read resolves, then fills it', async () => {
    let resolve!: (v: never) => void
    vi.mocked(getBoardDeleteImpact).mockReturnValue(new Promise((r) => { resolve = r as never }))
    render(<BoardDeleteImpactNotice boardId={9} />)
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toBeEmptyDOMElement()
    resolve({ child_cards: 2, parent_boards: [], hidden_parent_boards: true, parent_cards: 0 } as never)
    expect(await screen.findByTestId('board-delete-impact')).toBeInTheDocument()
    expect(screen.getByRole('status')).toContainElement(screen.getByTestId('board-delete-impact'))
  })
})
