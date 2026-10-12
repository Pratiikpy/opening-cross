// Writes schemas/create-cross.schema.json from the schema in src/create-file.ts, which is the single source.
import { writeFileSync } from 'node:fs';
import { CREATE_SCHEMA } from '../src/create-file.js';

writeFileSync(new URL('../schemas/create-cross.schema.json', import.meta.url), `${JSON.stringify(CREATE_SCHEMA, null, 2)}\n`);
console.log('wrote schemas/create-cross.schema.json');
