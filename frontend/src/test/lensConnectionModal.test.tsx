import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LensConnectionModal from '../components/Board/LensConnectionModal'
import type { LensConnection } from '../types'

vi.mock('../api/gitLens', () => ({
  putLensConnection: vi.fn(),
  deleteLensConnection: vi.fn(),
}))

import { putLensConnection, deleteLensConnection } from '../api/gitLens'

const mockPut = putLensConnection as ReturnType<typeof vi.fn>
const mockDelete = deleteLensConnection as ReturnType<typeof vi.fn>

const savedConnection: LensConnection = {
  id: 1,
  provider: 'github',
  repo_slug: 'acme/widgets',
  column_dim: 'status',
  swimlane_dim: 'milestone',
  created_by: { id: 1, username: 'admin', display_name: 'Admin', avatar_url: '' },
  created_at: '2026-06-06T12:00:00Z',
  updated_at: '2026-06-06T12:00:00Z',
}

describe('LensConnectionModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('disables the Connect button until a valid owner/repo slug is entered', async () => {
    const user = userEvent.setup()
    render(
      <LensConnectionModal
        boardId={5}
        connection={null}
        onSaved={vi.fn()}
        onRemoved={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const connect = screen.getByRole('button', { name: 'Connect' })
    expect(connect).toBeDisabled()

    // A bare name without a slash is still invalid.
    await user.type(screen.getByLabelText('Repository'), 'widgets')
    expect(connect).toBeDisabled()

    // owner/repo becomes valid.
    await user.type(screen.getByLabelText('Repository'), '{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}acme/widgets')
    expect(connect).toBeEnabled()
  })

  it('submits a valid connection and calls onSaved', async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    mockPut.mockResolvedValue(savedConnection)
    render(
      <LensConnectionModal
        boardId={5}
        connection={null}
        onSaved={onSaved}
        onRemoved={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await user.type(screen.getByLabelText('Repository'), 'acme/widgets')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(mockPut).toHaveBeenCalledWith(5, {
      provider: 'github',
      repo_slug: 'acme/widgets',
      column_dim: 'status',
      swimlane_dim: 'milestone',
    }))
    expect(onSaved).toHaveBeenCalledWith(savedConnection)
  })

  it('surfaces a backend field error without closing', async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    mockPut.mockRejectedValue({
      isAxiosError: true,
      response: { status: 400, data: { repo_slug: ['Enter a public repository as owner/repo.'] } },
    })
    render(
      <LensConnectionModal
        boardId={5}
        connection={null}
        onSaved={onSaved}
        onRemoved={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await user.type(screen.getByLabelText('Repository'), 'acme/widgets')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByText('Enter a public repository as owner/repo.')).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('removes an existing connection and calls onRemoved', async () => {
    const user = userEvent.setup()
    const onRemoved = vi.fn()
    mockDelete.mockResolvedValue(undefined)
    render(
      <LensConnectionModal
        boardId={5}
        connection={savedConnection}
        onSaved={vi.fn()}
        onRemoved={onRemoved}
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Remove lens' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(5))
    expect(onRemoved).toHaveBeenCalled()
  })
})
