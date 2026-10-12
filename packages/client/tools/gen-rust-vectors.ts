// Writes the vectors the Rust SDK is tested against. Run from the repository root:
//   pnpm --filter @opening-cross/client vectors
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildVectors } from './vectors.js';

const out = process.argv[2] ?? fileURLToPath(new URL('../../../crates/opening-cross-sdk/tests/vectors/ts-vectors.json', import.meta.url));
const vectors = await buildVectors();
writeFileSync(out, `${JSON.stringify(vectors, null, 1)}
`);
console.log(`wrote ${out}: ${vectors.pda.length} addresses, ${vectors.shardIndex.length} shard indexes, ${vectors.commitments.length} commitments, ${vectors.instructions.length} instruction groups`);
