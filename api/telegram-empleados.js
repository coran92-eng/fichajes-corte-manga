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
 *   /horario   → sus próximos turnos.
 *   /horas     → horas trabajadas esta semana y este mes.
 *   /tareas    → tareas de hoy de su rol, con botones para completar las que
 *                se pueden completar sin estar delante del código del bar.
 *   /corregir  → pedir corregir un fichaje: AAAA-MM-DD tipo HH:MM motivo.
 *   /incidencia, /falta → dejar aviso de algo roto o agotado.
 *   /salir     → desvincular esta conversación.
 *
 * Completar tareas por Telegram: SOLO las de tipo CHECK, NUMERO o TEXTO. Las
 * que llevan foto siguen exigiendo el código del bar (§ tareas.js) porque es
 * la única prueba de que quien la hace está delante — eso no se puede
 * replicar en un chat, así que no se intenta; se avisa de que hay que abrir
 * la app. Además, cualquier tarea —lleve foto o no— exige turno abierto: no
 * se puede completar nada sin haber fichado la entrada, igual que en la app.
 */
import { getDbClient } from "./_db.js";
import {
  initSchema, getCentroCfg, fechaOperativaDe, epochDesdeLocal, auditar,
  identificarPorPin, identificarPorTelegramChatId, vincularTelegram, desvincularTelegram,
  minutosTrabajados, esDelRol, generarInstancias, marcarVencidas, turnoAbierto,
} from "./_tareas-lib.js";
import { avisarEmpleado, hayBotEmpleadosConfigurado, responderCallbackEmpleado } from "./_telegram-empleados.js";
import { avisarTelegram, escTelegram, conEnlacePanel } from "./_telegram.js";

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
  '/tareas — las de hoy de tu turno, con botones para completar las que no llevan foto\n' +
  '/corregir AAAA-MM-DD tipo HH:MM motivo — pedir corregir un fichaje\n' +
  '   (tipo: entrada, salida, inicio_descanso o fin_descanso)\n' +
  '/incidencia texto — avisar de algo roto o averiado\n' +
  '/falta texto — avisar de que se ha acabado algo\n' +
  '/salir — desvincular esta conversación';

// Botones fijos debajo del chat, para no tener que escribir el comando. Es
// un teclado normal de Telegram (no botones inline sobre un mensaje): al
// tocar uno, Telegram manda su texto tal cual, como si el empleado lo hubiera
// escrito — por eso la clave de este mapa tiene que ser exactamente la
// etiqueta del botón. /corregir, /incidencia y /falta se quedan fuera del
// teclado fijo porque necesitan escribir algo detrás del comando.
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

/** Todo lo que va después de la primera palabra, tal cual (sin recortar espacios internos). */
function argumentosDe(texto) {
  const limpio = String(texto || '').trim();
  const i = limpio.indexOf(' ');
  return i === -1 ? '' : limpio.slice(i + 1);
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

/** Nombre de tarea recortado para que quepa como etiqueta de botón (máx. 64 caracteres en Telegram). */
function nombreParaBoton(nombre) {
  const n = String(nombre || '');
  return n.length > 35 ? `${n.slice(0, 32)}…` : n;
}

function lineaTareaListado(t) {
  const emoji = EMOJI_ESTADO[t.estado] || '•';
  let linea = `${emoji} ${escTelegram(t.nombre)}${t.criticidad === 'BLOQUEANTE' ? ' (bloqueante)' : ''}`;
  const pendiente = t.estado === 'PENDIENTE' || t.estado === 'VENCIDA';
  const llevaFoto = t.tipo_evidencia === 'FOTO' || t.tipo_evidencia === 'FOTO+NUMERO';
  if (pendiente && llevaFoto) linea += ' — requiere estar en el bar, complétala desde la app';
  return linea;
}

async function responderTareas(db, empleado, chatId, cfg) {
  const hoy = fechaOperativaDe(Date.now(), cfg);
  // Igual que /hoy del bot de gerencia: si nadie ha abierto la app todavía,
  // esto es lo que genera las tareas del día y marca las vencidas.
  await generarInstancias(db, empleado.centro, hoy, cfg);
  await marcarVencidas(db, empleado.centro, hoy);

  const r = await db.execute({
    sql: `SELECT i.id, i.estado, p.nombre, p.criticidad, p.rol_responsable, p.tipo_evidencia
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
  const lineas = mias.map(lineaTareaListado);

  // Botón por tarea completable sin foto — las que llevan foto no lo tienen,
  // porque completarlas exige el código del bar y eso no se puede hacer
  // desde un chat.
  const botones = [];
  for (const t of mias) {
    if (t.estado !== 'PENDIENTE' && t.estado !== 'VENCIDA') continue;
    const etiqueta = nombreParaBoton(t.nombre);
    if (t.tipo_evidencia === 'CHECK') botones.push([{ text: `✅ ${etiqueta}`, callback_data: `tgcompletar:${t.id}` }]);
    else if (t.tipo_evidencia === 'NUMERO') botones.push([{ text: `✏️ ${etiqueta}`, callback_data: `tgnumero:${t.id}` }]);
    else if (t.tipo_evidencia === 'TEXTO') botones.push([{ text: `✏️ ${etiqueta}`, callback_data: `tgtexto:${t.id}` }]);
  }

  const texto = `📋 <b>Tareas de hoy</b> (${hechas}/${mias.length} hechas)\n${lineas.join('\n')}`;
  await avisarEmpleado(chatId, texto, botones.length ? { reply_markup: { inline_keyboard: botones } } : {});
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

// ── Completar tareas sin foto desde el chat ───────────────────
// Un pendiente por chat (no hace falta más: un empleado hace una cosa cada
// vez). Vive en su propia tabla, no en _tareas-lib.js, porque es un detalle
// de este bot, no algo que necesite ninguna otra ruta.
let pendientesListo = false;
async function initPendientes(db) {
  if (pendientesListo) return;
  await db.execute(`
    CREATE TABLE IF NOT EXISTS telegram_tarea_pendiente (
      chat_id TEXT PRIMARY KEY,
      instancia_id INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      creado_en INTEGER NOT NULL
    )
  `);
  pendientesListo = true;
}

async function guardarPendiente(db, chatId, instanciaId, tipo) {
  await initPendientes(db);
  await db.execute({
    sql: `INSERT INTO telegram_tarea_pendiente (chat_id, instancia_id, tipo, creado_en) VALUES (?, ?, ?, ?)
          ON CONFLICT(chat_id) DO UPDATE SET instancia_id = excluded.instancia_id, tipo = excluded.tipo, creado_en = excluded.creado_en`,
    args: [String(chatId), instanciaId, tipo, Date.now()],
  });
}

async function limpiarPendiente(db, chatId) {
  await initPendientes(db);
  await db.execute({ sql: `DELETE FROM telegram_tarea_pendiente WHERE chat_id = ?`, args: [String(chatId)] });
}

/**
 * Completa una tarea sin foto (CHECK/NUMERO/TEXTO), con las mismas reglas
 * que tareas.js: no se puede repetir, no se puede si está marcada No aplica,
 * y hace falta turno abierto —igual que en la app, no distingue si el móvil
 * es el del bar o el propio—. No repite la detección de ráfaga de tareas.js
 * (§8.3): aquí es un aviso informativo para revisar después, no una regla
 * que tuviera que bloquear nada, así que se deja fuera para no duplicar esa
 * lógica en dos sitios.
 */
async function completarTarea(db, req, empleado, instanciaId, extra = {}) {
  const insR = await db.execute({
    sql: `SELECT i.*, p.nombre, p.tipo_evidencia, p.evidencia_config, p.criticidad, p.rol_responsable
          FROM tarea_instancias i
          JOIN tarea_plantillas p ON p.id = i.plantilla_version_id
          WHERE i.id = ?`,
    args: [instanciaId],
  });
  if (!insR.rows.length) return { error: 'Esa tarea ya no existe.' };
  const t = insR.rows[0];

  if (t.tipo_evidencia === 'FOTO' || t.tipo_evidencia === 'FOTO+NUMERO') {
    return { error: 'Esta tarea lleva foto: hace falta el código del bar, complétala desde la app.' };
  }
  if (t.estado === 'COMPLETADA' || t.estado === 'COMPLETADA_TARDIA') return { error: 'Esa tarea ya estaba completada.' };
  if (t.estado === 'NO_APLICA') return { error: 'Esa tarea está marcada como no aplica.' };

  const centro = t.centro || empleado.centro || '';
  const abierto = await turnoAbierto(db, empleado.nombre, centro);
  if (!abierto) return { error: 'Tienes que fichar tu entrada antes de poder completar tareas.' };

  const ahora = Date.now();
  const inicioTs = Number(t.ventana_inicio_ts);
  const finTs = Number(t.ventana_fin_ts);
  const limite = finTs + Number(t.tolerancia_min || 30) * 60000;
  let estadoFinal = 'COMPLETADA';
  let fueraDePlazo = false;
  if (ahora < inicioTs) fueraDePlazo = true;
  else if (ahora > limite) { fueraDePlazo = true; estadoFinal = 'COMPLETADA_TARDIA'; }
  else if (ahora > finTs) fueraDePlazo = true;

  let evidenciaId = null;
  if (t.tipo_evidencia === 'NUMERO') {
    if (extra.valor_numerico === undefined) return { error: 'Esta tarea necesita un número.' };
    const v = Number(extra.valor_numerico);
    if (Number.isNaN(v)) return { error: 'Eso no parece un número válido.' };
    let cfg = {};
    try { cfg = JSON.parse(t.evidencia_config || '{}'); } catch {}
    const fueraRango = (cfg.min !== undefined && v < Number(cfg.min)) || (cfg.max !== undefined && v > Number(cfg.max));
    const ev = await db.execute({
      sql: `INSERT INTO evidencias
            (tarea_instancia_id, familia_id, tipo, valor_numerico, unidad, texto, origen_captura, sospechosa, device_id, ts_servidor, metadatos)
            VALUES (?, ?, 'NUMERO', ?, ?, '', 'telegram', 0, ?, ?, ?)`,
      args: [instanciaId, t.familia_id, v, cfg.unidad || '', `tg:${empleado.nombre}`, ahora, JSON.stringify({ fuera_rango: !!fueraRango })],
    });
    evidenciaId = Number(ev.lastInsertRowid);
    if (fueraRango) {
      await auditar(db, req, {
        tipo_evento: 'VALOR_FUERA_DE_RANGO', entidad: 'tarea_instancias', entidad_id: instanciaId,
        empleado: empleado.nombre, centro, payload: { valor: v, config: t.evidencia_config, tarea: t.nombre },
      });
    }
  } else if (t.tipo_evidencia === 'TEXTO') {
    const texto = String(extra.texto || '').trim();
    if (!texto) return { error: 'Esta tarea necesita una anotación.' };
    const ev = await db.execute({
      sql: `INSERT INTO evidencias
            (tarea_instancia_id, familia_id, tipo, texto, origen_captura, sospechosa, device_id, ts_servidor, metadatos)
            VALUES (?, ?, 'TEXTO', ?, 'telegram', 0, ?, ?, '{}')`,
      args: [instanciaId, t.familia_id, texto, `tg:${empleado.nombre}`, ahora],
    });
    evidenciaId = Number(ev.lastInsertRowid);
  }

  await db.execute({
    sql: `UPDATE tarea_instancias
          SET estado = ?, completada_por = ?, completada_ts_servidor = ?, fuera_de_plazo = ?, evidencia_id = ?
          WHERE id = ?`,
    args: [estadoFinal, empleado.nombre, ahora, fueraDePlazo ? 1 : 0, evidenciaId, instanciaId],
  });

  await auditar(db, req, {
    tipo_evento: 'TAREA_COMPLETADA', entidad: 'tarea_instancias', entidad_id: instanciaId,
    empleado: empleado.nombre, centro,
    payload: { estado: estadoFinal, tarea: t.nombre, fuera_de_plazo: fueraDePlazo, rol_tarea: t.rol_responsable, origen_ui: 'telegram' },
  });

  // Mismo aviso al dueño que si se hubiera completado desde la app: el canal
  // de origen no debería cambiar lo que él ve.
  const horaTexto = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }).format(ahora);
  await avisarTelegram(conEnlacePanel(
    `✅ <b>${escTelegram(t.nombre)}</b> completada por ${escTelegram(empleado.nombre)} a las ${horaTexto} (por Telegram)`
    + (fueraDePlazo ? ' — fuera de plazo ⚠️' : ''),
    centro
  ));

  return { ok: true, estado: estadoFinal, nombre: t.nombre };
}

async function intentarCompletarPendiente(db, req, empleado, chatId, texto) {
  await initPendientes(db);
  const p = await db.execute({ sql: `SELECT instancia_id, tipo FROM telegram_tarea_pendiente WHERE chat_id = ?`, args: [String(chatId)] });
  if (!p.rows.length) return false;

  const { instancia_id, tipo } = p.rows[0];
  await limpiarPendiente(db, chatId);
  const extra = tipo === 'numero' ? { valor_numerico: texto.trim().replace(',', '.') } : { texto };
  const r = await completarTarea(db, req, empleado, instancia_id, extra);
  await avisarEmpleado(chatId, r.error ? `❌ ${r.error}` : `✅ <b>${escTelegram(r.nombre)}</b> registrada.`);
  return true;
}

// ── Solicitud de corrección de fichaje desde el chat ──────────
const TIPOS_FICHAJE_CORREGIR = ['entrada', 'salida', 'inicio_descanso', 'fin_descanso'];

async function initSolicitudes(db) {
  // Copia exacta del esquema de api/solicitudes.js: cualquiera de las dos
  // rutas puede ser la primera en tocar esta tabla.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS solicitudes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empleado TEXT NOT NULL,
      centro TEXT NOT NULL DEFAULT '',
      tipo_solicitud TEXT NOT NULL,
      fichaje_id INTEGER,
      tipo_fichaje TEXT NOT NULL,
      fecha TEXT NOT NULL,
      hora_original TEXT NOT NULL DEFAULT '',
      hora_propuesta TEXT NOT NULL DEFAULT '',
      motivo TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      nota_admin TEXT NOT NULL DEFAULT '',
      creado_en INTEGER NOT NULL,
      resuelto_en INTEGER
    )
  `);
}

async function crearSolicitudCorreccion(db, req, empleado, chatId, argumentos) {
  const partes = argumentos.trim().split(/\s+/).filter(Boolean);
  const usoTexto =
    'Formato: /corregir AAAA-MM-DD tipo HH:MM motivo\n' +
    'Tipo puede ser: entrada, salida, inicio_descanso o fin_descanso.\n' +
    'Ejemplo: /corregir 2026-09-05 salida 14:30 se me olvidó fichar la salida';

  if (partes.length < 4) { await avisarEmpleado(chatId, usoTexto); return; }
  const [fecha, tipoFichaje, hora, ...restoMotivo] = partes;
  const motivo = restoMotivo.join(' ').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { await avisarEmpleado(chatId, `❌ La fecha debe ser AAAA-MM-DD.\n\n${usoTexto}`); return; }
  if (!TIPOS_FICHAJE_CORREGIR.includes(tipoFichaje)) {
    await avisarEmpleado(chatId, `❌ El tipo debe ser uno de: ${TIPOS_FICHAJE_CORREGIR.join(', ')}.\n\n${usoTexto}`);
    return;
  }
  if (!/^\d{1,2}:\d{2}$/.test(hora)) { await avisarEmpleado(chatId, `❌ La hora debe ser HH:MM.\n\n${usoTexto}`); return; }
  if (!motivo) { await avisarEmpleado(chatId, `❌ Falta el motivo.\n\n${usoTexto}`); return; }

  await initSolicitudes(db);
  const centro = empleado.centro || '';
  const r = await db.execute({
    sql: `INSERT INTO solicitudes (empleado, centro, tipo_solicitud, tipo_fichaje, fecha, hora_propuesta, motivo, estado, creado_en)
          VALUES (?, ?, 'modificar', ?, ?, ?, ?, 'pendiente', ?)`,
    args: [empleado.nombre, centro, tipoFichaje, fecha, `${hora}:00`, motivo, Date.now()],
  });

  await auditar(db, req, {
    tipo_evento: 'SOLICITUD_CREADA', entidad: 'solicitudes', entidad_id: r.lastInsertRowid?.toString(),
    empleado: empleado.nombre, centro, payload: { tipo_fichaje: tipoFichaje, fecha, hora_propuesta: hora, origen: 'telegram' },
  });

  await avisarTelegram(conEnlacePanel(
    `✏️ <b>${escTelegram(empleado.nombre)}</b> ha pedido corregir su ${escTelegram(tipoFichaje.replace(/_/g, ' '))} `
    + `del ${fecha} a las ${escTelegram(hora)} (por Telegram).\nMotivo: ${escTelegram(motivo)}`,
    centro
  ));
  await avisarEmpleado(chatId, '✅ Solicitud enviada. Te aviso en cuanto se resuelva.');
}

// ── Incidencias y faltas desde el chat ─────────────────────────
async function initTurnoNotas(db) {
  // Copia exacta del esquema de api/turno-notas.js, por la misma razón que
  // initSolicitudes: cualquiera de las dos rutas puede llegar primero.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS turno_notas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      centro TEXT NOT NULL DEFAULT '',
      fecha_operativa TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'nota',
      texto TEXT NOT NULL,
      autor TEXT NOT NULL DEFAULT '',
      prioridad TEXT NOT NULL DEFAULT 'normal',
      estado TEXT NOT NULL DEFAULT '',
      resuelto_por TEXT NOT NULL DEFAULT '',
      resuelto_en INTEGER,
      resolucion TEXT NOT NULL DEFAULT '',
      foto_b64 TEXT,
      hash_sha256 TEXT NOT NULL DEFAULT '',
      device_id TEXT NOT NULL DEFAULT '',
      creado_en INTEGER NOT NULL
    )
  `);
}

async function crearNotaTurno(db, req, empleado, cfg, chatId, tipo, argumentos) {
  const texto = String(argumentos || '').trim();
  const ejemplo = tipo === 'incidencia'
    ? 'Ejemplo: /incidencia se ha roto el grifo de la barra'
    : 'Ejemplo: /falta hielo';
  if (!texto) { await avisarEmpleado(chatId, `Escribe qué pasa después del comando.\n${ejemplo}`); return; }
  if (texto.length > 1000) { await avisarEmpleado(chatId, '❌ Ese texto es demasiado largo.'); return; }

  await initTurnoNotas(db);
  const centro = empleado.centro || '';
  const fechaOperativa = fechaOperativaDe(Date.now(), cfg);

  const r = await db.execute({
    sql: `INSERT INTO turno_notas (centro, fecha_operativa, tipo, texto, autor, prioridad, estado, creado_en)
          VALUES (?, ?, ?, ?, ?, 'normal', 'abierta', ?)`,
    args: [centro, fechaOperativa, tipo, texto, empleado.nombre, Date.now()],
  });

  await auditar(db, req, {
    tipo_evento: tipo === 'incidencia' ? 'INCIDENCIA_ABIERTA' : 'FALTA_PRODUCTO',
    entidad: 'turno_notas', entidad_id: r.lastInsertRowid?.toString(),
    empleado: empleado.nombre, centro, payload: { texto: texto.slice(0, 200), origen: 'telegram' },
  });

  const emoji = tipo === 'incidencia' ? '🔧' : '📦';
  const titulo = tipo === 'incidencia' ? 'Nueva incidencia' : 'Se ha acabado algo';
  await avisarTelegram(conEnlacePanel(
    `${emoji} ${titulo} en ${escTelegram(centro)}: ${escTelegram(texto)} (por Telegram).\n(${escTelegram(empleado.nombre)})`,
    centro
  ));
  await avisarEmpleado(chatId, '✅ Anotado. Gracias.');
}

// ── Dispatch ────────────────────────────────────────────────────

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

  const esBoton = !!BOTON_A_COMANDO[texto];
  const esComando = texto.startsWith('/');

  // Si había una tarea de NUMERO o TEXTO esperando respuesta, cualquier texto
  // normal se interpreta como esa respuesta — salvo que sea justo un comando
  // o un botón, que se entiende como que la persona ha cambiado de tema.
  if (!esBoton && !esComando) {
    const atendido = await intentarCompletarPendiente(db, req, empleado, chatId, texto);
    if (atendido) return;
  } else {
    await limpiarPendiente(db, chatId);
  }

  // Un botón del teclado manda su etiqueta tal cual, como si se hubiera
  // escrito el comando a mano.
  const comando = BOTON_A_COMANDO[texto] || comandoDe(texto);
  const argumentos = argumentosDe(texto);

  if (comando === '/salir') return desvincular(db, req, empleado, chatId);
  if (comando === '/ayuda' || comando === '/start') return enviarAyuda(chatId, empleado);

  const cfg = await getCentroCfg(db, empleado.centro || '');
  if (comando === '/horario') return responderHorario(db, empleado, chatId);
  if (comando === '/horas') return responderHoras(db, empleado, chatId, cfg);
  if (comando === '/tareas') return responderTareas(db, empleado, chatId, cfg);
  if (comando === '/corregir') return crearSolicitudCorreccion(db, req, empleado, chatId, argumentos);
  if (comando === '/incidencia') return crearNotaTurno(db, req, empleado, cfg, chatId, 'incidencia', argumentos);
  if (comando === '/falta') return crearNotaTurno(db, req, empleado, cfg, chatId, 'falta', argumentos);

  return enviarAyuda(chatId, empleado);
}

async function manejarCallback(db, req, callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  if (chatId === undefined || chatId === null) return;

  const empleado = await identificarPorTelegramChatId(db, chatId);
  if (!empleado) {
    await responderCallbackEmpleado(callbackQuery.id, 'Vincúlate primero escribiendo tu PIN.');
    return;
  }

  const datos = String(callbackQuery.data || '');
  const [accion, idTexto] = datos.split(':');
  const instanciaId = Number(idTexto);
  if (!Number.isFinite(instanciaId)) {
    await responderCallbackEmpleado(callbackQuery.id);
    return;
  }

  if (accion === 'tgcompletar') {
    const r = await completarTarea(db, req, empleado, instanciaId, {});
    await responderCallbackEmpleado(callbackQuery.id, r.error ? `❌ ${r.error}` : '✅ Hecho');
    return;
  }
  if (accion === 'tgnumero' || accion === 'tgtexto') {
    await guardarPendiente(db, chatId, instanciaId, accion === 'tgnumero' ? 'numero' : 'texto');
    await responderCallbackEmpleado(callbackQuery.id, accion === 'tgnumero' ? 'Mándame el número' : 'Mándame el texto');
    await avisarEmpleado(chatId, accion === 'tgnumero' ? '✏️ Escribe el número para esa tarea.' : '✏️ Escribe la anotación para esa tarea.');
    return;
  }
  await responderCallbackEmpleado(callbackQuery.id);
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
    if (update.callback_query) await manejarCallback(db, req, update.callback_query);
    else if (update.message?.text) await manejarMensaje(db, req, update.message);
    // Siempre 200: Telegram reintenta el mismo update si no responde rápido.
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(200).json({ ok: true });
  }
}
