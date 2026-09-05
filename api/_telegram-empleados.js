/**
 * Avisos por Telegram para los EMPLEADOS — un bot distinto al de gerencia
 * (`_telegram.js`). Ahí hay un chat fijo (el dueño); aquí cada persona tiene
 * el suyo, así que cada aviso necesita SU `chat_id`, no uno guardado en el
 * entorno. Token y webhook van también aparte (`TELEGRAM_EMPLEADOS_*`): son
 * dos bots de Telegram distintos, con sus propias credenciales.
 */

export function hayBotEmpleadosConfigurado() {
  return !!process.env.TELEGRAM_EMPLEADOS_BOT_TOKEN;
}

async function llamarApiEmpleados(metodo, payload) {
  if (!hayBotEmpleadosConfigurado()) return null;
  const token = process.env.TELEGRAM_EMPLEADOS_BOT_TOKEN;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await r.json();
    if (json && json.ok === false) {
      console.error(`Telegram (empleados) rechazó ${metodo}:`, json.description || json);
    }
    return json;
  } catch (error) {
    console.error(`Telegram (empleados) no respondió a ${metodo}:`, error.message);
    return null;
  }
}

/** Manda un mensaje a UN chat concreto (el de un empleado ya vinculado). */
export async function avisarEmpleado(chatId, texto, opciones = {}) {
  if (!hayBotEmpleadosConfigurado() || !chatId) return;
  await llamarApiEmpleados('sendMessage', {
    chat_id: chatId,
    text: texto,
    parse_mode: 'HTML',
    ...(opciones.reply_markup ? { reply_markup: opciones.reply_markup } : {}),
  });
}

export async function responderCallbackEmpleado(callbackQueryId, texto = '') {
  await llamarApiEmpleados('answerCallbackQuery', { callback_query_id: callbackQueryId, text: texto });
}
