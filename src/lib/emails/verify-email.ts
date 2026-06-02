import { escapeAttr, escapeHtml } from './_escape';

export type EmailContent = { subject: string; html: string; text: string };

export function verifyEmailEmail(input: { url: string; userName: string }): EmailContent {
  const { url, userName } = input;
  return {
    subject: 'Confirme ton inscription à Airbarium',
    html: `<!doctype html>
<html lang="fr"><body style="font-family:sans-serif;line-height:1.5;color:#222">
  <p>Bonjour ${escapeHtml(userName)},</p>
  <p>Merci pour ton inscription à Airbarium. Confirme ton adresse email en cliquant sur le lien ci-dessous :</p>
  <p><a href="${escapeAttr(url)}">${escapeHtml(url)}</a></p>
  <p>Si tu n'es pas à l'origine de cette inscription, ignore simplement ce message.</p>
  <p>— L'équipe Airbarium</p>
</body></html>`,
    text: `Bonjour ${userName},

Confirme ton adresse email Airbarium :
${url}

Si tu n'es pas à l'origine de cette inscription, ignore ce message.
— L'équipe Airbarium`,
  };
}
