import { pgEnum } from 'drizzle-orm/pg-core';

export const photoStatusEnum = pgEnum('photo_status', ['temp', 'promoted', 'expired']);

export const identificationSourceEnum = pgEnum('identification_source', [
  'plantnet_auto',
  'plantnet_picked',
  'none',
]);
