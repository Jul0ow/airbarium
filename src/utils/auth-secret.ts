import { randomBytes } from 'node:crypto';

export function generateAuthSecret(): string {
  return randomBytes(32).toString('hex');
}

if (import.meta.main) {
  console.log(generateAuthSecret());
}
