import { Hono } from 'hono';
import type { AppEnv } from '@/app-env';
import { register } from '@/lib/metrics';

// Prometheus scrape endpoint. Mounted at the root (NOT under /v1, per design
// §6.7) and public — Prometheus scrapes it inside the cluster network.
const route = new Hono<AppEnv>();

route.get('/metrics', async (c) => {
  const body = await register.metrics();
  return c.body(body, 200, { 'Content-Type': register.contentType });
});

export default route;
