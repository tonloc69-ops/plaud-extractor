import { fetch, type RequestInit, type Response } from 'undici'
import { ApiError, AuthError } from '../errors.js'
import { getLogger } from '../logger.js'
import type { StoredCredentials } from '../auth/types.js'
import { cookieHeader } from '../auth/token-store.js'

// Browser-like headers that Plaud's API validates.
// app-platform and edit-from are required custom headers.
const STATIC_HEADERS = {
  'Accept': 'application/json, */*',
  'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
  'Origin': 'https://web.plaud.ai',
  'Referer': 'https://web.plaud.ai/',
  'app-platform': 'web',
  'edit-from': 'web',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
}

export class HttpClient {
  constructor(private readonly creds: StoredCredentials) {}

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...STATIC_HEADERS,
      'Cookie': cookieHeader(this.creds),
    }
    if (this.creds.authToken) {
      // Plaud API expects lowercase 'bearer' (per arbuzmell/plaud-api reference client)
      headers['Authorization'] = `bearer ${this.creds.authToken}`
    }
    return headers
  }

  async get<T>(url: string, init?: RequestInit): Promise<T> {
    const log = getLogger()
    log.debug({ url }, 'GET')

    const res = await fetch(url, {
      ...init,
      method: 'GET',
      headers: { ...this.buildHeaders(), ...(init?.headers as Record<string, string> | undefined) },
    })

    await this.assertOk(res, url)
    return res.json() as Promise<T>
  }

  async post<T>(url: string, body: unknown, init?: RequestInit): Promise<T> {
    const log = getLogger()
    log.debug({ url }, 'POST')

    const res = await fetch(url, {
      ...init,
      method: 'POST',
      headers: { ...this.buildHeaders(), ...(init?.headers as Record<string, string> | undefined) },
      body: JSON.stringify(body),
    })

    await this.assertOk(res, url)
    return res.json() as Promise<T>
  }

  async getStream(url: string): Promise<AsyncIterable<Uint8Array>> {
    const log = getLogger()
    log.debug({ url }, 'GET (stream)')

    const res = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
    })

    await this.assertOk(res, url)

    if (!res.body) {
      throw new ApiError(`No response body from ${url}`, res.status)
    }

    return res.body as unknown as AsyncIterable<Uint8Array>
  }

  async patch<T>(url: string, body: unknown, init?: RequestInit): Promise<T> {
    const log = getLogger()
    log.debug({ url }, 'PATCH')

    const res = await fetch(url, {
      ...init,
      method: 'PATCH',
      headers: { ...this.buildHeaders(), ...(init?.headers as Record<string, string> | undefined) },
      body: JSON.stringify(body),
    })

    await this.assertOk(res, url)
    return res.json() as Promise<T>
  }

  /**
   * PUT raw bytes to an external URL (e.g. S3 presigned upload).
   * No Plaud auth headers - S3 presigned URLs reject extra headers.
   * Returns the Response so callers can read ETag etc.
   */
  async putRaw(url: string, body: Buffer, headers?: Record<string, string>): Promise<Response> {
    const log = getLogger()
    log.debug({ url: url.split('?')[0] }, 'PUT (raw)')

    const res = await fetch(url, {
      method: 'PUT',
      headers: headers ?? {},
      body,
    })

    await this.assertOk(res, url)
    return res
  }

  /**
   * Download from an external URL (e.g. presigned S3) without Plaud auth headers.
   * S3 presigned URLs sign only the `host` header — sending extra headers breaks the request.
   */
  async downloadExternalUrl(url: string): Promise<AsyncIterable<Uint8Array>> {
    const log = getLogger()
    log.debug({ url: url.split('?')[0] }, 'GET (external)')

    const res = await fetch(url, { method: 'GET' })
    await this.assertOk(res, url)

    if (!res.body) {
      throw new ApiError(`No response body from external URL`, res.status)
    }

    return res.body as unknown as AsyncIterable<Uint8Array>
  }

  private async assertOk(res: Response, url: string): Promise<void> {
    if (res.ok) return

    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`Auth failed for ${url} (${res.status}) — run 'alta-plaud auth' to re-authenticate`)
    }

    throw new ApiError(`HTTP ${res.status} for ${url}`, res.status)
  }
}
