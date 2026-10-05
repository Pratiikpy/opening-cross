#!/usr/bin/env node
// opening-cross-conformance [vectors.json]
// Runs the verifier's reference implementation over the conformance vectors and exits non-zero on
// any mismatch. Third-party implementations import `runConformance` and pass their own function.
import { loadVectors, referenceImplementation, runConformance } from './conformance.js';

const vectors = loadVectors(process.argv[2]);
const failures = runConformance(vectors, referenceImplementation);
console.log(JSON.stringify({ schema: vectors.schema, cases: vectors.cases.length, failures: failures.length }));
for (const f of failures.slice(0, 10)) console.error(JSON.stringify(f));
process.exit(failures.length === 0 ? 0 : 1);
