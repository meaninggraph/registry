// Writes index.json from the records (CC0-1.0). CI fails when the committed
// index.json differs from what this writes.
//
//   node scripts/build-index.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, readRegistry } from './lib/registry.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
writeFileSync(join(root, 'index.json'), buildIndex(readRegistry(root)));
console.log('wrote index.json');
