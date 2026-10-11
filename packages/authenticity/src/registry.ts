// The registry snapshot shipped with the package (data/registry.json, written by `pnpm refresh`).
import registry from '../data/registry.json' with { type: 'json' };
import { type Book, buildBook } from './book.js';
import type { RegistryData } from './types.js';

export const BUNDLED_REGISTRY = registry as unknown as RegistryData;

export function loadBundledBook(): Book {
  return buildBook(BUNDLED_REGISTRY);
}
