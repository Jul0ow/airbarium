import { Hono } from 'hono';
import health from '@/routes/health';
import me from '@/routes/me';

export const routes = new Hono();
routes.route('/', health);
routes.route('/', me);
