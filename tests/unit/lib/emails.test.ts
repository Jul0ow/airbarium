import { describe, expect, it } from 'bun:test';
import { resetPasswordEmail } from '@/lib/emails/reset-password';
import { verifyEmailEmail } from '@/lib/emails/verify-email';

describe('verifyEmailEmail', () => {
  it('produces subject, html with the URL, text with the URL', () => {
    const m = verifyEmailEmail({ url: 'https://app.example/v/abc', userName: 'Alice' });
    expect(m.subject).toBe('Confirme ton inscription à Airbarium');
    expect(m.html).toContain('https://app.example/v/abc');
    expect(m.html).toContain('Alice');
    expect(m.text).toContain('https://app.example/v/abc');
  });
});

describe('resetPasswordEmail', () => {
  it('produces subject, html with the URL, text with the URL', () => {
    const m = resetPasswordEmail({ url: 'https://app.example/r/xyz', userName: 'Bob' });
    expect(m.subject).toBe('Réinitialise ton mot de passe');
    expect(m.html).toContain('https://app.example/r/xyz');
    expect(m.html).toContain('Bob');
    expect(m.text).toContain('https://app.example/r/xyz');
  });
});
