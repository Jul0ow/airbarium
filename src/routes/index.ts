import { Hono } from 'hono';
import health from '@/routes/health';

export const routes = new Hono();
routes.route('/', health);
