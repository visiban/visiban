import { describe, it, expect, beforeEach } from 'vitest'
import type { InternalAxiosRequestConfig, AxiosHeaders } from 'axios'

// We test the interceptor logic by importing the client and inspecting its
// configuration.  The client module creates a real axios instance so we can
// exercise the request interceptor directly via `client.interceptors`.

describe('API client', () => {
  beforeEach(() => {
    // Clear any cookies between tests
    document.cookie = 'csrftoken=; Max-Age=0'
  })

  // Helper: dynamically import client to get a fresh reference each suite run.
  // Because the module is statically initialized we import once and reuse.
  async function getClient() {
    const mod = await import('../api/client')
    return mod.default
  }

  it('has baseURL defaulting to localhost:8000', async () => {
    const client = await getClient()
    // The env var VITE_API_URL is not set in test, so the fallback is used.
    expect(client.defaults.baseURL).toBe('http://localhost:8000')
  })

  it('has withCredentials enabled', async () => {
    const client = await getClient()
    expect(client.defaults.withCredentials).toBe(true)
  })

  it('has Content-Type application/json by default', async () => {
    const client = await getClient()
    expect(client.defaults.headers['Content-Type']).toBe('application/json')
  })

  describe('request interceptor', () => {
    it('deletes Content-Type header when data is FormData', async () => {
      const client = await getClient()
      // Build a minimal config that mimics what axios creates
      const config: InternalAxiosRequestConfig = {
        headers: { 'Content-Type': 'application/json' } as unknown as AxiosHeaders,
        data: new FormData(),
      }

      // Run the interceptor chain manually
      const handlers = (client.interceptors.request as unknown as { handlers: Array<{ fulfilled: (c: InternalAxiosRequestConfig) => InternalAxiosRequestConfig }> }).handlers
      let result = config
      for (const h of handlers) {
        if (h.fulfilled) result = h.fulfilled(result)
      }

      expect(result.headers['Content-Type']).toBeUndefined()
    })

    it('preserves Content-Type header for non-FormData requests', async () => {
      const client = await getClient()
      const config: InternalAxiosRequestConfig = {
        headers: { 'Content-Type': 'application/json' } as unknown as AxiosHeaders,
        data: { foo: 'bar' },
      }

      const handlers = (client.interceptors.request as unknown as { handlers: Array<{ fulfilled: (c: InternalAxiosRequestConfig) => InternalAxiosRequestConfig }> }).handlers
      let result = config
      for (const h of handlers) {
        if (h.fulfilled) result = h.fulfilled(result)
      }

      expect(result.headers['Content-Type']).toBe('application/json')
    })

    it('includes X-CSRFToken header when csrftoken cookie exists', async () => {
      document.cookie = 'csrftoken=abc123'
      const client = await getClient()
      const config: InternalAxiosRequestConfig = {
        headers: {} as unknown as AxiosHeaders,
        data: null,
      }

      const handlers = (client.interceptors.request as unknown as { handlers: Array<{ fulfilled: (c: InternalAxiosRequestConfig) => InternalAxiosRequestConfig }> }).handlers
      let result = config
      for (const h of handlers) {
        if (h.fulfilled) result = h.fulfilled(result)
      }

      expect(result.headers['X-CSRFToken']).toBe('abc123')
    })

    it('does not include X-CSRFToken when no csrftoken cookie', async () => {
      const client = await getClient()
      const config: InternalAxiosRequestConfig = {
        headers: {} as unknown as AxiosHeaders,
        data: null,
      }

      const handlers = (client.interceptors.request as unknown as { handlers: Array<{ fulfilled: (c: InternalAxiosRequestConfig) => InternalAxiosRequestConfig }> }).handlers
      let result = config
      for (const h of handlers) {
        if (h.fulfilled) result = h.fulfilled(result)
      }

      expect(result.headers['X-CSRFToken']).toBeUndefined()
    })
  })
})
