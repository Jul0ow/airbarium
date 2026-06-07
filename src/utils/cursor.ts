export type CursorKey = 'collected_at' | 'created_at' | 'identified_name';

export type Cursor = {
  k: CursorKey;
  v: string;
  id: string;
};

const KEYS: CursorKey[] = ['collected_at', 'created_at', 'identified_name'];

export function encodeCursor(cursor: Cursor): string {
  const json = JSON.stringify(cursor);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  let json: string;
  try {
    json = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.k !== 'string' || typeof obj.v !== 'string' || typeof obj.id !== 'string') {
    return null;
  }
  if (!KEYS.includes(obj.k as CursorKey)) return null;
  return { k: obj.k as CursorKey, v: obj.v, id: obj.id };
}
