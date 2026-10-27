import type { Client } from './api'

// Working out where the client notes are, and which client a name means, without asking.
//
// Kept free of the Obsidian API so it can be tested on its own. The vault is handed in as plain
// folder listings.
//
// Why this exists (Kaz, 10-27): the first agency to connect a real vault had its client folders
// at Work/Clients, the plugin looked for "Clients" at the top, and every sync stopped with
// nothing sent. The plugin already knows the agency's client list, so it can find the folder
// itself, and a person should only be asked about what it cannot settle.

export const slugOf = (x: string) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/** A client whose name or contact matches this exactly, ignoring case, spaces and punctuation. */
export function exactClient(name: string, clients: Client[]): Client | null {
  const s = slugOf(name)
  if (!s) return null
  return clients.find(c => c.slugs.includes(s)) || null
}

/** One folder in the vault: its path ('/' for the top) and the names directly inside it. */
export interface FolderListing { path: string; names: string[] }

const depth = (p: string) => (p === '/' || !p ? 0 : p.split('/').length)

/**
 * The folder holding the client notes: the one with the most entries named after a client.
 *
 * Counted by distinct client, so a folder with twelve files for one client does not beat a
 * folder with a subfolder for each of ten. A tie goes to the shallower folder, which is the one
 * that holds the others.
 */
export function pickRoot(folders: FolderListing[], clients: Client[]): { path: string; hits: number } | null {
  let best: { path: string; hits: number } | null = null
  for (const f of folders) {
    const ids = new Set<string>()
    for (const n of f.names) { const c = exactClient(n, clients); if (c) ids.add(c.id) }
    const hits = ids.size
    if (!hits) continue
    if (!best || hits > best.hits || (hits === best.hits && depth(f.path) < depth(best.path))) best = { path: f.path, hits }
  }
  return best
}

// Words that say what kind of company it is rather than which one. "MarketSparx" and
// "MarketSparx LLC" are the same client.
const FILLER = new Set(['the', 'of', 'and', 'inc', 'llc', 'ltd', 'limited', 'co', 'corp', 'company', 'srl', 'srls', 'gmbh', 'pty', 'plc', 'dba'])
const words = (x: string) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w && !FILLER.has(w))

/**
 * Does this folder or note name clearly mean this client? Judged on the client's own name only.
 *
 * Not on the contact's name: "Anna" could be the contact at one client and a team member at
 * another, and the existing rule (Kaz, 09-25) is that informal names become a question rather
 * than a guess. These three rules only fire when the name reads as a shorter form of the company:
 *
 *   same words once the filler is gone   "MarketSparx"     → "MarketSparx LLC"
 *   every word appears in the name       "Synergy Naples"  → "Synergy HomeCare of Naples"
 *   the name starts with it              "Williamson County" → "Williamson County Equipment Co"
 */
export function clearlyMeans(name: string, client: Client): string | null {
  const mine = words(name)
  const theirs = words(client.name)
  if (!mine.length || !theirs.length) return null
  if (mine.join(' ') === theirs.join(' ')) return 'the same name without Inc, LLC and the like'
  if (mine.length >= 2 && mine.every(w => theirs.includes(w))) return 'every word of it is in the client name'
  const start = theirs.slice(0, mine.length).join(' ')
  if (mine.join(' ') === start && mine.join('').length >= 6) return 'the client name starts with it'
  return null
}

/**
 * The one client a name clearly means, or nothing.
 *
 * Exactly one candidate or no answer at all: "Synergy" fits eight Synergy HomeCare locations and
 * is left for a person, and so is a name two clients share. Filing a client's notes under the
 * wrong client is worse than asking.
 */
export function autoPick(name: string, clients: Client[]): { client: Client; why: string } | null {
  const hits: Array<{ client: Client; why: string }> = []
  for (const c of clients) {
    const why = clearlyMeans(name, c)
    if (why) hits.push({ client: c, why })
  }
  return hits.length === 1 ? hits[0] : null
}
