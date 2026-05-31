import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '@/config/env';

export type SendMailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

type SendMailImpl = (input: SendMailInput) => Promise<void>;

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport(env.SMTP_URL);
  }
  return transporter;
}

const defaultImpl: SendMailImpl = async (input) => {
  try {
    const result = await getTransporter().sendMail({
      from: env.MAIL_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'mail.sent',
        to: input.to,
        subject: input.subject,
        messageId: result.messageId,
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'mail.failed',
        to: input.to,
        subject: input.subject,
        err: String(err),
      }),
    );
  }
};

let impl: SendMailImpl = defaultImpl;

export async function sendMail(input: SendMailInput): Promise<void> {
  return impl(input);
}

// Test-only swap. Returns a restore fn that resets to the default implementation.
export function __setSendMailForTests(replacement: SendMailImpl): () => void {
  const prev = impl;
  impl = replacement;
  return () => {
    impl = prev;
  };
}
