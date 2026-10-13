// Writes docs/metrics/METRIC_SPECS.md from the registry.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderSpecs, validateRegistry } from '../src/specs.js';

const problems = validateRegistry();
if (problems.length) throw new Error(problems.join('\n'));
const target = fileURLToPath(new URL('../../../docs/metrics/METRIC_SPECS.md', import.meta.url));
writeFileSync(target, renderSpecs() + '\n');
console.log(`wrote ${target}`);
