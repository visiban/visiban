import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConnectProviderModal from '../components/Auth/ConnectProviderModal'

const mockDismissPendingConnect = vi.fn()
const mockGetAuthProviders = vi.fn()
const mockStartProviderConnect = vi.fn()

vi.mock('../api/auth', () => ({
  dismissPendingConnect: () => mockDismissPendingConnect(),
  getAuthProviders: () => mockGetAuthProviders(),
}))

vi.mock('../utils/oauth', () => ({
  startProviderConnect: (...args: unknown[]) => mockStartProviderConnect(...args),
}))

describe('ConnectProviderModal (#1314)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDismissPendingConnect.mockResolvedValue({})
    mockGetAuthProviders.mockResolvedValue({ google: false, github: false, gitlab: false, oidc: true, oidc_name: 'Okta' })
  })

  it('asks to connect the pending provider, without a close button', () => {
    render(<ConnectProviderModal provider="github" identity={null} onDismissed={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Connect GitHub?')).toBeInTheDocument()
    expect(screen.getByText(/connect GitHub so you can use it to sign in next time/)).toBeInTheDocument()
    expect(screen.getByText('You can disconnect it anytime in Settings → Security.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument()
  })

  it('Connect starts the provider round trip and shows Connecting…', async () => {
    const user = userEvent.setup()
    render(<ConnectProviderModal provider="github" identity={null} onDismissed={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(mockStartProviderConnect).toHaveBeenCalledWith('github')
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled()
    expect(mockDismissPendingConnect).not.toHaveBeenCalled()
  })

  it('Not now closes immediately and clears the server-side prompt', async () => {
    const user = userEvent.setup()
    const onDismissed = vi.fn()
    render(<ConnectProviderModal provider="github" identity={null} onDismissed={onDismissed} />)
    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(onDismissed).toHaveBeenCalledTimes(1)
    expect(mockDismissPendingConnect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a failed dismiss call never blocks closing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockDismissPendingConnect.mockRejectedValue(new Error('offline'))
    const user = userEvent.setup()
    const onDismissed = vi.fn()
    render(<ConnectProviderModal provider="github" identity={null} onDismissed={onDismissed} />)
    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(onDismissed).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(warn).toHaveBeenCalled())
    warn.mockRestore()
  })

  it('does not use browser storage for the "shown once" rule', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const user = userEvent.setup()
    render(<ConnectProviderModal provider="github" identity={null} onDismissed={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })

  it('names the provider account that tried, so an unfamiliar one can be declined', () => {
    render(<ConnectProviderModal provider="github" identity="attacker-gh" onDismissed={vi.fn()} />)
    const line = screen.getByTestId('connect-provider-identity')
    expect(line).toHaveTextContent("You'll be able to sign in as attacker-gh on GitHub.")
    expect(line).toHaveTextContent("If you don't recognize this account, choose Not now.")
  })

  it('omits the identity line when the server sends none', () => {
    render(<ConnectProviderModal provider="github" identity={null} onDismissed={vi.fn()} />)
    expect(screen.queryByTestId('connect-provider-identity')).not.toBeInTheDocument()
  })

  it('names generic OIDC with the configured SSO name', async () => {
    render(<ConnectProviderModal provider="oidc" identity={null} onDismissed={vi.fn()} />)
    expect(await screen.findByText('Connect Okta?')).toBeInTheDocument()
  })
})
