import { App, Notice, Plugin, PluginSettingTab, Setting, TFolder, normalizePath } from 'obsidian'
import { AosApi, startAuth, pollAuth } from './api'
import { AosSettings, SyncState, DEFAULT_SETTINGS, DEFAULT_STATE } from './settings'
import { runSync } from './sync'

interface Stored { settings: AosSettings; state: SyncState }

export default class AosSyncPlugin extends Plugin {
  settings: AosSettings = DEFAULT_SETTINGS
  state: SyncState = DEFAULT_STATE
  private statusEl: HTMLElement | null = null
  private running = false

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
    if (this.state.lastError) { this.statusEl.setText('aOS: last sync failed'); return }
    this.statusEl.setText(this.state.lastRun ? `aOS: synced ${short(this.state.lastRun)}` : 'aOS: not synced yet')
  }

  api() { return new AosApi(this.settings.baseUrl.replace(/\/+$/, ''), this.settings.apiKey) }

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
      await this.save()
      // aOS's connector health reads this, which is what makes a sync that stopped visible to the
      // agency rather than only to whoever is sitting at this machine.
      await api.ack({ ok: true, pushed: res.pushed, pulled: res.pulled, skipped: res.skipped.length })

      if (manual) {
        const bits = [`${res.pushed} sent`, `${res.pulled} written`]
        if (res.conflicts.length) bits.push(`${res.conflicts.length} left alone (you have edited them)`)
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

    // --- connection ---
    if (!this.plugin.settings.apiKey) {
      new Setting(containerEl)
        .setName('Connect to Agency OS')
        .setDesc('Opens Agency OS in your browser. Approve it there and this plugin picks it up — you never copy a key.')
        .addButton(b => b.setButtonText('Connect').setCta().onClick(() => this.connect()))
    } else {
      new Setting(containerEl)
        .setName('Connected')
        .setDesc(this.plugin.settings.orgName ? `To ${this.plugin.settings.orgName}.` : 'To your Agency OS workspace.')
        .addButton(b => b.setButtonText('Disconnect').setWarning().onClick(async () => {
          this.plugin.settings.apiKey = ''
          this.plugin.settings.orgName = null
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

    new Setting(containerEl)
      .setName('Sync now')
      .addButton(b => b.setButtonText('Sync').onClick(() => this.plugin.sync(true)))

    if (this.plugin.state.lastError) {
      containerEl.createEl('p', { text: `Last sync failed: ${this.plugin.state.lastError}`, cls: 'setting-item-description' })
    }

    // --- folders that matched nothing ---
    this.renderUnmatched(containerEl)
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
