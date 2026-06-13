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
let pushSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  (env as EnvUrl).PUSHGATEWAY_URL = originalUrl;
  // Restore here too, so a spy can't leak into the next test if an assertion
  // above threw before its inline mockRestore() ran.
  pushSpy?.mockRestore();
  pushSpy = undefined;
});

describe('pushPurgeMetrics', () => {
  it('pushes to the gateway with the cron job name when PUSHGATEWAY_URL is set', async () => {
    (env as EnvUrl).PUSHGATEWAY_URL = 'http://localhost:9091';
    pushSpy = spyOn(Pushgateway.prototype, 'pushAdd').mockResolvedValue({});

    await pushPurgeMetrics(fakeResult());

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy?.mock.calls[0]?.[0]).toEqual({ jobName: 'airbarium-cron' });
  });

  it('does not push when PUSHGATEWAY_URL is unset', async () => {
    (env as EnvUrl).PUSHGATEWAY_URL = undefined;
    pushSpy = spyOn(Pushgateway.prototype, 'pushAdd');

    await pushPurgeMetrics(fakeResult());

    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('swallows a push failure and never throws', async () => {
    (env as EnvUrl).PUSHGATEWAY_URL = 'http://localhost:9091';
    pushSpy = spyOn(Pushgateway.prototype, 'pushAdd').mockRejectedValue(new Error('gateway down'));

    await expect(pushPurgeMetrics(fakeResult())).resolves.toBeUndefined();
  });
});
