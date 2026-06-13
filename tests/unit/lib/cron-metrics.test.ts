import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Pushgateway } from 'prom-client';
import { env } from '@/config/env';
import { pushPurgeMetrics } from '@/lib/cron-metrics';
import type { PurgeCycleResult } from '@/services/purge';

function cat() {
  return { rowsDeleted: 0, garageDeleted: 0, garageFailed: 0, errored: false };
}

function fakeResult(): PurgeCycleResult {
  return {
    expiredIdentifications: { ...cat(), rowsDeleted: 3 },
    oldSoftDeletedSpecimens: cat(),
    oldPlantnetUsage: cat(),
    expiredRateLimits: cat(),
    staleAuthRateLimits: cat(),
    orphanReconciliation: { scanned: 0, orphansDeleted: 2, garageFailed: 0, errored: false },
    hadError: false,
  };
}

type EnvUrl = { PUSHGATEWAY_URL?: string | undefined };
const originalUrl = env.PUSHGATEWAY_URL;

afterEach(() => {
  (env as EnvUrl).PUSHGATEWAY_URL = originalUrl;
});

describe('pushPurgeMetrics', () => {
  it('pushes to the gateway with the cron job name when PUSHGATEWAY_URL is set', async () => {
    (env as EnvUrl).PUSHGATEWAY_URL = 'http://localhost:9091';
    const spy = spyOn(Pushgateway.prototype, 'pushAdd').mockResolvedValue({});

    await pushPurgeMetrics(fakeResult());

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toEqual({ jobName: 'airbarium-cron' });
    spy.mockRestore();
  });

  it('does not push when PUSHGATEWAY_URL is unset', async () => {
    (env as EnvUrl).PUSHGATEWAY_URL = undefined;
    const spy = spyOn(Pushgateway.prototype, 'pushAdd');

    await pushPurgeMetrics(fakeResult());

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('swallows a push failure and never throws', async () => {
    (env as EnvUrl).PUSHGATEWAY_URL = 'http://localhost:9091';
    const spy = spyOn(Pushgateway.prototype, 'pushAdd').mockRejectedValue(
      new Error('gateway down'),
    );

    await expect(pushPurgeMetrics(fakeResult())).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
