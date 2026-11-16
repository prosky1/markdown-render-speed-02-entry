// Entry driver: render each input case with parse() and write the HTML
// array out. The grader invokes `node /bot/main.ts` (node 22, no
// network); inside the container the case file lives under /input and
// the result goes under /output, while MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR let the same driver run outside a container.
// Standard library only, no dependencies, deterministic output: the
// same input always produces the same bytes, in the same order.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw);
const out = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  out[i] = parse(cases[i].markdown);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
