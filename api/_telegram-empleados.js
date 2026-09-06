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

/**
 * Teclado fijo con TODAS las acciones del bot, para que se vea de un vistazo
 * el alcance real sin tener que escribir ni memorizar ningún comando. Es el
 * reply_markup por defecto de avisarEmpleado (ver más abajo): así, el
 * teclado de cada persona se pone al día solo con recibir CUALQUIER aviso
 * del bot —una respuesta, el recordatorio diario, un aviso de que se aprobó
 * una solicitud—, sin que nadie tenga que volver a vincularse ni tocar nada
 * en concreto para "refrescarlo". Telegram, además, sigue mostrando el
 * último teclado que mandó el bot aunque un mensaje puntual no lleve
 * reply_markup (p.ej. porque lleva botones inline en su lugar), así que
 * nunca desaparece por medio.
 *
 * Las etiquetas tienen que coincidir letra por letra (incluido el emoji) con
 * las claves de BOTON_A_COMANDO en telegram-empleados.js — es el mismo texto
 * el que manda Telegram cuando se toca el botón.
 */
export const TECLADO_PRINCIPAL = {
  keyboard: [
    ['📅 Mi horario', '🕐 Mis horas'],
    ['📋 Tareas de hoy', '📍 Fichar'],
    ['💰 Caja', '✏️ Corregir fichaje'],
    ['🔧 Incidencia', '📦 Falta de producto'],
    ['❓ Ayuda', '🚪 Salir'],
  ],
  resize_keyboard: true, // botones del tamaño del texto, no ocupando media pantalla
  is_persistent: true,   // se queda puesto; no hace falta reabrirlo en cada mensaje
};

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

/**
 * Manda un mensaje a UN chat concreto (el de un empleado ya vinculado).
 * Por defecto reenvía el teclado fijo con todas las acciones (TECLADO_
 * PRINCIPAL), así que casi ningún llamador necesita pensar en el teclado.
 * Para poner unos botones inline en su lugar (tareas, fichar, el asistente
 * guiado), basta con pasar `{ reply_markup: {...} }`; para no tocar el
 * teclado que ya hubiera puesto (p.ej. antes de vincular a nadie), se pasa
 * explícitamente `{ reply_markup: null }`.
 */
export async function avisarEmpleado(chatId, texto, opciones = {}) {
  if (!hayBotEmpleadosConfigurado() || !chatId) return;
  const reply_markup = 'reply_markup' in opciones ? opciones.reply_markup : TECLADO_PRINCIPAL;
  await llamarApiEmpleados('sendMessage', {
    chat_id: chatId,
    text: texto,
    parse_mode: 'HTML',
    ...(reply_markup ? { reply_markup } : {}),
  });
}

export async function responderCallbackEmpleado(callbackQueryId, texto = '') {
  await llamarApiEmpleados('answerCallbackQuery', { callback_query_id: callbackQueryId, text: texto });
}
