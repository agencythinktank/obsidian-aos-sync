import { Client } from './api'

// Writing a client's name into a note, as lightly as it can be done.
//
// This is the one place the plugin edits a file somebody wrote, so every rule here exists to make
// that edit small, safe and reversible (Kaz, 09-25):
//
//   ONE property, not three. The id and the workspace live in the plugin's own data — carrying a
//   UUID in every note forever, to guard against a rename that may never happen, is a bad trade.
//   MERGE, never rewrite. Most real client notes already have frontmatter, and clobbering it
//   would be the one unforgivable bug here.
//   ALWAYS quote. A client called `Smith: & Co` breaks an unquoted YAML value and Obsidian then
//   flags the whole block as malformed.
//   WRITE ONCE. Only touch a file when the answer changes, so a synced vault never conflicts with
//   itself over a property nobody edited.

export const KEY = 'aos_client'

const quote = (v: string) => `"${String(v).replace(/"/g, '\\"')}"`

/** The frontmatter block, if there is one. */
function block(content: string): { body: string; rest: string } | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  return m ? { body: m[1], rest: content.slice(m[0].length) } : null
}

/**
 * Add or update `aos_client` on a note. Returns the content unchanged when it already says this,
 * so a run that changes nothing writes nothing.
 */
export function stamp(content: string, clientName: string): string {
  const line = `${KEY}: ${quote(clientName)}`
  const fm = block(content)

  if (!fm) return `---\n${line}\n---\n\n${content.replace(/^\s+/, '')}`

  const lines = fm.body.split(/\r?\n/)
  const at = lines.findIndex(l => new RegExp(`^${KEY}\\s*:`).test(l))
  if (at !== -1) {
    if (lines[at].trim() === line) return content          // already correct — do not touch it
    lines[at] = line
  } else {
    lines.push(line)
  }
  // The closing `---\n` already separates the block from the body. Adding another newline here
  // inserts a blank line into somebody's note every time the property is updated.
  return `---\n${lines.join('\n')}\n---\n${fm.rest}`
}

/** Take it back out, and take the block with it if nothing else was in there. */
export function unstamp(content: string): string {
  const fm = block(content)
  if (!fm) return content
  const kept = fm.body.split(/\r?\n/).filter(l => !new RegExp(`^${KEY}\\s*:`).test(l))
  // An empty block left behind is litter — and it is not what was there before.
  if (!kept.filter(l => l.trim()).length) return fm.rest.replace(/^\s*\n/, '')
  return `---\n${kept.join('\n')}\n---\n${fm.rest}`
}

export const hasStamp = (content: string) => {
  const fm = block(content)
  return !!fm && new RegExp(`^${KEY}\\s*:`, 'm').test(fm.body)
}

/**
 * Clients a name might plausibly mean, ranked, for a person to confirm.
 *
 * Deliberately NOT used to resolve anything on its own. Agency owners refer to a client by the
 * company or by their main contact, and informally either way — "Anna", "NDC", "the skincare one"
 * (Kaz, 09-25). Guessing between those files somebody's notes against the wrong client, which is
 * worse than not syncing them. So near matches become a question with one click to answer, and
 * only an exact match ever resolves silently.
 */
export function suggest(name: string, clients: Client[], limit = 3): Array<{ client: Client; why: string }> {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  const needle = norm(name)
  if (!needle) return []
  const words = needle.split(' ').filter(w => w.length > 2)

  const scored: Array<{ client: Client; score: number; why: string }> = []
  for (const c of clients) {
    const names = [c.name, ...(c.slugs || [])].filter(Boolean) as string[]
    let best = 0
    let why = ''
    for (const raw of names) {
      const hay = norm(raw)
      if (!hay) continue
      if (hay === needle) { best = 100; why = 'exact'; break }
      if (hay.startsWith(needle) || needle.startsWith(hay)) {
        // Deliberately does not claim WHICH name matched: the slugs hold the company and the
        // contact, normalised, so "Anna" hitting `annafrapwell` cannot honestly be described as
        // starting like "Neon Digital Clicks".
        if (best < 80) { best = 80; why = 'close to its name or contact' }
      }
      if (hay.includes(needle) || needle.includes(hay)) {
        if (best < 70) { best = 70; why = 'part of its name or contact' }
      }
      const shared = words.filter(w => hay.includes(w)).length
      if (shared && best < 40 + shared * 10) { best = 40 + shared * 10; why = 'shares a word with its name or contact' }
      // Initials: NDC → Neon Digital Clicks.
      const initials = hay.split(' ').map(w => w[0]).join('')
      if (initials.length > 1 && initials === needle.replace(/\s/g, '') && best < 75) {
        best = 75; why = 'the initials'
      }
    }
    if (best >= 40) scored.push({ client: c, score: best, why })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(({ client, why }) => ({ client, why }))
}
