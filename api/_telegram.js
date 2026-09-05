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

// Si APP_URL no está puesta, se usa el dominio conocido de producción: mejor
// un enlace que funciona sin configurar nada más que uno roto por defecto.
const APP_URL_DEFAULT = 'https://fichaje-corte-manga.vercel.app';

/** Enlace al panel del dueño, listo para pegar en cualquier aviso. */
export function enlacePanel(centro) {
  const base = (process.env.APP_URL || APP_URL_DEFAULT).replace(/\/+$/, '');
  return `${base}/panel.html?centro=${encodeURIComponent(centro || '')}`;
}

/**
 * Añade el enlace al panel al final de un aviso, en su propia línea. Se usa
 * en casi todos los avisos —por eso vive aquí y no repetido en cada sitio—,
 * salvo cuando no aplica (por ejemplo, un aviso que ya no es de un centro
 * concreto).
 */
export function conEnlacePanel(texto, centro) {
  if (!centro) return texto;
  return `${texto}\n<a href="${enlacePanel(centro)}">Ver el panel</a>`;
}

/** Escapa lo mínimo que exige el HTML de Telegram (parse_mode: 'HTML'). */
export function escTelegram(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Bajo nivel: llama a un método cualquiera de la Bot API
 * (https://core.telegram.org/bots/api#available-methods) sin lanzar si algo
 * falla. Devuelve el JSON que responde Telegram, o null si no se pudo llamar
 * (sin configurar, sin red, respuesta que no es JSON...).
 */
async function llamarApiTelegram(metodo, payload) {
  if (!hayTelegramConfigurado()) return null;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * `opciones.reply_markup` permite adjuntar botones (inline_keyboard) sin
 * tener que montar el payload a mano en cada sitio que quiera mandar uno —
 * ver `marcarVencidas` en tareas.js para un ejemplo real.
 */
export async function avisarTelegram(texto, opciones = {}) {
  if (!hayTelegramConfigurado()) return;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  await llamarApiTelegram('sendMessage', {
    chat_id: chatId,
    text: texto,
    parse_mode: 'HTML',
    ...(opciones.reply_markup ? { reply_markup: opciones.reply_markup } : {}),
  });
}

/**
 * Contesta a un callback_query (toque de un botón inline). Telegram exige
 * responder a todos: si no, el botón se queda "cargando" en el móvil de
 * quien lo tocó aunque ya se haya hecho lo que pedía.
 */
export async function responderCallbackTelegram(callbackQueryId, texto = '') {
  await llamarApiTelegram('answerCallbackQuery', { callback_query_id: callbackQueryId, text: texto });
}

/**
 * Quita (o sustituye) los botones de un mensaje ya mandado, sin tocar su
 * texto. Se usa en vez de reescribir el mensaje entero al resolver una
 * tarea desde Telegram: Telegram devuelve el texto de `callback_query.message`
 * ya "aplanado" (sin las etiquetas HTML con las que se mandó), así que
 * reconstruirlo con formato sería frágil — más simple quitar el botón y
 * mandar la confirmación como mensaje aparte.
 */
export async function editarBotonesTelegram(chatId, messageId, replyMarkup) {
  await llamarApiTelegram('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
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
