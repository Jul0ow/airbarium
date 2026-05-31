import type { EmailContent } from './verify-email';

export function resetPasswordEmail(input: { url: string; userName: string }): EmailContent {
  const { url, userName } = input;
  return {
    subject: 'Réinitialise ton mot de passe',
    html: `<!doctype html>
<html lang="fr"><body style="font-family:sans-serif;line-height:1.5;color:#222">
  <p>Bonjour ${escapeHtml(userName)},</p>
  <p>Tu as demandé à réinitialiser ton mot de passe Airbarium. Clique sur le lien ci-dessous pour choisir un nouveau mot de passe :</p>
  <p><a href="${escapeAttr(url)}">${escapeHtml(url)}</a></p>
  <p>Ce lien expire dans 1 heure. Si tu n'es pas à l'origine de cette demande, ignore ce message.</p>
  <p>— L'équipe Airbarium</p>
</body></html>`,
    text: `Bonjour ${userName},

Réinitialise ton mot de passe Airbarium :
${url}

Ce lien expire dans 1 heure. Si tu n'es pas à l'origine de cette demande, ignore ce message.
— L'équipe Airbarium`,
  };
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
