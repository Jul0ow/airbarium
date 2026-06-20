// Helpers to keep PII out of structured logs (design §9 / §10.1: no raw PII).

/**
 * Mask an email for logging: keep the first local-part char and the full domain
 * (`jules.diaz@epita.fr` -> `j***@epita.fr`), enough to debug deliverability
 * without recording the full address. Non-email inputs are fully masked.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local[0]}***@${domain}`;
}
