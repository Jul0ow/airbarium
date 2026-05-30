import { Hono } from 'hono';

const route = new Hono();

// Lot 1: returns { status: 'ok' } only. The `db` (Lot 2), `garage` (Lot 4) and
// `plantnet` (Lot 5) probes are added incrementally per spec §10.3.
route.get('/health', (c) => c.json({ status: 'ok' }));

export default route;
