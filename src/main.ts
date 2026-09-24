import { App, Notice, Plugin, PluginSettingTab, Setting, TFolder, normalizePath } from 'obsidian'
import { AosApi, AuthError, startAuth, pollAuth } from './api'
import { AosSettings, SyncState, DEFAULT_SETTINGS, DEFAULT_STATE } from './settings'
import { runSync } from './sync'

interface Stored { settings: AosSettings; state: SyncState }

export default class AosSyncPlugin extends Plugin {
  settings: AosSettings = DEFAULT_SETTINGS
  state: SyncState = DEFAULT_STATE
  private statusEl: HTMLElement | null = null
  private running = false
  /** Whether the key aOS holds still matches ours. Checked, not assumed. */
  connection: 'unknown' | 'ok' | 'revoked' = 'unknown'

  async onload() {
    const stored = (await this.loadData()) as Partial<Stored> | null
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored?.settings)
    this.state = Object.assign({}, DEFAULT_STATE, stored?.state)

    this.statusEl = this.addStatusBarItem()
    this.paint()

    this.addCommand({ id: 'sync-now', name: 'Sync with Agency OS now', callback: () => this.sync(true) })
    this.addSettingTab(new AosSettingTab(this.app, this))

    // registerInterval so it is cleaned up on unload rather than left running.
    if (this.settings.interval > 0) {
      this.registerInterval(window.setInterval(() => this.sync(false), this.settings.interval * 60_000))
    }
    // Checked once on load, so a revoked connection is visible before anyone tries to use it.
    if (this.settings.apiKey) this.app.workspace.onLayoutReady(() => this.checkConnection())
    if (this.settings.syncOnStartup && this.settings.apiKey) {
      // After layout so a sync never competes with the vault finishing its own load.
      this.app.workspace.onLayoutReady(() => this.sync(false))
    }
  }

  async save() { await this.saveData({ settings: this.settings, state: this.state }) }

  private paint() {
    if (!this.statusEl) return
    if (!this.settings.apiKey) { this.statusEl.setText('aOS: not connected'); return }
    if (this.running) { this.statusEl.setText('aOS: syncing…'); return }
    if (this.connection === 'revoked') { this.statusEl.setText('aOS: connection revoked'); return }
    if (this.state.lastError) { this.statusEl.setText('aOS: last sync failed'); return }
    this.statusEl.setText(this.state.lastRun ? `aOS: synced ${short(this.state.lastRun)}` : 'aOS: not synced yet')
  }

  api() { return new AosApi(this.settings.baseUrl.replace(/\/+$/, ''), this.settings.apiKey) }

  /**
   * Ask aOS whether our key is still good.
   *
   * Without this the plugin reports "Connected" on the strength of holding a string, which stays
   * true after the key has been revoked at the other end — so somebody sees a healthy settings
   * page and a stale "synced 3d ago" while nothing has worked since.
   */
  async checkConnection(): Promise<void> {
    if (!this.settings.apiKey) { this.connection = 'unknown'; return }
    try {
      const cfg = await this.api().config()
      this.connection = 'ok'
      if (cfg.org?.name) this.settings.orgName = cfg.org.name
    } catch (err) {
      // Only an auth failure means revoked. Being offline is not the same thing and must not
      // tell somebody to reconnect a connection that is fine.
      if (err instanceof AuthError) this.connection = 'revoked'
    }
    this.paint()
  }

  async sync(manual: boolean) {
    if (this.running) return
    if (!this.settings.apiKey) { if (manual) new Notice('Connect to Agency OS first, in the plugin settings.'); return }
    this.running = true
    this.paint()
    const api = this.api()
    try {
      const res = await runSync(this.app, api, this.settings, this.state,
        manual ? (m) => this.statusEl?.setText(`aOS: ${m}`) : undefined)

      this.state.lastRun = new Date().toISOString()
      this.state.lastError = null
      this.connection = 'ok'
      await this.save()
      // aOS's connector health reads this, which is what makes a sync that stopped visible to the
      // agency rather than only to whoever is sitting at this machine.
      await api.ack({ ok: true, pushed: res.pushed, pulled: res.pulled, skipped: res.skipped.length })

      if (manual) {
        const bits = [`${res.pushed} sent`, `${res.pulled} written`]
        if (res.conflicts.length) bits.push(`${res.conflicts.length} left alone — aOS's newer version is beside each one`)
        if (res.unmatched.length) bits.push(`${res.unmatched.length} folder(s) matched no client`)
        new Notice(`Agency OS: ${bits.join(', ')}.`)
      }
      // Never silent, even on a scheduled run: a folder matching no client means a whole client's
      // notes are not syncing, and nobody would otherwise find out.
      if (res.unmatched.length) {
        new Notice(`Agency OS: no client matches ${res.unmatched.slice(0, 3).join(', ')}${res.unmatched.length > 3 ? '…' : ''}. Map them in settings.`, 8000)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A dead key is not a failed sync, and saying "sync failed" for it sends somebody looking
      // at their network instead of at their connection.
      if (err instanceof AuthError || /no longer valid|organization API key/i.test(message)) this.connection = 'revoked'
      this.state.lastError = message
      await this.save()
      await api.ack({ ok: false, error: message }).catch(() => {})
      if (manual) new Notice(`Agency OS sync failed: ${message}`, 8000)
    } finally {
      this.running = false
      this.paint()
    }
  }
}

const short = (iso: string) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`
}

class AosSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: AosSyncPlugin) { super(app, plugin) }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    // Opening this page is exactly when somebody wants the truth about the connection, so it is
    // re-checked here rather than trusted from load.
    if (this.plugin.settings.apiKey) {
      this.plugin.checkConnection().then(() => {
        // Only redraw if the answer changed the page, to avoid a visible flicker on every open.
        if (this.plugin.connection === 'revoked') this.display()
      })
    }

    // --- connection ---
    if (!this.plugin.settings.apiKey) {
      new Setting(containerEl)
        .setName('Connect to Agency OS')
        .setDesc('Opens Agency OS in your browser. Approve it there and this plugin picks it up — you never copy a key.')
        .addButton(b => b.setButtonText('Connect').setCta().onClick(() => this.connect()))
    } else if (this.plugin.connection === 'revoked') {
      // The state that used to be invisible: we hold a key, aOS does not recognise it.
      new Setting(containerEl)
        .setName('This connection was revoked')
        .setDesc('Agency OS no longer recognises this plugin — the key was revoked, or the workspace changed. Nothing will sync until you reconnect.')
        .addButton(b => b.setButtonText('Reconnect').setCta().onClick(async () => {
          this.plugin.settings.apiKey = ''
          this.plugin.settings.orgName = null
          this.plugin.connection = 'unknown'
          await this.plugin.save()
          this.display()
          // Actually reconnect, rather than swapping the panel for a Connect button and leaving
          // the person to press a second one. A button called Reconnect that only redraws the
          // page reads as a button that does nothing.
          await this.connect()
        }))
    } else {
      new Setting(containerEl)
        .setName(this.plugin.connection === 'ok' ? 'Connected' : 'Connected (not verified yet)')
        .setDesc(this.plugin.settings.orgName ? `To ${this.plugin.settings.orgName}.` : 'To your Agency OS workspace.')
        .addButton(b => b.setButtonText('Disconnect').setWarning().onClick(async () => {
          this.plugin.settings.apiKey = ''
          this.plugin.settings.orgName = null
          this.plugin.connection = 'unknown'
          await this.plugin.save()
          this.display()
        }))
    }

    new Setting(containerEl)
      .setName('Agency OS address')
      .setDesc('Only change this if your workspace is on a different domain.')
      .addText(t => t.setValue(this.plugin.settings.baseUrl).onChange(async v => {
        this.plugin.settings.baseUrl = v.trim(); await this.plugin.save()
      }))

    // --- what to sync ---
    new Setting(containerEl).setName('What to sync').setHeading()

    new Setting(containerEl)
      .setName('Client folder')
      .setDesc('The folder holding one folder per client. Folder names are matched to your clients in Agency OS.')
      .addText(t => t.setValue(this.plugin.settings.clientRoot).onChange(async v => {
        this.plugin.settings.clientRoot = v.trim(); await this.plugin.save()
      }))

    new Setting(containerEl)
      .setName('Send my notes to Agency OS')
      .setDesc('Your client files are filed there as history. They never overwrite anything written in Agency OS.')
      .addToggle(t => t.setValue(this.plugin.settings.push).onChange(async v => {
        this.plugin.settings.push = v; await this.plugin.save()
      }))

    new Setting(containerEl)
      .setName('Write Agency OS summaries into this vault')
      .setDesc('Into a folder Agency OS owns, inside each client folder. If you edit what it wrote, it stops replacing that file.')
      .addToggle(t => t.setValue(this.plugin.settings.pull).onChange(async v => {
        this.plugin.settings.pull = v; await this.plugin.save()
      }))

    containerEl.createEl('p', {
      text: 'Your agency also sets a direction in Agency OS. If it says pull only, this plugin cannot send anything, whatever is switched on here.',
      cls: 'setting-item-description',
    })

    // --- when ---
    new Setting(containerEl).setName('When').setHeading()

    new Setting(containerEl)
      .setName('Sync every')
      .addDropdown(d => d
        .addOptions({ '0': 'Manually', '30': '30 minutes', '60': 'Hour', '720': '12 hours', '1440': 'Day' })
        .setValue(String(this.plugin.settings.interval))
        .onChange(async v => {
          this.plugin.settings.interval = Number(v)
          await this.plugin.save()
          new Notice('Restart Obsidian for the new schedule to take effect.')
        }))

    new Setting(containerEl)
      .setName('Sync when Obsidian starts')
      .addToggle(t => t.setValue(this.plugin.settings.syncOnStartup).onChange(async v => {
        this.plugin.settings.syncOnStartup = v; await this.plugin.save()
      }))

    // The status bar is the obvious home for this and it is not a reliable one: plenty of themes
    // hide it, and Kaz could not find it at all (09-24). Anything somebody needs in order to trust
    // a background sync has to live somewhere a theme cannot remove.
    new Setting(containerEl)
      .setName('Sync now')
      .setDesc(this.lastRunLine())
      .addButton(b => b.setButtonText('Sync').onClick(async () => {
        await this.plugin.sync(true)
        this.display()
      }))

    if (this.plugin.state.lastError) {
      containerEl.createEl('p', { text: `Last sync failed: ${this.plugin.state.lastError}`, cls: 'setting-item-description' })
    }

    this.renderConflicts(containerEl)

    // --- folders that matched nothing ---
    this.renderUnmatched(containerEl)
  }

  /**
   * Files aOS has stopped updating, and the way back.
   *
   * Without this the only warning is a sync notice seen once. The consequence outlives it by
   * months: aOS keeps writing new summaries, this copy stays frozen, and it still looks like a
   * live document (Kaz, 09-24).
   */
  private renderConflicts(containerEl: HTMLElement) {
    const conflicts = this.plugin.state.conflicts || {}
    const paths = Object.keys(conflicts)
    if (!paths.length) return

    new Setting(containerEl).setName('Files Agency OS has stopped updating').setHeading()
    containerEl.createEl('p', {
      text: 'You edited these, so Agency OS leaves them alone. It keeps writing its newer version to a file beside each one, so nothing is lost either way.',
      cls: 'setting-item-description',
    })

    for (const path of paths) {
      const since = new Date(conflicts[path].since).toISOString().slice(0, 10)
      new Setting(containerEl)
        .setName(path.split('/').pop() || path)
        .setDesc(`In ${path.split('/').slice(0, -1).join('/')} — yours since ${since}.`)
        .addButton(b => b.setButtonText('Let aOS manage this again').onClick(async () => {
          // Deliberately destructive and said so: their version is replaced on the next sync.
          // Forgetting the hash is what makes aOS treat the file as its own again.
          delete this.plugin.state.pulled[path]
          const aside = this.app.vault.getAbstractFileByPath(conflicts[path].aside)
          if (aside) await this.app.fileManager.trashFile(aside)
          delete (this.plugin.state.conflicts || {})[path]
          await this.plugin.save()
          new Notice('Agency OS will overwrite that file on the next sync.')
          this.display()
        }))
    }
  }

  /** What happened last time, in words, wherever the status bar is or is not. */
  private lastRunLine(): string {
    const { lastRun, lastError, pushed, pulled } = this.plugin.state as any
    if (!lastRun) return 'Never synced.'
    const when = new Date(lastRun)
    const mins = Math.round((Date.now() - when.getTime()) / 60000)
    const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} minutes ago` : `${Math.round(mins / 60)} hours ago`
    if (lastError) return `Last tried ${ago} and failed: ${lastError}`
    const sent = Object.keys(pushed || {}).length
    const written = Object.keys(pulled || {}).length
    return `Last synced ${ago} — ${sent} file${sent === 1 ? '' : 's'} sent to Agency OS, ${written} written into this vault.`
  }

  /**
   * A folder whose name matches no client. Left to guesswork this silently stops a whole client
   * syncing, so it is surfaced with a picker rather than a warning nobody can act on.
   */
  private async renderUnmatched(containerEl: HTMLElement) {
    if (!this.plugin.settings.apiKey) return
    const root = this.app.vault.getAbstractFileByPath(normalizePath(this.plugin.settings.clientRoot))
    if (!(root instanceof TFolder)) return

    let clients
    try { clients = await this.plugin.api().clients() } catch { return }
    const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '')
    const unmatched = root.children.filter(c =>
      c instanceof TFolder
      && !this.plugin.settings.folderMap[c.name]
      && !clients.some(cl => cl.slugs.includes(slug(c.name))))

    if (!unmatched.length) return
    new Setting(containerEl).setName('Folders with no matching client').setHeading()
    for (const folder of unmatched) {
      new Setting(containerEl)
        .setName(folder.name)
        .addDropdown(d => {
          d.addOption('', 'Do not sync this folder')
          for (const c of clients) d.addOption(c.id, c.name)
          d.setValue('').onChange(async v => {
            if (v) this.plugin.settings.folderMap[folder.name] = v
            else delete this.plugin.settings.folderMap[folder.name]
            await this.plugin.save()
            this.display()
          })
        })
    }
  }

  /** The device flow: open the browser, poll until approved. */
  private async connect() {
    const base = this.plugin.settings.baseUrl.replace(/\/+$/, '')
    new Notice('Opening Agency OS to approve this connection…')
    let start
    try { start = await startAuth(base, `Obsidian — ${this.app.vault.getName()}`) }
    catch (err) { new Notice(`Could not reach Agency OS: ${err instanceof Error ? err.message : err}`); return }

    window.open(start.approve_url, '_blank')
    new Notice(`Approve the code ${start.user_code} in Agency OS.`, 10000)

    const until = new Date(start.expires_at).getTime()
    const tick = async () => {
      if (Date.now() > until) { new Notice('That connection request expired. Try again.'); return }
      let res
      try { res = await pollAuth(base, start.code) } catch { window.setTimeout(tick, 3000); return }
      if (res.status === 'pending') { window.setTimeout(tick, 2000); return }
      if (res.status === 'approved' && res.key) {
        this.plugin.settings.apiKey = res.key
        this.plugin.settings.orgName = res.org?.name || null
        await this.plugin.save()
        new Notice('Connected to Agency OS.')
        this.display()
        return
      }
      new Notice(res.status === 'denied' ? 'That request was refused in Agency OS.' : 'That request expired.')
    }
    window.setTimeout(tick, 2500)
  }
}
