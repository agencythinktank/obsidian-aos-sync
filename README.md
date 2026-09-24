# Agency OS Sync for Obsidian

Keeps your client folders and [Agency OS](https://aos.agencythinktank.com) in step.

- **Sends your client notes to Agency OS**, where they are filed as history and used as context for the summaries, briefs and client updates it writes.
- **Writes what Agency OS produces back into your vault** — the current state of each client, the arc of the relationship, and the updates you sent — into a folder Agency OS owns inside each client folder.

You need an Agency OS account. This plugin is no use without one.

## Network use and your data

**This plugin sends the contents of your client note files to Agency OS**, at the address configured in its settings (by default `https://aos.agencythinktank.com`). That is the entire point of it, and you should know exactly what that means before you turn it on:

- Only files inside the client folder you nominate are sent, and only those in folders that match one of your Agency OS clients. Everything else in your vault is never read.
- Files inside the folder Agency OS writes into are never sent back to it.
- Your Agency OS workspace decides the direction. If your agency has set it to *write only*, this plugin cannot send anything, whatever you switch on here.
- The plugin holds one API key, obtained by approving it in Agency OS. It is stored in this plugin's own data file in your vault.
- **No analytics or telemetry of any kind are collected by this plugin.** Agency OS records that a sync happened, and how many documents moved, so your agency can see whether syncing has stopped. What Agency OS stores and for how long is described in its [privacy policy](https://aos.agencythinktank.com/privacy).

## Connecting

Settings → Agency OS Sync → **Connect**. Your browser opens Agency OS, shows a six-character code, and asks you to approve. Check that code matches the one the plugin showed you, approve it, and the plugin picks up the connection on its own. You never copy a key.

Approving requires permission to manage settings in your Agency OS workspace.

## How it avoids overwriting your work

Neither side overwrites the other.

Agency OS writes **only** inside its own folder (`aOS` by default, named by your agency). Before it replaces anything there, it checks whether the file still matches what it last wrote. **If you have edited it, your version stands** and the sync reports that it left it alone. Nothing outside that folder is ever written to.

Going the other way, your notes are filed in Agency OS as dated history. They cannot overwrite a client profile someone typed there.

## Folders that match no client

Folder names are matched to your Agency OS clients automatically. A folder that matches nothing is **reported, never guessed at** — filing one client's notes against another would be worse than not syncing them. Map it by hand in settings, or leave it out.

## Installing

Not yet in the community directory. Download the release, and put `main.js`, `manifest.json` and `styles.css` (if present) into `<your vault>/.obsidian/plugins/aos-sync/`, then enable it under Community plugins.

## Building it yourself

```
npm install
npm run build
```

## License

MIT.
