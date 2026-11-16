[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02-entry

A fast drop-in replacement for **marked 18.1.3** (`parse.js`), written from scratch in plain Node.js — no dependencies, no WASM, no native addons.

## What it does

`parse.js` exports a single `parse(markdown)` function with the same public API as marked's `parse`. It implements CommonMark 0.31.2 plus the GFM extensions marked ships (tables, strikethrough, task lists, autolinks) with a single-pass inline scanner and a container-stack block parser, and returns byte-identical HTML to marked on every case.

## Measured results (practice set, 720 cases)

| Check | Result |
|---|---|
| Byte-identical vs marked | 720 / 720 (100%) |
| CPU time, mine (n=15) | mean 493.3 ms, 95% CI ±26.5 ms |
| CPU time, marked (n=15) | mean 762.1 ms, 95% CI ±28.8 ms |
| Speedup vs marked | **1.55x** (95% CI 1.50x–1.60x) |

## Layout

- `parse.js` — the parser (single file, ~113 KB).
- `main.ts` — the harness driver (reads `/input/cases.json`, writes `/output/html.json`).
- `package.json` — `{"type":"module"}`.

## License

MIT. See `LICENSE`.
