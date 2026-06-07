import { Hono } from 'hono';
import health from '@/routes/health';
import me from '@/routes/me';
import species from '@/routes/species';

export const routes = new Hono();
routes.route('/', health);
routes.route('/', me);
routes.route('/', species);
