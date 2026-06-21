// Generates the committed openapi.json snapshot from the live app registry.
// Run via `bun run openapi:gen`. CI re-runs this and fails on a dirty diff so
// the committed contract never drifts from the code.
import { createApp } from '@/app';

const app = createApp();
const res = await app.request('/openapi.json');
if (res.status !== 200) {
  console.error(`openapi:gen failed — GET /openapi.json returned ${res.status}`);
  process.exit(1);
}

const doc = await res.json();
await Bun.write('openapi.json', `${JSON.stringify(doc, null, 2)}\n`);
console.log('openapi.json written');
