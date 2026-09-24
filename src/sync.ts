import { App, TFile, TFolder, normalizePath } from 'obsidian'
import { AosApi, Client, Config, PushDoc } from './api'
import { AosSettings, SyncState } from './settings'

// The two directions.
//
// THE RULE BOTH OF THEM KEEP: neither side overwrites the other's work.
//
//   Pushing sends a copy. aOS files it as history and cannot touch anything a person typed there.
//   Pulling writes ONLY inside the folder aOS owns, and even there it re-hashes the file first —
//   if you have edited what aOS wrote, it leaves your version alone and says so rather than
//   quietly replacing it. That is the same protection Readwise's plugin uses, and it is the whole
//   reason this is safe to run on a schedule.

/** Cheap, stable, and enough to answer "has this changed since I last saw it". */
export function hash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

const slugOf = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * The line that divides a file in two.
 *
 * Above it is aOS's, regenerated every sync. Below it is yours, and aOS never reads, moves or
 * rewrites it. This is the same answer the rest of the product gives — ONE OWNER PER SECTION,
 * not per document — rather than a merge that has to guess which words somebody added.
 */
// Matched to what the Client Vault already does, rather than invented (Kaz, 09-24: this is how
// we solved it in Obsidian so we could keep our own notes). Two conventions are live in real
// client files and BOTH are honoured, so a vault already using either is protected the first time
// this plugin runs, without anybody editing anything to make it so:
//
//   `## Notes`            - the heading in nine live client wiki files
//   `<!-- PROTECTED ...`  - the explicit marker on Two Minute Reports' profile
//
// New files use `## Notes` with the marker above it, so the two converge rather than a third
// convention being added to a vault that already has enough.
export const YOURS = '## Notes'
const PROTECTED_MARK = '<!-- PROTECTED'
// In the real files the heading sits ABOVE the marker, so honouring only the marker would leave
// the heading on aOS's side of the line and rewrite it away.
const PROTECTED_HEADING = '## Protected Notes'
const YOURS_HINT = PROTECTED_MARK + ' - Agency OS never writes below this line. Human only. -->\n' + YOURS + '\n\n'

/**
 * Split a file into what aOS wrote and what a person owns underneath.
 *
 * Whichever boundary appears FIRST wins, so a file carrying both markers never leaves an earlier
 * human section stranded on aOS's side of the line.
 */
export function splitOwnership(content: string): { aos: string; yours: string } {
  const found = [content.indexOf(PROTECTED_MARK), content.indexOf(PROTECTED_HEADING), content.indexOf(YOURS)]
    .filter(i => i !== -1)
  if (!found.length) return { aos: content, yours: '' }
  const at = Math.min.apply(null, found)
  return { aos: content.slice(0, at).trimEnd(), yours: content.slice(at).trimEnd() }
}

export interface RunResult {
  pushed: number
  pulled: number
  skipped: string[]
  conflicts: string[]
  unmatched: string[]
}

/** Every markdown file under a client's folder, excluding the folder aOS writes into. */
function filesUnder(app: App, folder: TFolder, exclude: string): TFile[] {
  const out: TFile[] = []
  const walk = (f: TFolder) => {
    for (const child of f.children) {
      if (child instanceof TFolder) {
        // Never send aOS its own output back to it — that is how a sync loop starts.
        if (child.name === exclude) continue
        walk(child)
      } else if (child instanceof TFile && child.extension === 'md') {
        out.push(child)
      }
    }
  }
  walk(folder)
  return out
}

export async function runSync(
  app: App,
  api: AosApi,
  settings: AosSettings,
  state: SyncState,
  onProgress?: (msg: string) => void,
): Promise<RunResult> {
  const result: RunResult = { pushed: 0, pulled: 0, skipped: [], conflicts: [], unmatched: [] }

  onProgress?.('Checking what this workspace allows…')
  const config: Config = await api.config()
  if (config.direction === 'off') {
    result.skipped.push('Vault sync is paused for this workspace.')
    return result
  }

  const clients = await api.clients()
  const root = app.vault.getAbstractFileByPath(normalizePath(settings.clientRoot))
  if (!(root instanceof TFolder)) {
    throw new Error(`No folder at "${settings.clientRoot}". Set the client folder in the plugin settings.`)
  }

  // Match a vault folder to a client: an explicit mapping the person made wins, then aOS's own
  // slugs. A folder that matches nothing is REPORTED, never guessed at — filing one client's
  // notes against another is worse than not syncing them.
  const byFolder = new Map<string, Client>()
  for (const child of root.children) {
    if (!(child instanceof TFolder)) continue
    const mapped = settings.folderMap[child.name]
    const client = mapped
      ? clients.find(c => c.id === mapped)
      : clients.find(c => c.slugs.includes(slugOf(child.name)))
    if (client) byFolder.set(child.name, client)
    else result.unmatched.push(child.name)
  }

  // ---- push --------------------------------------------------------------------------------
  if (config.may_push && settings.push) {
    const docs: PushDoc[] = []
    for (const [folderName, client] of byFolder) {
      const folder = root.children.find(c => c.name === folderName) as TFolder
      for (const file of filesUnder(app, folder, config.write_into)) {
        const body = await app.vault.cachedRead(file)
        const h = hash(body)
        // Unchanged files cost nothing. Without this, every run re-sends the whole vault.
        if (state.pushed[file.path] === h) continue
        docs.push({
          client_id: client.id,
          path: file.path,
          body,
          occurred_at: new Date(file.stat.mtime).toISOString().slice(0, 10),
        })
      }
    }

    for (let i = 0; i < docs.length; i += 50) {
      const batch = docs.slice(i, i + 50)
      onProgress?.(`Sending ${i + 1}–${i + batch.length} of ${docs.length}…`)
      const res = await api.push(batch)
      result.skipped.push(...res.skipped)
      // Only remember a file as sent once aOS has actually taken it.
      const refused = new Set(res.skipped.map(s => String(s).split(':')[0]))
      for (const d of batch) {
        if (refused.has(d.path)) continue
        state.pushed[d.path] = hash(d.body)
        result.pushed += 1
      }
    }
  }

  // ---- pull --------------------------------------------------------------------------------
  if (config.may_pull && settings.pull) {
    for (const [folderName, client] of byFolder) {
      onProgress?.(`Fetching ${client.name}…`)
      const data = await api.pull(client.id, settings.pullSince || undefined)
      const dir = normalizePath(`${settings.clientRoot}/${folderName}/${config.write_into}`)

      const notes: Array<{ name: string; body: string }> = []
      if (data.summary) {
        notes.push({
          name: 'Where they are now',
          body: `${data.summary.body}\n\n---\n*${data.summary.provenance || `Updated ${data.summary.updated}`}*\n`,
        })
      }
      if (data.arc.length) {
        notes.push({
          name: 'The arc',
          body: data.arc.map(a => `## ${a.date} — ${a.title}\n\n${a.body}\n`).join('\n'),
        })
      }
      if (data.updates_sent.length) {
        notes.push({
          name: 'Updates sent',
          body: data.updates_sent.map(u => `## Sent ${u.sent_at}\n*Covering ${u.period.start} to ${u.period.end}*\n\n${u.body}\n`).join('\n---\n\n'),
        })
      }
      if (!notes.length) continue

      if (!(app.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
        await app.vault.createFolder(dir).catch(() => {})
      }

      for (const note of notes) {
        const path = normalizePath(`${dir}/${note.name}.md`)
        const header = '> [!info] Written by Agency OS\n'
          + '> This part is rewritten each sync. Add your own notes under "Notes" at the bottom\n'
          + '> and they are kept — aOS never touches anything below that line.\n\n'
        const content = header + note.body
        const existing = app.vault.getAbstractFileByPath(path)

        if (existing instanceof TFile) {
          const current = await app.vault.read(existing)
          // If the file no longer matches what aOS last wrote, a person has edited it. Their
          // version stands.
          //
          // But standing back forever and saying so once in a toast is its own failure: aOS keeps
          // producing new summaries, this copy stays frozen at the moment it was edited, and
          // months later somebody is reading something stale that looks current (Kaz, 09-24).
          //
          // So the newer version is written ALONGSIDE, in its own file. Nothing of theirs is
          // touched, nothing from aOS is lost, and the difference is visible in the folder rather
          // than only in a notice that has scrolled away.
          const split = splitOwnership(current)
          // Only aOS's half decides whether somebody has been editing ITS work. A person writing
          // under the line is the supported case, not a conflict — that is the entire point of
          // having a line.
          if (state.pulled[path] && hash(split.aos) !== state.pulled[path]) {
            result.conflicts.push(path)
            const asidePath = normalizePath(`${dir}/${note.name} (newer from aOS).md`)
            const aside = `> [!warning] You edited "${note.name}", so aOS stopped replacing it\n`
              + `> This is what aOS has now, kept separate so neither version is lost. Merge what you want\n`
              + `> into your own file, then use "Let aOS manage this again" in the plugin settings.\n\n`
              + note.body
            const existingAside = app.vault.getAbstractFileByPath(asidePath)
            if (existingAside instanceof TFile) {
              if (hash(await app.vault.read(existingAside)) !== hash(aside)) await app.vault.modify(existingAside, aside)
            } else {
              await app.vault.create(asidePath, aside)
            }
            // Remembered so the settings page can list it long after the notice has gone.
            state.conflicts = state.conflicts || {}
            state.conflicts[path] = { since: state.conflicts[path]?.since || new Date().toISOString(), aside: asidePath }
            continue
          }
          // Back in step: if it was in conflict and now matches again, stop reporting it.
          if (state.conflicts?.[path]) delete state.conflicts[path]
          // Their section is carried across verbatim onto the newly written aOS half.
          const merged = split.yours ? `${content.trimEnd()}\n\n${split.yours}\n` : content
          if (hash(current) === hash(merged)) continue
          await app.vault.modify(existing, merged)
        } else {
          await app.vault.create(path, content + `\n${YOURS_HINT}`)
        }
        // Hash only what aOS owns, so tomorrow's note under the line is not read as tampering.
        state.pulled[path] = hash(content.trimEnd())
        result.pulled += 1
      }
    }
  }

  return result
}
