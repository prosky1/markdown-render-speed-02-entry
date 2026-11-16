// Driver for this entry. The grader runs `node /bot/main.ts` (Node 22,
// which strips TypeScript types natively); the program reads every
// case from the input directory, renders each one on its own with
// parse() from parse.js, and writes the HTML strings out in order.
// Plain JavaScript throughout, standard library only.
//
// Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand
// in for /input and /output. The output directory is created if it is
// missing; nothing under it is ever removed (the grader runs as a
// user that cannot delete it). Rendering is deterministic: the same
// input always yields the same output file.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html = new Array(cases.length);
for (let k = 0; k < cases.length; k++) html[k] = parse(cases[k].markdown);
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
