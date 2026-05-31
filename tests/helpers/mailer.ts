import { __setSendMailForTests, type SendMailInput } from '@/lib/mailer';

export type CapturedMail = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export type MockMailerHandle = {
  sent: CapturedMail[];
  restore: () => void;
};

export function installMockMailer(): MockMailerHandle {
  const sent: CapturedMail[] = [];
  const restore = __setSendMailForTests(async (input: SendMailInput) => {
    sent.push({
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(input.text !== undefined && { text: input.text }),
    });
  });

  return { sent, restore };
}
