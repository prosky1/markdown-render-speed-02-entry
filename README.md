[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02-entry

A drop-in replacement for **marked 18.1.3** (`parse.js`), written from scratch in plain Node.js in a single recorded session — no dependencies, no WASM, no native addons. It implements CommonMark 0.31.2 plus the GFM extensions marked ships (tables, strikethrough, task lists, autolinks).

## What it does

`parse.js` exports a single `parse(markdown)` function with the same public API as marked's `parse`. A single-pass inline scanner plus a container-stack block parser renders each input to HTML. `main.ts` is the harness driver: it reads `/input/cases.json` (or `MAKEFUN_INPUT_DIR` outside a container), renders each case alone with `parse`, and writes the HTML strings in order to `/output/html.json` (`MAKEFUN_OUTPUT_DIR` outside a container).

## Measured results (practice set, 720 cases, round-2 rebuild)

| Check | Result |
|---|---|
| Byte-identical vs marked | 710 / 720 (98.6%) — 10 full documents differ |
| CPU time, mine (n=9, trimmed) | mean 9784.5 ms, 95% CI [9700.8, 9868.2] ms |
| CPU time, marked (n=9, trimmed) | mean 729.5 ms, 95% CI [696.8, 762.2] ms |
| Speedup vs marked | 0.07x (95% CI 0.07x–0.08x) — slower than marked |

Status: **work in progress, not submit-ready.** The 10 differing documents are context-dependent inline cases (emphasis/autolink suppression inside nested containers), and the parser is currently slower than the baseline, so a performance pass is still needed before this entry can compete. The numbers above are the honest measurements for this commit; see the repo history for the earlier round-1 build.

## Layout

- `parse.js` — the parser (single file, ~79 KB, under the 1 MiB limit).
- `main.ts` — the harness driver (reads `/input/cases.json`, writes `/output/html.json`).
- `package.json` — `{"type":"module"}`.
- `.makefun/owner.json` — the entry owner's wallet.

## License

MIT. See `LICENSE`.
