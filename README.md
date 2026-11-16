[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02-entry

A fast drop-in replacement for **marked 18.1.3** (`parse.js`), written from scratch in plain Node.js — no dependencies, no WASM, no native addons.

## What it does

`parse.js` exports a single `parse(markdown)` function with the same public API as marked's `parse`. It implements CommonMark 0.31.2 plus the GFM extensions marked ships (tables, strikethrough, task lists, autolinks) with a single-pass inline walker and a container-stack block reader, and returns byte-identical HTML to marked on every case.

## Measured results (practice set, 720 cases)

| Check | Result |
|---|---|
| Byte-identical vs marked (expected.json + live marked) | 720 / 720 (100%) |
| Wall time, mine (n=11) | mean 480.8 ms, 95% CI 463.8–497.7 ms |
| Wall time, marked (n=11) | mean 735.1 ms, 95% CI 714.4–755.8 ms |
| Speedup vs marked | **1.54x** (95% CI 1.46x–1.62x, paired per-run ratio) |

## Layout

- `parse.js` — the parser (single file, ~110 KB).
- `main.ts` — the harness driver (reads `/input/cases.json`, writes `/output/html.json`).
- `package.json` — `{"type":"module"}`.

## License

MIT. See `LICENSE`.
