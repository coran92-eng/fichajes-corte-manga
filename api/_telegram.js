/**
 * Avisos por Telegram.
 *
 * Sin TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no se manda nada: configurarlo es
 * una decisión, no un requisito para que la app funcione (mismo criterio que
 * QR_SECRET). Un fallo al avisar nunca debe tumbar la petición que lo dispara
 * —fichar o completar una tarea no puede depender de que Telegram esté
 * arriba—, así que va envuelto en su propio try/catch.
 *
 * OJO: hay que esperar a que termine (`await avisarTelegram(...)`) antes de
 * responder. Una función serverless puede congelarse en cuanto se manda la
 * respuesta, y un `fetch` sin esperar se queda a medias — el mensaje se
 * pierde en silencio. Cuesta unos cientos de ms más por fichaje, pero es la
 * diferencia entre que el aviso llegue de verdad o no.
 */

export function hayTelegramConfigurado() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/** Escapa lo mínimo que exige el HTML de Telegram (parse_mode: 'HTML'). */
export function escTelegram(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function avisarTelegram(texto) {
  if (!hayTelegramConfigurado()) return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML' }),
    });
  } catch {}
}
