// What the plugin remembers, and what it deliberately does not.
//
// The direction and the folder aOS writes into are NOT here: they live in aOS, are set once by
// the agency, and are enforced by its endpoints. A local copy could disagree with the server
// about what this plugin is allowed to do, and the version that matters is the server's.

export interface AosSettings {
  baseUrl: string
  /** From the device flow. The only secret this plugin holds. */
  apiKey: string
  orgName: string | null
  /** The folder in this vault that contains one folder per client. */
  clientRoot: string
  /** Turning a direction off locally is allowed; turning one ON that aOS forbids is not. */
  push: boolean
  pull: boolean
  /** Minutes. 0 means manual only. */
  interval: number
  syncOnStartup: boolean
  /** Only pull comms sent since this date, so a long history is not re-fetched forever. */
  pullSince: string
  /** Vault folder name → aOS client id, for folders whose name matches nothing. */
  folderMap: Record<string, string>
}

export const DEFAULT_SETTINGS: AosSettings = {
  baseUrl: 'https://aos.agencythinktank.com',
  apiKey: '',
  orgName: null,
  clientRoot: 'Clients',
  push: true,
  pull: true,
  // Hourly is what Readwise defaults to and it is frequent enough that nobody thinks about it.
  interval: 60,
  syncOnStartup: true,
  pullSince: '',
  folderMap: {},
}

/**
 * What was last sent and last written, by content hash.
 *
 * This is the whole conflict story. Push uses it so unchanged files cost nothing; pull uses it to
 * tell "aOS wrote this and nobody touched it" from "a person has edited this", and only ever
 * replaces the first kind.
 */
export interface SyncState {
  pushed: Record<string, string>
  pulled: Record<string, string>
  lastRun: string | null
  lastError: string | null
}

export const DEFAULT_STATE: SyncState = { pushed: {}, pulled: {}, lastRun: null, lastError: null }
