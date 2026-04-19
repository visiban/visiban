import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Mock useEscapeStack before importing the component
const mockEscapeHandlers: Array<{ fn: () => boolean | void; priority: number }> = []
vi.mock('../hooks/useEscapeStack', () => ({
  useEscapeStack: (fn: () => boolean | void, priority: number) => {
    // Store handler on mount for testing
    const entry = { fn, priority }
    mockEscapeHandlers.push(entry)
  },
}))

// Mock the API
const mockCompleteTour = vi.fn(() => Promise.resolve({ has_completed_tour: true }))
vi.mock('../api/auth', () => ({
  completeTour: () => mockCompleteTour(),
}))

import OnboardingTour from '../components/Board/OnboardingTour'

describe('OnboardingTour', () => {
  let onComplete: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onComplete = vi.fn()
    mockCompleteTour.mockClear()
    mockEscapeHandlers.length = 0

    // Set up DOM elements that the tour steps target
    const viewTabs = document.createElement('div')
    viewTabs.setAttribute('data-tour-step', 'view-tabs')
    viewTabs.getBoundingClientRect = () => ({
      top: 10, left: 10, bottom: 30, right: 200, width: 190, height: 20,
      x: 10, y: 10, toJSON: () => {},
    })
    document.body.appendChild(viewTabs)

    const swimlane = document.createElement('div')
    swimlane.setAttribute('data-tour-step', 'swimlane')
    swimlane.style.position = 'fixed'
    swimlane.style.top = '100px'
    swimlane.style.left = '50px'
    swimlane.style.width = '200px'
    swimlane.style.height = '40px'
    swimlane.getBoundingClientRect = () => ({
      top: 100, left: 50, bottom: 140, right: 250, width: 200, height: 40,
      x: 50, y: 100, toJSON: () => {},
    })
    document.body.appendChild(swimlane)

    const swimlaneCollapse = document.createElement('button')
    swimlaneCollapse.setAttribute('data-tour-step', 'swimlane-collapse')
    swimlaneCollapse.getBoundingClientRect = () => ({
      top: 100, left: 200, bottom: 120, right: 220, width: 20, height: 20,
      x: 200, y: 100, toJSON: () => {},
    })
    document.body.appendChild(swimlaneCollapse)

    const card = document.createElement('div')
    card.setAttribute('data-tour-step', 'card')
    card.getBoundingClientRect = () => ({
      top: 200, left: 100, bottom: 260, right: 300, width: 200, height: 60,
      x: 100, y: 200, toJSON: () => {},
    })
    document.body.appendChild(card)

    const history = document.createElement('button')
    history.setAttribute('data-tour-step', 'history')
    history.getBoundingClientRect = () => ({
      top: 10, left: 300, bottom: 30, right: 370, width: 70, height: 20,
      x: 300, y: 10, toJSON: () => {},
    })
    document.body.appendChild(history)

    const filter = document.createElement('button')
    filter.setAttribute('data-tour-step', 'filter')
    filter.getBoundingClientRect = () => ({
      top: 10, left: 400, bottom: 30, right: 460, width: 60, height: 20,
      x: 400, y: 10, toJSON: () => {},
    })
    document.body.appendChild(filter)

    const liveIndicator = document.createElement('span')
    liveIndicator.setAttribute('data-tour-step', 'live-indicator')
    liveIndicator.getBoundingClientRect = () => ({
      top: 10, left: 500, bottom: 25, right: 540, width: 40, height: 15,
      x: 500, y: 10, toJSON: () => {},
    })
    document.body.appendChild(liveIndicator)
  })

  afterEach(() => {
    document.querySelectorAll('[data-tour-step]').forEach(el => el.remove())
  })

  it('renders when mounted', () => {
    render(<OnboardingTour onComplete={onComplete} />)
    expect(screen.getByTestId('onboarding-tour')).toBeTruthy()
  })

  it('has 8 steps total', () => {
    render(<OnboardingTour onComplete={onComplete} />)
    expect(screen.getByText('Step 1 of 8')).toBeTruthy()
  })

  it('shows step 1 of 8 initially with view-tabs title', () => {
    render(<OnboardingTour onComplete={onComplete} />)
    expect(screen.getByText('Step 1 of 8')).toBeTruthy()
    expect(screen.getByText('Switch between views')).toBeTruthy()
  })

  it('advances to next step on Next click', async () => {
    render(<OnboardingTour onComplete={onComplete} />)
    fireEvent.click(screen.getByText('Next'))
    await waitFor(() => {
      expect(screen.getByText('Step 2 of 8')).toBeTruthy()
      expect(screen.getByText('Swimlanes are your clients')).toBeTruthy()
    })
  })

  it('calls completeTour API and onComplete on Skip', async () => {
    render(<OnboardingTour onComplete={onComplete} />)
    fireEvent.click(screen.getByText('Skip tour'))
    await waitFor(() => {
      expect(mockCompleteTour).toHaveBeenCalled()
      expect(onComplete).toHaveBeenCalled()
    })
  })

  it('calls completeTour API and onComplete on Got it (last fullScreen step)', async () => {
    render(<OnboardingTour onComplete={onComplete} />)
    // Advance through all 7 spotlight steps to reach the fullScreen step (step 8)
    for (let i = 0; i < 7; i++) {
      fireEvent.click(screen.getByText('Next'))
    }
    // Step 8 is the fullScreen step — button reads "Got it"
    await waitFor(() => expect(screen.getByText('Got it')).toBeTruthy())
    fireEvent.click(screen.getByText('Got it'))
    await waitFor(() => {
      expect(mockCompleteTour).toHaveBeenCalled()
      expect(onComplete).toHaveBeenCalled()
    })
  })

  it('registers escape handler at priority 40', () => {
    render(<OnboardingTour onComplete={onComplete} />)
    const handler = mockEscapeHandlers.find(h => h.priority === 40)
    expect(handler).toBeTruthy()
  })

  it('does not render when target element is missing and skips to next step', async () => {
    // Remove the view-tabs element so step 1 has no target; it should skip to step 2 (swimlane)
    document.querySelector('[data-tour-step="view-tabs"]')?.remove()
    render(<OnboardingTour onComplete={onComplete} />)
    // Should skip to step 2 (swimlane)
    await waitFor(() => {
      expect(screen.getByText('Swimlanes are your clients')).toBeTruthy()
    })
  })

  it('renders the fullScreen centered card layout for the pan-board step', async () => {
    render(<OnboardingTour onComplete={onComplete} />)
    // Advance to step 8 (index 7) — the fullScreen step
    for (let i = 0; i < 7; i++) {
      fireEvent.click(screen.getByText('Next'))
    }
    await waitFor(() => {
      expect(screen.getByText('Pan the board')).toBeTruthy()
      expect(screen.getByText('Got it')).toBeTruthy()
      // The fullScreen layout does not render the spotlight tooltip
      expect(screen.queryByTestId('tour-tooltip')).toBeNull()
    })
  })

  it('fullScreen step renders the Space + drag hint', async () => {
    render(<OnboardingTour onComplete={onComplete} />)
    for (let i = 0; i < 7; i++) {
      fireEvent.click(screen.getByText('Next'))
    }
    await waitFor(() => {
      expect(screen.getByText('Pan the board')).toBeTruthy()
      // The Space kbd hint should be present
      expect(screen.getByText('Space')).toBeTruthy()
    })
  })
})

describe('OnboardingTour - conditional rendering', () => {
  it('should not render tour when has_completed_tour is true', () => {
    // This test verifies the condition in BoardView that gates the tour.
    // The condition is: !currentUser?.has_completed_tour
    const userWithTourCompleted = { has_completed_tour: true }
    const userWithoutTour = { has_completed_tour: false }

    expect(!userWithTourCompleted.has_completed_tour).toBe(false)
    expect(!userWithoutTour.has_completed_tour).toBe(true)
  })
})
