// Strict readers for response bodies. A field that is missing, of the wrong type or out of range throws; nothing is
// defaulted except where the API documents an empty value (the callers say so explicitly with `optional*`).

export class ShapeError extends Error {
  constructor(path: string, expected: string, got: unknown) {
    super(`${path}: expected ${expected}, got ${describe(got)}`);
    this.name = 'ShapeError';
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'string') return `string(${v.length})`;
  return typeof v;
}

export type Obj = Record<string, unknown>;

export function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ShapeError(path, 'object', v);
  return v as Obj;
}

export function str(v: unknown, path: string, opts: { nonEmpty?: boolean; max?: number } = {}): string {
  if (typeof v !== 'string') throw new ShapeError(path, 'string', v);
  if (opts.nonEmpty && v.length === 0) throw new ShapeError(path, 'non-empty string', v);
  if (v.length > (opts.max ?? 4096)) throw new ShapeError(path, `string of at most ${opts.max ?? 4096} characters`, v);
  return v;
}

/** The API documents empty strings for absent group names; an absent or null value reads as the empty string. */
export function optionalStr(v: unknown, path: string): string {
  return v === undefined || v === null ? '' : str(v, path);
}

/** A JSON number or a numeric string that is a safe, non-negative integer. */
export function nat(v: unknown, path: string): number {
  const n = typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new ShapeError(path, 'non-negative integer', v);
  return n;
}

export function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new ShapeError(path, 'boolean', v);
  return v;
}

export function strArray(v: unknown, path: string, max = 512): string[] {
  if (!Array.isArray(v)) throw new ShapeError(path, 'array', v);
  if (v.length > max) throw new ShapeError(path, `array of at most ${max}`, v);
  return v.map((x, i) => str(x, `${path}[${i}]`, { nonEmpty: true, max: 128 }));
}

export function oneOf<T extends number | string>(v: unknown, allowed: readonly T[], path: string): T {
  if (!allowed.includes(v as T)) throw new ShapeError(path, `one of ${allowed.join(', ')}`, v);
  return v as T;
}
