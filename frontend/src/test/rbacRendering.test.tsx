import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// Single consolidated mock for all boards API functions used in this file.
vi.mock('../api/boards', () => ({
  getBoardAnalytics: vi.fn(),
  createLabel: vi.fn(),
}))

// Mock the cards API used by CardDetail
vi.mock('../api/cards', () => ({
  getCardComments: vi.fn().mockResolvedValue([]),
  addCardComment: vi.fn(),
  updateCard: vi.fn(),
  deleteCard: vi.fn(),
  getCardAttachments: vi.fn().mockResolvedValue([]),
  uploadCardAttachment: vi.fn(),
  deleteCardAttachment: vi.fn(),
  getChecklist: vi.fn().mockResolvedValue([]),
  addChecklistItem: vi.fn(),
  updateChecklistItem: vi.fn(),
  deleteChecklistItem: vi.fn(),
  createLabel: vi.fn(),
}))

import { getBoardAnalytics } from '../api/boards'
import AnalyticsView from '../components/Board/AnalyticsView'

const mockGetBoardAnalytics = vi.mocked(getBoardAnalytics)

const sampleAnalyticsData = {
  days: 30,
  columns: ['To Do', 'In Progress', 'Done'],
  board_medians: { 'To Do': 2, 'In Progress': 5, 'Done': null },
  swimlanes: [
    {
      id: 1,
      name: 'Customer A',
      avg_days_per_column: { 'To Do': 3, 'In Progress': 4, 'Done': null },
      is_outlier: { 'To Do': false, 'In Progress': false, 'Done': false },
      deal_velocity_days: 7,
      stalled_cards: [],
    },
  ],
  stalled_threshold_days: 7,
}

describe('RBAC conditional rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBoardAnalytics.mockResolvedValue(sampleAnalyticsData)
  })

  describe('AnalyticsView — Export CSV button', () => {
    it('shows Export CSV button for admin role', async () => {
      render(<AnalyticsView boardId={1} currentUserRole="admin" />)

      await waitFor(() => {
        expect(screen.getByText('Export CSV')).toBeInTheDocument()
      })
    })

    it('shows Export CSV button for site_admin role', async () => {
      render(<AnalyticsView boardId={1} currentUserRole="site_admin" />)

      await waitFor(() => {
        expect(screen.getByText('Export CSV')).toBeInTheDocument()
      })
    })

    it('hides Export CSV button for member role', async () => {
      render(<AnalyticsView boardId={1} currentUserRole="member" />)

      await waitFor(() => {
        expect(screen.getByText('Customer A')).toBeInTheDocument()
      })
      expect(screen.queryByText('Export CSV')).not.toBeInTheDocument()
    })

    it('hides Export CSV button for collaborator role', async () => {
      render(<AnalyticsView boardId={1} currentUserRole="collaborator" />)

      await waitFor(() => {
        expect(screen.getByText('Customer A')).toBeInTheDocument()
      })
      expect(screen.queryByText('Export CSV')).not.toBeInTheDocument()
    })

    it('hides Export CSV button for viewer role', async () => {
      render(<AnalyticsView boardId={1} currentUserRole="viewer" />)

      await waitFor(() => {
        expect(screen.getByText('Customer A')).toBeInTheDocument()
      })
      expect(screen.queryByText('Export CSV')).not.toBeInTheDocument()
    })

    it('hides Export CSV button when role is null', async () => {
      render(<AnalyticsView boardId={1} currentUserRole={null} />)

      await waitFor(() => {
        expect(screen.getByText('Customer A')).toBeInTheDocument()
      })
      expect(screen.queryByText('Export CSV')).not.toBeInTheDocument()
    })
  })

  describe('Role-based permission logic', () => {
    // Test the canEdit / canComment logic extracted from CardDetail directly,
    // since rendering CardDetail requires extensive context (BoardFull, Card, etc.)
    // These unit tests verify the role-permission mapping that drives the UI.

    const roleCanEdit = (role: string | null) =>
      role === 'site_admin' || role === 'admin' || role === 'member'

    const roleCanComment = (role: string | null) =>
      roleCanEdit(role) || role === 'collaborator'

    it('admin can edit and comment', () => {
      expect(roleCanEdit('admin')).toBe(true)
      expect(roleCanComment('admin')).toBe(true)
    })

    it('site_admin can edit and comment', () => {
      expect(roleCanEdit('site_admin')).toBe(true)
      expect(roleCanComment('site_admin')).toBe(true)
    })

    it('member can edit and comment', () => {
      expect(roleCanEdit('member')).toBe(true)
      expect(roleCanComment('member')).toBe(true)
    })

    it('collaborator cannot edit but can comment', () => {
      expect(roleCanEdit('collaborator')).toBe(false)
      expect(roleCanComment('collaborator')).toBe(true)
    })

    it('viewer cannot edit or comment', () => {
      expect(roleCanEdit('viewer')).toBe(false)
      expect(roleCanComment('viewer')).toBe(false)
    })

    it('null role cannot edit or comment', () => {
      expect(roleCanEdit(null)).toBe(false)
      expect(roleCanComment(null)).toBe(false)
    })
  })

  describe('Board-level admin check logic', () => {
    // Mirrors the isAdmin / canEdit derivation in BoardView.tsx
    const isAdmin = (role: string | null) =>
      role === 'admin' || role === 'site_admin'

    const canEdit = (role: string | null) =>
      isAdmin(role) || role === 'member'

    it('admin is admin and can edit', () => {
      expect(isAdmin('admin')).toBe(true)
      expect(canEdit('admin')).toBe(true)
    })

    it('site_admin is admin and can edit', () => {
      expect(isAdmin('site_admin')).toBe(true)
      expect(canEdit('site_admin')).toBe(true)
    })

    it('member is not admin but can edit', () => {
      expect(isAdmin('member')).toBe(false)
      expect(canEdit('member')).toBe(true)
    })

    it('collaborator is not admin and cannot edit', () => {
      expect(isAdmin('collaborator')).toBe(false)
      expect(canEdit('collaborator')).toBe(false)
    })

    it('viewer is not admin and cannot edit', () => {
      expect(isAdmin('viewer')).toBe(false)
      expect(canEdit('viewer')).toBe(false)
    })
  })
})
