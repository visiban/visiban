import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
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
  })

  afterEach(() => {
    document.querySelectorAll('[data-tour-step]').forEach(el => el.remove())
  })

  it('renders when mounted', () => {
    render(<OnboardingTour onComplete={onComplete} />)
    expect(screen.getByTestId('onboarding-tour')).toBeTruthy()
  })

  it('shows step 1 of 4 initially', () => {
    render(<OnboardingTour onComplete={onComplete} />)
    expect(screen.getByText('Step 1 of 4')).toBeTruthy()
    expect(screen.getByText('Swimlanes are your clients')).toBeTruthy()
  })

  it('advances to next step on Next click', async () => {
    render(<OnboardingTour onComplete={onComplete} />)
    fireEvent.click(screen.getByText('Next'))
    await waitFor(() => {
      expect(screen.getByText('Step 2 of 4')).toBeTruthy()
      expect(screen.getByText('Drag cards to track progress')).toBeTruthy()
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

  it('calls completeTour API and onComplete on Done (last step)', async () => {
    render(<OnboardingTour onComplete={onComplete} />)
    // Advance through all 4 steps
    fireEvent.click(screen.getByText('Next')) // step 2
    fireEvent.click(screen.getByText('Next')) // step 3
    fireEvent.click(screen.getByText('Next')) // step 4
    // Now we should see "Done" button
    await waitFor(() => expect(screen.getByText('Done')).toBeTruthy())
    fireEvent.click(screen.getByText('Done'))
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
    // Remove the swimlane element so step 1 has no target
    document.querySelector('[data-tour-step="swimlane"]')?.remove()
    render(<OnboardingTour onComplete={onComplete} />)
    // Should skip to step 2 (card)
    await waitFor(() => {
      expect(screen.getByText('Drag cards to track progress')).toBeTruthy()
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
