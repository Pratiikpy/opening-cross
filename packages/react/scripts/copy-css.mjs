// Copies the stylesheet next to the compiled output, because tsc only emits scripts.
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
copyFileSync(new URL('../src/styles.css', import.meta.url), new URL('../dist/styles.css', import.meta.url));
