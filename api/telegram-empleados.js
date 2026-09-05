/**
 * Webhook del bot de Telegram para EMPLEADOS. Bot distinto al de gerencia
 * (`api/telegram-webhook.js`): aquí cada persona tiene su propio chat, y solo
 * ve lo suyo.
 *
 * ACTIVACIÓN MANUAL (una sola vez, después de desplegar, con el dominio real
 * y el secreto puestos — no hay red hacia api.telegram.org desde el entorno
 * de desarrollo):
 *
 *   https://api.telegram.org/bot<TOKEN_EMPLEADOS>/setWebhook?url=https://fichaje-corte-manga.vercel.app/api/telegram-empleados&secret_token=<TELEGRAM_EMPLEADOS_WEBHOOK_SECRET>
 *
 * Vinculación: la primera vez que alguien le escribe al bot, no hay ningún
 * chat_id guardado todavía, así que se le pide su PIN (el mismo de fichar y
 * de las tareas). Si coincide, ese chat queda vinculado a esa persona para
 * siempre (hasta que escriba /salir, o hasta que gerencia le quite o le
 * regenere el PIN, que también desvincula — igual que ya revoca sus sesiones
 * del móvil).
 *
 * Comandos, una vez vinculado (o los botones fijos de abajo del chat, que
 * mandan lo mismo sin tener que escribirlo):
 *   /horario → sus próximos turnos.
 *   /horas   → horas trabajadas esta semana y este mes.
 *   /tareas  → tareas de hoy de su rol en su centro.
 *   /salir   → desvincular esta conversación.
 */
import { getDbClient } from "./_db.js";
import {
  initSchema, getCentroCfg, fechaOperativaDe, epochDesdeLocal, auditar,
  identificarPorPin, identificarPorTelegramChatId, vincularTelegram, desvincularTelegram,
  minutosTrabajados, esDelRol, generarInstancias, marcarVencidas,
} from "./_tareas-lib.js";
import { avisarEmpleado, hayBotEmpleadosConfigurado } from "./_telegram-empleados.js";
import { escTelegram } from "./_telegram.js";

// Mismo criterio que el tope de intentos de PIN de la app (§ auth.js): sin
// esto, un PIN de 6 dígitos tampoco vale de mucho.
const FALLOS_VENTANA_MS = 10 * 60 * 1000;
const FALLOS_MAX = 5;

const EMOJI_ESTADO = {
  COMPLETADA: '✅', COMPLETADA_TARDIA: '✅', NO_APLICA: '🚫', VENCIDA: '⏰', PENDIENTE: '⏳',
};

const AYUDA_TEXTO =
  '/horario — tus próximos turnos\n' +
  '/horas — las horas que llevas esta semana y este mes\n' +
  '/tareas — las tareas de hoy de tu turno\n' +
  '/salir — desvincular esta conversación';

// Botones fijos debajo del chat, para no tener que escribir el comando. Es
// un teclado normal de Telegram (no botones inline sobre un mensaje): al
// tocar uno, Telegram manda su texto tal cual, como si el empleado lo hubiera
// escrito — por eso la clave de este mapa tiene que ser exactamente la
// etiqueta del botón.
const BOTON_A_COMANDO = {
  '📅 Mi horario': '/horario',
  '🕐 Mis horas': '/horas',
  '📋 Tareas de hoy': '/tareas',
  '🚪 Salir': '/salir',
};

const TECLADO_PRINCIPAL = {
  keyboard: [
    ['📅 Mi horario', '🕐 Mis horas'],
    ['📋 Tareas de hoy', '🚪 Salir'],
  ],
  resize_keyboard: true, // botones del tamaño del texto, no ocupando media pantalla
  is_persistent: true,   // se queda puesto; no hace falta reabrirlo en cada mensaje
};

/** La traza no debe tumbar el mensaje que la disparó. */
async function auditarSuave(db, req, datos) {
  try { await auditar(db, req, { ip: '', ...datos }); } catch {}
}

/** Recorta "/horas" o "/horas@NombreDelBot" (mayúsculas o argumentos incluidos). */
function comandoDe(texto) {
  const primera = String(texto || '').trim().split(/\s+/)[0] || '';
  return primera.replace(/@\w+$/, '').toLowerCase();
}

async function fallosPinRecientes(db, chatId) {
  const desde = Date.now() - FALLOS_VENTANA_MS;
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM evento_auditoria
          WHERE tipo_evento = 'PIN_FALLIDO_TELEGRAM' AND device_id = ? AND ts_servidor >= ?`,
    args: [`tg:${chatId}`, desde],
  });
  return Number(r.rows[0]?.n || 0);
}

/** Lunes de la semana que contiene `fechaISO` (YYYY-MM-DD), en calendario puro. */
function lunesDe(fechaISO) {
  const [Y, M, D] = fechaISO.split('-').map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D));
  const dow = d.getUTCDay(); // 0 = domingo … 6 = sábado
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Mediodía UTC en todas estas conversiones: evita que la zona horaria del
// servidor mueva la fecha al día de al lado por unas horas de diferencia.
function fechaAlMediodia(fechaISO) {
  return new Date(`${fechaISO}T12:00:00Z`);
}

/**
 * "08/09", para la cabecera de rango de una semana. A mano y no con Intl:
 * combinar day+month en '2-digit' sin year no rellena el mes con cero en
 * todas las versiones de ICU (da "8/9" en vez de "08/09"), y aquí el propio
 * texto de origen (YYYY-MM-DD) ya trae el cero puesto.
 */
function etiquetaFechaCorta(fechaISO) {
  const [, mes, dia] = String(fechaISO).split('-');
  return `${dia}/${mes}`;
}

/** "Viernes, 19 de septiembre" — el día completo, no la fecha corta. */
function etiquetaDiaLargo(fechaISO) {
  const texto = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long',
  }).format(fechaAlMediodia(fechaISO));
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

async function enviarAyuda(chatId, empleado) {
  await avisarEmpleado(
    chatId, `Hola, <b>${escTelegram(empleado.nombre)}</b>. Puedo con esto (o toca uno de los botones de abajo):\n\n${AYUDA_TEXTO}`,
    { reply_markup: TECLADO_PRINCIPAL }
  );
}

async function intentarVincular(db, req, chatId, pin) {
  const fallos = await fallosPinRecientes(db, chatId);
  if (fallos >= FALLOS_MAX) {
    await avisarEmpleado(chatId, '⏳ Demasiados intentos. Espera unos minutos y vuelve a escribir tu PIN.');
    return;
  }

  const empleado = await identificarPorPin(db, pin);
  if (!empleado) {
    // No se dice que el PIN es correcto pero de otro: confirmaría PIN ajenos por descarte.
    await auditarSuave(db, req, { tipo_evento: 'PIN_FALLIDO_TELEGRAM', entidad: 'empleados', device_id: `tg:${chatId}` });
    await avisarEmpleado(chatId, '❌ Ese PIN no coincide con nadie. Revísalo y vuelve a escribirlo.');
    return;
  }

  await vincularTelegram(db, empleado.nombre, String(chatId));
  await auditarSuave(db, req, {
    tipo_evento: 'EMPLEADO_VINCULO_TELEGRAM', entidad: 'empleados',
    empleado: empleado.nombre, centro: empleado.centro || '', device_id: `tg:${chatId}`,
  });

  await avisarEmpleado(
    chatId, `✅ Listo, <b>${escTelegram(empleado.nombre)}</b>. Usa los botones de abajo, o escríbeme:\n\n${AYUDA_TEXTO}`,
    { reply_markup: TECLADO_PRINCIPAL }
  );
}

// Tope defensivo: en la práctica nunca se carga tanto por delante, pero un
// mensaje sin límite podría pasarse de los 4096 caracteres que admite
// Telegram y perderse entero.
const TOPE_TURNOS_HORARIO = 60;

/**
 * Todos los turnos que tenga cargados a partir de hoy, agrupados por semana
 * —igual que ya se ven en el panel del encargado—, con el día completo (no
 * abreviado) y la fecha larga: es lo que se pidió para que de un vistazo se
 * sepa qué día de la semana entra y a qué hora, sin tener que traducir "lun"
 * ni el año de la fecha.
 */
async function responderHorario(db, empleado, chatId) {
  const hoy = new Date().toISOString().slice(0, 10);
  const r = await db.execute({
    sql: `SELECT fecha, hora_entrada, hora_salida, rol_segunda, hora_cambio, estado, semana
          FROM horarios
          WHERE LOWER(TRIM(empleado)) = LOWER(TRIM(?))
            AND LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?))
            AND fecha >= ? AND estado <> 'rechazado'
          ORDER BY fecha ASC LIMIT ?`,
    args: [empleado.nombre, empleado.centro || '', hoy, TOPE_TURNOS_HORARIO],
  });

  if (!r.rows.length) {
    await avisarEmpleado(chatId, 'No tienes ningún turno guardado a partir de hoy.');
    return;
  }

  // Los turnos ya llegan ordenados por fecha, así que agrupar en orden de
  // aparición basta para que cada semana salga seguida de la siguiente.
  const porSemana = new Map();
  for (const f of r.rows) {
    const clave = f.semana || '';
    if (!porSemana.has(clave)) porSemana.set(clave, []);
    porSemana.get(clave).push(f);
  }

  const bloques = [];
  for (const [semana, dias] of porSemana) {
    const numero = semana.split('-W')[1] || '?';
    const rango = `${etiquetaFechaCorta(dias[0].fecha)}–${etiquetaFechaCorta(dias[dias.length - 1].fecha)}`;
    const lineas = dias.map(f => {
      let linea = `${etiquetaDiaLargo(f.fecha)}: ${String(f.hora_entrada).slice(0, 5)}–${String(f.hora_salida).slice(0, 5)}`;
      if (f.rol_segunda) linea += ` (turno partido, vuelve a las ${String(f.hora_cambio).slice(0, 5)})`;
      if (f.estado === 'pendiente') linea += ' ⏳ sin validar';
      return linea;
    });
    bloques.push([`📅 <b>Semana ${numero}</b> (${rango})`, ...lineas].join('\n'));
  }

  let texto = bloques.join('\n\n');
  if (r.rows.length >= TOPE_TURNOS_HORARIO) {
    texto += `\n\n(mostrando los próximos ${TOPE_TURNOS_HORARIO} turnos guardados)`;
  }
  await avisarEmpleado(chatId, texto);
}

async function responderHoras(db, empleado, chatId, cfg) {
  const hoy = fechaOperativaDe(Date.now(), cfg);
  const inicioSemana = lunesDe(hoy);
  const inicioMes = `${hoy.slice(0, 7)}-01`;

  async function minutosDesde(fechaDesdeISO) {
    const desdeTs = epochDesdeLocal(fechaDesdeISO, cfg.inicio_jornada, cfg.zona_horaria);
    const f = await db.execute({
      sql: `SELECT tipo, timestamp FROM fichajes
            WHERE LOWER(TRIM(empleado)) = LOWER(TRIM(?))
              AND LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?))
              AND timestamp >= ?
            ORDER BY timestamp ASC`,
      args: [empleado.nombre, empleado.centro || '', desdeTs],
    });
    return minutosTrabajados(f.rows);
  }

  const horas = m => (m / 60).toFixed(1).replace('.', ',');
  const minSemana = await minutosDesde(inicioSemana);
  const minMes = await minutosDesde(inicioMes);

  await avisarEmpleado(chatId, `🕐 <b>Tus horas</b>\nEsta semana: ${horas(minSemana)} h\nEste mes: ${horas(minMes)} h`);
}

async function responderTareas(db, empleado, chatId, cfg) {
  const hoy = fechaOperativaDe(Date.now(), cfg);
  // Igual que /hoy del bot de gerencia: si nadie ha abierto la app todavía,
  // esto es lo que genera las tareas del día y marca las vencidas.
  await generarInstancias(db, empleado.centro, hoy, cfg);
  await marcarVencidas(db, empleado.centro, hoy);

  const r = await db.execute({
    sql: `SELECT i.estado, p.nombre, p.criticidad, p.rol_responsable
          FROM tarea_instancias i
          JOIN tarea_plantillas p ON p.id = i.plantilla_version_id
          WHERE LOWER(TRIM(COALESCE(i.centro,''))) = LOWER(TRIM(?))
            AND i.fecha_operativa = ?
          ORDER BY i.ventana_inicio_ts ASC`,
    args: [empleado.centro || '', hoy],
  });
  const mias = r.rows.filter(t => esDelRol(t.rol_responsable, String(empleado.rol || '').toLowerCase()));

  if (!mias.length) {
    await avisarEmpleado(chatId, 'Hoy no hay tareas dadas de alta para tu turno.');
    return;
  }

  const hechas = mias.filter(t => t.estado === 'COMPLETADA' || t.estado === 'COMPLETADA_TARDIA').length;
  const lineas = mias.map(t =>
    `${EMOJI_ESTADO[t.estado] || '•'} ${escTelegram(t.nombre)}${t.criticidad === 'BLOQUEANTE' ? ' (bloqueante)' : ''}`
  );
  await avisarEmpleado(chatId, `📋 <b>Tareas de hoy</b> (${hechas}/${mias.length} hechas)\n${lineas.join('\n')}`);
}

async function desvincular(db, req, empleado, chatId) {
  await desvincularTelegram(db, String(chatId));
  await auditarSuave(db, req, {
    tipo_evento: 'EMPLEADO_DESVINCULO_TELEGRAM', entidad: 'empleados',
    empleado: empleado.nombre, centro: empleado.centro || '',
  });
  await avisarEmpleado(
    chatId, 'Listo, esta conversación ya no está vinculada. Escribe tu PIN cuando quieras volver a engancharla.',
    { reply_markup: { remove_keyboard: true } }
  );
}

async function manejarMensaje(db, req, message) {
  const chatId = message.chat?.id;
  if (chatId === undefined || chatId === null) return;
  const texto = String(message.text || '').trim();

  const empleado = await identificarPorTelegramChatId(db, chatId);

  if (!empleado) {
    if (/^\d{4,8}$/.test(texto)) {
      await intentarVincular(db, req, chatId, texto);
      return;
    }
    await avisarEmpleado(chatId, '👋 Para empezar, escríbeme tu PIN (el mismo que usas para fichar o para las tareas).');
    return;
  }

  // Un botón del teclado manda su etiqueta tal cual, como si se hubiera
  // escrito el comando a mano.
  const comando = BOTON_A_COMANDO[texto] || comandoDe(texto);
  if (comando === '/salir') return desvincular(db, req, empleado, chatId);
  if (comando === '/ayuda' || comando === '/start') return enviarAyuda(chatId, empleado);

  const cfg = await getCentroCfg(db, empleado.centro || '');
  if (comando === '/horario') return responderHorario(db, empleado, chatId);
  if (comando === '/horas') return responderHoras(db, empleado, chatId, cfg);
  if (comando === '/tareas') return responderTareas(db, empleado, chatId, cfg);

  return enviarAyuda(chatId, empleado);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Mismo criterio que el webhook de gerencia: sin el secreto puesto se
  // acepta igual, para no bloquear el despliegue antes de haber corrido
  // setWebhook (que es cuando se le dice a Telegram qué secreto mandar).
  const secreto = process.env.TELEGRAM_EMPLEADOS_WEBHOOK_SECRET;
  if (secreto && req.headers['x-telegram-bot-api-secret-token'] !== secreto) {
    return res.status(401).json({ error: "No autorizado" });
  }

  if (!hayBotEmpleadosConfigurado()) {
    return res.status(200).json({ ok: true });
  }

  const db = getDbClient();
  await initSchema(db);

  const update = req.body || {};
  try {
    if (update.message?.text) await manejarMensaje(db, req, update.message);
    // Siempre 200: Telegram reintenta el mismo update si no responde rápido.
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(200).json({ ok: true });
  }
}
