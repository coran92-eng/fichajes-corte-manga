/**
 * Webhook de Telegram: hace el bot bidireccional. Hasta ahora solo mandaba
 * avisos (ver _telegram.js); este endpoint recibe lo que el dueño escribe o
 * toca, según https://core.telegram.org/bots/api#update.
 *
 * ACTIVACIÓN MANUAL (una sola vez, después de desplegar, con el dominio real
 * y el secreto puestos — no hay red hacia api.telegram.org desde el entorno
 * de desarrollo, así que esto no se puede lanzar desde aquí):
 *
 *   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://fichaje-corte-manga.vercel.app/api/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
 *
 * Soporta:
 *   - /hoy → resumen del día en curso (hechas/pendientes/vencidas) por centro.
 *   - el botón "Marcar como no aplica" del aviso de tarea vencida.
 */
import { getDbClient } from "./_db.js";
import { initSchema, getCentroCfg, fechaOperativaDe, auditar } from "./_tareas-lib.js";
import {
  avisarTelegram, escTelegram, hayTelegramConfigurado,
  responderCallbackTelegram, editarBotonesTelegram,
} from "./_telegram.js";

const MOTIVO_TELEGRAM = 'Marcado desde Telegram por el dueño';

/** ¿Es este chat el del dueño? Nadie más debe poder usar el bot aunque adivine la URL. */
function esDelDueno(chatId) {
  const configurado = process.env.TELEGRAM_CHAT_ID;
  return !!configurado && chatId !== undefined && chatId !== null
    && String(chatId) === String(configurado);
}

/** Recorta "/hoy" o "/hoy@NombreDelBot" (con mayúsculas o argumentos) a "/hoy". */
function comandoDe(texto) {
  const primera = String(texto || '').trim().split(/\s+/)[0] || '';
  return primera.replace(/@\w+$/, '').toLowerCase();
}

async function resumenHoy() {
  const db = getDbClient();
  await initSchema(db);

  const centros = await db.execute("SELECT centro FROM centros_cfg");
  const bloques = [];

  for (const { centro } of centros.rows) {
    const cfg = await getCentroCfg(db, centro);
    const hoy = fechaOperativaDe(Date.now(), cfg);

    const r = await db.execute({
      sql: `SELECT i.estado, p.nombre, p.criticidad
            FROM tarea_instancias i
            JOIN tarea_plantillas p ON p.id = i.plantilla_version_id
            WHERE LOWER(TRIM(COALESCE(i.centro,''))) = LOWER(TRIM(?))
              AND i.fecha_operativa = ?`,
      args: [centro, hoy],
    });
    // Centro sin ninguna tarea generada todavía para hoy: nada que resumir.
    if (!r.rows.length) continue;

    const total = r.rows.length;
    const completadas = r.rows.filter(t => t.estado === 'COMPLETADA' || t.estado === 'COMPLETADA_TARDIA').length;
    const pendientes = r.rows.filter(t => t.estado === 'PENDIENTE').length;
    const vencidas = r.rows.filter(t => t.estado === 'VENCIDA').length;
    const bloqueantesSinHacer = r.rows.filter(t =>
      (t.estado === 'PENDIENTE' || t.estado === 'VENCIDA') && t.criticidad === 'BLOQUEANTE');

    const lineas = [
      `📋 <b>Hoy</b> (${hoy}) — ${escTelegram(centro)}`,
      `${completadas}/${total} hechas, ${pendientes} pendientes${vencidas ? `, ${vencidas} vencidas` : ''}`,
    ];
    if (bloqueantesSinHacer.length) {
      lineas.push(`🔴 Bloqueante sin hacer: ${bloqueantesSinHacer.map(t => escTelegram(t.nombre)).join(', ')}`);
    }
    bloques.push(lineas.join('\n'));
  }

  return bloques.length ? bloques.join('\n\n') : 'Ningún centro tiene tareas dadas de alta para hoy.';
}

async function manejarMensaje(message) {
  if (!esDelDueno(message.chat?.id)) return;
  if (comandoDe(message.text) !== '/hoy') return;

  const texto = await resumenHoy();
  await avisarTelegram(texto);
}

/**
 * Marca la instancia como NO_APLICA (misma sentencia que la acción
 * `no-aplica` de tareas.js, que aquí no se puede invocar: llega sin el
 * header X-Auth-Token que exige, porque el mensaje viene de Telegram, no de
 * la app) y confirma en el chat.
 */
async function marcarNoAplica(req, callbackQuery) {
  const [, idTexto] = String(callbackQuery.data || '').split(':');
  const instanciaId = Number(idTexto);
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;

  if (!Number.isFinite(instanciaId)) {
    await responderCallbackTelegram(callbackQuery.id, 'Tarea no válida');
    return;
  }

  const db = getDbClient();
  await initSchema(db);

  const r = await db.execute({
    sql: `SELECT i.estado, i.centro, p.nombre FROM tarea_instancias i
          JOIN tarea_plantillas p ON p.id = i.plantilla_version_id
          WHERE i.id = ?`,
    args: [instanciaId],
  });
  if (!r.rows.length) {
    await responderCallbackTelegram(callbackQuery.id, 'Esa tarea ya no existe');
    return;
  }

  const { estado, centro, nombre } = r.rows[0];
  if (estado !== 'PENDIENTE' && estado !== 'VENCIDA') {
    // Ya se resolvió por otra vía (la app, o un segundo toque del mismo
    // botón): no se vuelve a tocar, solo se avisa y se limpia el botón.
    await responderCallbackTelegram(callbackQuery.id, 'Esa tarea ya estaba resuelta');
    if (chatId && messageId) await editarBotonesTelegram(chatId, messageId, { inline_keyboard: [] });
    return;
  }

  await db.execute({
    sql: `UPDATE tarea_instancias SET estado = 'NO_APLICA', motivo_no_aplica = ?, completada_por = ?, completada_ts_servidor = ? WHERE id = ?`,
    args: [MOTIVO_TELEGRAM, 'Telegram', Date.now(), instanciaId],
  });
  await auditar(db, req, {
    tipo_evento: 'TAREA_NO_APLICA', entidad: 'tarea_instancias', entidad_id: instanciaId,
    empleado: 'Telegram', centro,
    payload: { motivo: MOTIVO_TELEGRAM, estado_anterior: estado },
  });

  await responderCallbackTelegram(callbackQuery.id, 'Marcada como no aplica');
  if (chatId && messageId) await editarBotonesTelegram(chatId, messageId, { inline_keyboard: [] });
  await avisarTelegram(`✅ Marcada como no aplica: <b>${escTelegram(nombre)}</b>`);
}

async function manejarCallback(req, callbackQuery) {
  if (!esDelDueno(callbackQuery.message?.chat?.id)) return;

  const datos = String(callbackQuery.data || '');
  if (datos.startsWith('no_aplica:')) {
    await marcarNoAplica(req, callbackQuery);
  } else {
    // Callback que no reconocemos: se contesta igual para que no se quede
    // "cargando" en el móvil, aunque no haya nada que hacer con él.
    await responderCallbackTelegram(callbackQuery.id);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Mismo criterio que CRON_SECRET en aviso-diario.js: sin el secreto puesto
  // se acepta igual, para no bloquear el despliegue antes de haber corrido
  // setWebhook (que es cuando se le dice a Telegram qué secreto mandar).
  const secreto = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secreto && req.headers['x-telegram-bot-api-secret-token'] !== secreto) {
    return res.status(401).json({ error: "No autorizado" });
  }

  if (!hayTelegramConfigurado()) {
    return res.status(200).json({ ok: true });
  }

  const update = req.body || {};

  try {
    if (update.callback_query) {
      await manejarCallback(req, update.callback_query);
    } else if (update.message?.text) {
      await manejarMensaje(update.message);
    }
    // Siempre 200: Telegram reintenta el mismo update si no responde rápido,
    // y un update que no reconocemos o que falla por dentro no debería
    // machacar el chat del dueño con reintentos.
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(200).json({ ok: true });
  }
}
