import { Hono } from 'hono';
import type { AppEnv } from '@/app-env';
import { register } from '@/lib/metrics';

// Prometheus scrape endpoint. Mounted at the root (NOT under /v1, per design
// §6.7). It carries no auth at the app layer; exposure is contained at the infra
// layer instead — the HTTPRoute only routes /v1/* publicly (so / and /metrics
// are not reachable through the Gateway) and a default-deny NetworkPolicy limits
// who can reach the pod. Keep /metrics off any public path match.
const route = new Hono<AppEnv>();

route.get('/metrics', async (c) => {
  const body = await register.metrics();
  return c.body(body, 200, { 'Content-Type': register.contentType });
});

export default route;
