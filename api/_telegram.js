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

/**
 * Igual que avisarTelegram, pero con la foto de la tarea como imagen del
 * mensaje en vez de solo nombrarla. `fotoBase64` puede venir con el prefijo
 * "data:image/...;base64," (así la guarda tareas.js) o sin él.
 *
 * El texto va como caption, que Telegram limita a 1024 caracteres —de sobra
 * para estos avisos, que son una línea—. Si la foto falla por lo que sea (
 * demasiado grande, formato que Telegram no traga, sin conexión), no se
 * pierde el aviso: cae al mensaje de texto de siempre.
 */
export async function avisarTelegramConFoto(texto, fotoBase64, mime = 'image/jpeg') {
  if (!hayTelegramConfigurado()) return;
  if (!fotoBase64) return avisarTelegram(texto);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  try {
    const limpio = String(fotoBase64).replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(limpio, 'base64');

    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('parse_mode', 'HTML');
    form.append('caption', texto.slice(0, 1024));
    form.append('photo', new Blob([buf], { type: mime }), 'evidencia.jpg');

    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
    if (!r.ok) await avisarTelegram(texto);
  } catch {
    await avisarTelegram(texto).catch(() => {});
  }
}
