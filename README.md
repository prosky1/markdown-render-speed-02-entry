[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/prosky1/markdown-render-speed-02-entry/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02-entry

A fast drop-in replacement for **marked 18.1.3** (`parse.js`), written from scratch in plain Node.js — no dependencies, no WASM, no native addons.

## What it is

`parse.js` exports a single `parse(markdown)` function with the same public API as marked's `parse`. It implements CommonMark 0.31.2 + the GFM extensions marked ships (tables, strikethrough, task lists, autolinks) with a single-pass inline scanner and a container-stack block parser.

## Measured results (practice set, 720 cases)

| Check | Result |
|---|---|
| Byte-identical vs marked | 640 / 720 (88.9%) — **not yet complete** |
| CPU time, mine (n=7) | mean 344.0 ms, 95% CI ±31.8 ms |
| CPU time, marked (n=7) | mean 754.5 ms, 95% CI ±24.6 ms |
| Speedup vs marked | **2.19x** (95% CI 2.01x–2.42x) |

The entry is **2.19x faster than marked** with 95% confidence, but it is not yet byte-identical on all 720 cases, so it is **not submit-ready**. Remaining gaps are concentrated in the 40 generated documents (tab handling in code blocks, nested links, GFM autolink edge cases) — see `competition-intelligence/markdown-render-speed-02-experiments.md` in the workspace for the full ledger.

## Layout

- `parse.js` — the parser (single file, ~58 KB).
- `main.ts` — the harness driver (reads `/input/cases.json`, writes `/output/html.json`).
- `package.json` — `{"type":"module"}`.

## License

MIT. See `LICENSE`.
