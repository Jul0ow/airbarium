import { Hono } from 'hono';
import health from '@/routes/health';
import identifications from '@/routes/identifications';
import me from '@/routes/me';
import species from '@/routes/species';
import specimens from '@/routes/specimens';

export const routes = new Hono();
routes.route('/', health);
routes.route('/', me);
routes.route('/', species);
routes.route('/', specimens);
routes.route('/', identifications);
