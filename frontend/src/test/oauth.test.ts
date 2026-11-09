import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { providerLoginPath, providerLoginUrl, startProviderConnect } from '../utils/oauth'

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

function clearCsrfCookie() {
  document.cookie = 'csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
}

describe('providerLoginPath (#1988)', () => {
  it('special-cases oidc to allauth\'s oidc/<provider_id> prefix', () => {
    expect(providerLoginPath('oidc')).toBe('/accounts/oidc/oidc/login/')
  })

  it('uses /accounts/<provider>/login/ for other providers', () => {
    expect(providerLoginPath('github')).toBe('/accounts/github/login/')
  })

  it('applies encodeURIComponent to the provider id', () => {
    expect(providerLoginPath('a/b c')).toBe('/accounts/a%2Fb%20c/login/')
  })
})

describe('providerLoginUrl (#1988)', () => {
  it('is an absolute URL with process=login', () => {
    expect(providerLoginUrl('github')).toBe(`${API}/accounts/github/login/?process=login`)
    expect(providerLoginUrl('oidc')).toBe(`${API}/accounts/oidc/oidc/login/?process=login`)
  })
})

describe('startProviderConnect (#1988)', () => {
  let submitted: HTMLFormElement[]
  let submitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    submitted = []
    // jsdom does not implement navigation; capture the form instead.
    submitSpy = vi
      .spyOn(HTMLFormElement.prototype, 'submit')
      .mockImplementation(function (this: HTMLFormElement) {
        submitted.push(this)
      })
    document.body.innerHTML = ''
    clearCsrfCookie()
  })

  afterEach(() => {
    submitSpy.mockRestore()
    clearCsrfCookie()
    document.body.innerHTML = ''
  })

  it('submits a hidden POST form to process=connect with the CSRF token', () => {
    document.cookie = 'csrftoken=tok123; path=/'
    startProviderConnect('github')

    expect(submitted).toHaveLength(1)
    const form = submitted[0]
    expect(form.method.toLowerCase()).toBe('post')
    expect(form.getAttribute('action')).toBe(`${API}/accounts/github/login/?process=connect`)
    expect(form.style.display).toBe('none')
    expect(document.body.contains(form)).toBe(true)

    const input = form.querySelector('input[name="csrfmiddlewaretoken"]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.type).toBe('hidden')
    expect(input.value).toBe('tok123')
  })

  it('reads the token when csrftoken is not the first cookie', () => {
    document.cookie = 'other=1; path=/'
    document.cookie = 'csrftoken=second; path=/'
    startProviderConnect('github')
    const input = submitted[0].querySelector('input[name="csrfmiddlewaretoken"]') as HTMLInputElement
    expect(input.value).toBe('second')
  })

  it('omits the CSRF input when there is no csrftoken cookie', () => {
    startProviderConnect('github')
    expect(submitted).toHaveLength(1)
    expect(submitted[0].querySelector('input[name="csrfmiddlewaretoken"]')).toBeNull()
  })

  it('uses the oidc/oidc path for the generic OIDC provider', () => {
    startProviderConnect('oidc')
    expect(submitted[0].getAttribute('action')).toBe(
      `${API}/accounts/oidc/oidc/login/?process=connect`,
    )
  })

  it('encodes the provider id in the action', () => {
    startProviderConnect('a/b c')
    expect(submitted[0].getAttribute('action')).toBe(
      `${API}/accounts/a%2Fb%20c/login/?process=connect`,
    )
  })
})
