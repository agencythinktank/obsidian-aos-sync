# Contributing

Bug reports and suggestions are welcome as GitHub issues. Please say which Obsidian version you are on, what you expected, and what happened instead. Leave out client names and note contents: the plugin's behavior can almost always be shown with made-up folder names.

Pull requests are welcome for fixes. For anything larger, open an issue first so we can agree on the approach.

## Building

```
npm install
npm run build
```

`main.js` is built from `src/` by esbuild and attached to each GitHub release, and the release tag matches the `version` in `manifest.json`.
