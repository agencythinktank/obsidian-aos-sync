import { requestUrl, RequestUrlResponse } from 'obsidian'

// Every call aOS. `requestUrl` rather than `fetch` deliberately: it is Obsidian's own request
// API, it is not subject to the renderer's CORS rules, and it behaves the same on every platform.

export interface Config {
  org: { id: string; name: string | null }
  direction: 'both' | 'push' | 'pull' | 'off'
  may_push: boolean
  may_pull: boolean
  write_into: string
}

export interface Client {
  id: string
  name: string
  slugs: string[]
  active: boolean
  status: string | null
}

export interface PushDoc {
  client_id?: string
  path: string
  body: string
  occurred_at?: string
  title?: string
}

export interface PullResult {
  client: { id: string; name: string }
  summary: { body: string; provenance: string | null; updated: string } | null
  arc: Array<{ date: string; title: string; body: string }>
  updates_sent: Array<{ period: { start: string; end: string }; sent_at: string; body: string }>
  write_into: string
}

/** The key is dead. Separate from a network blip so the UI can say so and offer a reconnect. */
export class AuthError extends Error {
  readonly isAuthError = true
  constructor(message: string) { super(message); this.name = 'AuthError' }
}

export class AosApi {
  constructor(private baseUrl: string, private key: string) {}

  private async call(method: string, path: string, body?: unknown): Promise<RequestUrlResponse> {
    return requestUrl({
      url: `${this.baseUrl}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // We want to read the error body ourselves rather than have a 403 thrown at us: a refusal
      // because the agency set "pull only" is a normal answer, not a failure to report.
      throw: false,
    })
  }

  async config(): Promise<Config> {
    const res = await this.call('GET', '/api/plugin/config')
    // A 401 means the key itself is no longer good — revoked in aOS, or the workspace is gone.
    // Distinguished from any other failure because it is the one the user must act on, and the
    // one that otherwise hides: a plugin holding a dead key looks connected forever.
    if (res.status === 401) throw new AuthError(res.json?.error || 'This connection is no longer valid')
    if (res.status !== 200) throw new Error(res.json?.error || `aOS returned ${res.status}`)
    return res.json as Config
  }

  async clients(): Promise<Client[]> {
    const res = await this.call('GET', '/api/plugin/clients')
    if (res.status !== 200) throw new Error(res.json?.error || `aOS returned ${res.status}`)
    return (res.json?.clients || []) as Client[]
  }

  /** Returns what was filed, and what aOS refused with its reason. */
  async push(documents: PushDoc[]): Promise<{ saved: unknown[]; skipped: string[] }> {
    const res = await this.call('POST', '/api/client-context/sync', { documents })
    if (res.status === 403) throw new Error(res.json?.error || 'Pushing is switched off for this workspace')
    if (res.status !== 200) throw new Error(res.json?.error || `aOS returned ${res.status}`)
    return { saved: res.json?.saved || [], skipped: res.json?.skipped || [] }
  }

  async pull(clientId: string, since?: string): Promise<PullResult> {
    const q = since ? `&since=${encodeURIComponent(since)}` : ''
    const res = await this.call('GET', `/api/client-context/sync?client_id=${encodeURIComponent(clientId)}${q}`)
    if (res.status === 403) throw new Error(res.json?.error || 'Pulling is switched off for this workspace')
    if (res.status !== 200) throw new Error(res.json?.error || `aOS returned ${res.status}`)
    return res.json as PullResult
  }

  /** Tell aOS a run finished. This is what its connector health reads. */
  async ack(summary: { ok: boolean; pushed?: number; pulled?: number; skipped?: number; error?: string; conflicts?: string[]; unmatched?: string[] }): Promise<void> {
    await this.call('POST', '/api/client-context/sync/ack', summary)
  }
}

// --- the device flow, which needs no key ----------------------------------------------------

export interface AuthStart {
  code: string
  user_code: string
  approve_url: string
  expires_at: string
}

export async function startAuth(baseUrl: string, clientName: string): Promise<AuthStart> {
  const res = await requestUrl({
    url: `${baseUrl}/api/plugin/auth`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: clientName }),
    throw: false,
  })
  if (res.status !== 200) throw new Error(res.json?.error || `aOS returned ${res.status}`)
  return res.json as AuthStart
}

export async function pollAuth(baseUrl: string, code: string): Promise<{ status: string; key?: string; org?: { name: string | null } }> {
  const res = await requestUrl({
    url: `${baseUrl}/api/plugin/auth?code=${encodeURIComponent(code)}`,
    method: 'GET',
    throw: false,
  })
  if (res.status !== 200) throw new Error(`aOS returned ${res.status}`)
  return res.json
}
