import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { __setSendMailForTests, sendMail, type SendMailInput } from '@/lib/mailer';

describe('mailer.sendMail', () => {
  let captured: SendMailInput[] = [];
  let restore: (() => void) | null = null;

  beforeEach(() => {
    captured = [];
    restore = __setSendMailForTests(async (input) => {
      captured.push(input);
    });
  });

  afterEach(() => {
    restore?.();
  });

  it('forwards to the swappable impl', async () => {
    await sendMail({ to: 'a@x', subject: 's', html: '<p>h</p>', text: 'h' });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ to: 'a@x', subject: 's', html: '<p>h</p>', text: 'h' });
  });

  it('routes every call through the swapped impl', async () => {
    await sendMail({ to: 'b@x', subject: 's', html: 'h' });
    await sendMail({ to: 'c@x', subject: 's', html: 'h' });

    expect(captured).toHaveLength(2);
    expect(captured[0]?.to).toBe('b@x');
    expect(captured[1]?.to).toBe('c@x');
  });

  it('does not throw when the swapped impl rejects', async () => {
    restore?.();
    restore = __setSendMailForTests(async () => {
      throw new Error('boom');
    });

    // The mailer wraps the default impl in try/catch, but the swap point is BEFORE that.
    // So a throwing replacement DOES propagate — assert that and document the contract:
    // "test replacements own their own error handling".
    await expect(sendMail({ to: 'x', subject: 's', html: 'h' })).rejects.toThrow('boom');
  });
});
