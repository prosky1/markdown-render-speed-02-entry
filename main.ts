// Driver for this entry: read every case, render each one alone with
// parse() from parse.js, and write the HTML strings out in order.
// The harness runs `node /bot/main.ts` (node22); outside a container the
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR variables stand in for /input
// and /output. Only the standard library is used.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html: string[] = [];
for (let i = 0; i < cases.length; i++) html.push(parse(cases[i].markdown));
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
