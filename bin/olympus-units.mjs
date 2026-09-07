#!/usr/bin/env node
// olympus-units — the units of one decision record, as the harness counts them.
//
//   olympus-units <file> [--json]
//
// One line per unit: the id, the line it starts on, its kind, and its first
// eight words. A seat answers this list by id, and the harness checks the
// answer against the same enumeration, so the seat and the check never count
// two different lists.
import { readFileSync } from 'node:fs';
import { recordUnits } from '../src/lanes/units.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const files = args.filter((arg) => !arg.startsWith('--'));
if (files.length !== 1) {
  console.error('olympus-units: one file path is required');
  process.exit(2);
}
if (args.some((arg) => arg.startsWith('--') && arg !== '--json')) {
  console.error(`olympus-units: unknown option: ${args.find((a) => a.startsWith('--') && a !== '--json')}`);
  process.exit(2);
}

let text;
try {
  text = readFileSync(files[0], 'utf8');
} catch (error) {
  console.error(`olympus-units: cannot read ${files[0]}: ${error.message}`);
  process.exit(2);
}

const units = recordUnits(text);
if (json) {
  console.log(JSON.stringify(units, null, 2));
} else {
  for (const unit of units) {
    console.log([unit.id, unit.line, unit.kind ?? '', unit.head].join('\t'));
  }
  console.log(`${units.length} units in ${files[0]}`);
}
