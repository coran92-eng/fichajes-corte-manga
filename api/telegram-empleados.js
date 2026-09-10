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
 * Comandos, una vez vinculado — TODOS tienen su botón fijo debajo del chat,
 * para que se vea de un vistazo todo lo que el bot puede hacer, sin tener que
 * conocer ni escribir ningún comando:
 *   /horario   → sus próximos turnos.
 *   /horas     → horas trabajadas esta semana y este mes.
 *   /tareas    → tareas de hoy de su rol, con botones para completar las que
 *                no llevan foto (las que sí, hay que hacerlas desde la app).
 *   /fichar    → fichar compartiendo ubicación, si el centro lo tiene activado.
 *   /corregir  → pedir corregir un fichaje: el botón abre un asistente guiado
 *                (fecha, movimiento y hora con botones, motivo escrito) — para
 *                quien prefiera escribirlo del tirón, se admite igual todo en
 *                una línea: AAAA-MM-DD tipo HH:MM motivo.
 *   /incidencia, /falta → dejar aviso de algo roto o agotado; el botón
 *                pregunta qué pasa, o se puede escribir todo junto.
 *   /salir     → desvincular esta conversación.
 *
 * Completar tareas por Telegram: SOLO las de tipo CHECK, NUMERO o TEXTO. Las
 * que llevan foto no se pueden completar desde aquí —el bot no sabe recibir
 * ni adjuntar una foto a una tarea—, así que se avisa de que hay que abrir
 * la app. Cualquier tarea —lleve foto o no— exige turno abierto: no se
 * puede completar nada sin haber fichado la entrada, igual que en la app.
 *
 * Fichar por Telegram (/fichar): solo si gerencia ha activado la ubicación
 * del centro (panel → Redes y dispositivos). Se compara la ubicación que
 * comparte el empleado contra la del local con la fórmula de Haversine; si
 * queda fuera del radio configurado, o si el mensaje de ubicación viene
 * reenviado (no compartido en el momento), no se registra nada. Es un
 * modelo de confianza DISTINTO al de la app (red del bar + código QR
 * rotatorio): más cómodo, pero también falsificable con apps de ubicación
 * falsa — es la decisión que se tomó conscientemente al activarlo, no un
 * descuido.
 */
import { getDbClient } from "./_db.js";
import {
  initSchema, getCentroCfg, fechaOperativaDe, epochDesdeLocal, auditar,
  identificarPorPin, identificarPorTelegramChatId, vincularTelegram, desvincularTelegram,
  minutosTrabajados, esDelRol, generarInstancias, marcarVencidas, turnoAbierto, estaEnDescanso,
  hayUbicacionConfigurada, distanciaMetros, centroDeEmpleado, DENOMINACIONES,
} from "./_tareas-lib.js";
import {
  turnoActivo as cajaTurnoActivo, progresoHoy as cajaProgresoHoy,
  crearApertura as cajaCrearApertura, confirmarApertura as cajaConfirmarApertura,
  guardarCierre as cajaGuardarCierre,
} from "./caja.js";
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
  '/fichar — fichar compartiendo tu ubicación (si tu centro lo tiene activado)\n' +
  '/caja — abrir o cerrar la caja del turno (el botón te guía paso a paso)\n' +
  '/corregir — pedir corregir un fichaje (el botón te guía paso a paso)\n' +
  '/incidencia — avisar de algo roto o averiado (el botón te pregunta qué pasa)\n' +
  '/falta — avisar de que se ha acabado algo (el botón te pregunta qué)\n' +
  '/salir — desvincular esta conversación\n\n' +
  'Todo lo de arriba tiene su botón fijo debajo del chat: no hace falta escribir ni recordar nada.';

// Botones fijos debajo del chat: TODO lo que el bot sabe hacer tiene aquí su
// botón, para que se vea de un vistazo el alcance real sin tener que conocer
// ni un solo comando. Es un teclado normal de Telegram (no botones inline
// sobre un mensaje): al tocar uno, Telegram manda su texto tal cual, como si
// el empleado lo hubiera escrito — por eso la clave de este mapa tiene que
// ser exactamente la etiqueta del botón. /corregir, /incidencia y /falta
// tocados como botón (sin nada detrás) arrancan un asistente guiado en vez
// de exigir escribirlo todo en una línea — ver iniciarFlujoCorregir/Nota.
const BOTON_A_COMANDO = {
  '📅 Mi horario': '/horario',
  '🕐 Mis horas': '/horas',
  '📋 Tareas de hoy': '/tareas',
  '📍 Fichar': '/fichar',
  '💰 Caja': '/caja',
  '✏️ Corregir fichaje': '/corregir',
  '🔧 Incidencia': '/incidencia',
  '📦 Falta de producto': '/falta',
  '❓ Ayuda': '/ayuda',
  '🚪 Salir': '/salir',
};

// El teclado (TECLADO_PRINCIPAL) vive en _telegram-empleados.js y se aplica
// solo con recibir cualquier aviso — ver el comentario de avisarEmpleado ahí.

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
    chatId, `Hola, <b>${escTelegram(empleado.nombre)}</b>. Puedo con esto (o toca uno de los botones de abajo):\n\n${AYUDA_TEXTO}`
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
    chatId, `✅ Listo, <b>${escTelegram(empleado.nombre)}</b>. Usa los botones de abajo, o escríbeme:\n\n${AYUDA_TEXTO}`
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
  if (pendiente && llevaFoto) linea += ' — lleva foto, complétala desde la app';
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
  // porque este bot no sabe recibir ni adjuntar una foto a una tarea.
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
    return { error: 'Esta tarea lleva foto: complétala desde la app.' };
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

// ── Fichar compartiendo ubicación ──────────────────────────────
const VERBO_FICHAJE_LARGO = {
  entrada: 'tu entrada', salida: 'tu salida',
  inicio_descanso: 'el inicio de tu descanso', fin_descanso: 'la vuelta de tu descanso',
};

let fichajePendienteListo = false;
async function initFichajePendiente(db) {
  if (fichajePendienteListo) return;
  await db.execute(`
    CREATE TABLE IF NOT EXISTS telegram_fichaje_pendiente (
      chat_id TEXT PRIMARY KEY,
      tipo TEXT NOT NULL,
      creado_en INTEGER NOT NULL
    )
  `);
  fichajePendienteListo = true;
}

async function guardarFichajePendiente(db, chatId, tipo) {
  await initFichajePendiente(db);
  await db.execute({
    sql: `INSERT INTO telegram_fichaje_pendiente (chat_id, tipo, creado_en) VALUES (?, ?, ?)
          ON CONFLICT(chat_id) DO UPDATE SET tipo = excluded.tipo, creado_en = excluded.creado_en`,
    args: [String(chatId), tipo, Date.now()],
  });
}

async function limpiarFichajePendiente(db, chatId) {
  await initFichajePendiente(db);
  await db.execute({ sql: `DELETE FROM telegram_fichaje_pendiente WHERE chat_id = ?`, args: [String(chatId)] });
}

/** "10/09/2026" y "14:32:07" en la zona horaria del centro. */
function fechaYHoraLocal(ts, tz) {
  const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
  const hora = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ts));
  return { fecha, hora };
}

/**
 * Qué se puede fichar ahora mismo, según el último movimiento: sin turno
 * abierto solo cabe la entrada; con turno abierto y sin descanso, salida o
 * empezar el descanso; en descanso, solo volver de él. Mismas reglas que ya
 * sigue la app, para no permitir aquí una secuencia que allí no se aceptaría.
 */
async function opcionesDeFichaje(db, empleado, centro) {
  const abierto = await turnoAbierto(db, empleado.nombre, centro);
  if (!abierto) return ['entrada'];
  const enDescanso = await estaEnDescanso(db, empleado.nombre, centro);
  return enDescanso ? ['fin_descanso'] : ['salida', 'inicio_descanso'];
}

async function iniciarFichaje(db, empleado, chatId, cfg) {
  if (!hayUbicacionConfigurada(cfg)) {
    await avisarEmpleado(chatId, 'El fichaje por Telegram no está activado para tu centro todavía. Sigue fichando desde el móvil o el iPad del bar.');
    return;
  }
  const centro = cfg.centro || empleado.centro || '';
  const opciones = await opcionesDeFichaje(db, empleado, centro);

  if (opciones.length === 1) {
    await guardarFichajePendiente(db, chatId, opciones[0]);
    await avisarEmpleado(chatId,
      `📍 Para fichar ${VERBO_FICHAJE_LARGO[opciones[0]]}, comparte tu ubicación: toca el clip 📎 → Ubicación → Enviar mi ubicación actual.`
    );
    return;
  }

  const ETIQUETA = { salida: '🔴 Salida', inicio_descanso: '☕ Iniciar descanso' };
  await avisarEmpleado(chatId, '¿Qué quieres fichar?', {
    reply_markup: { inline_keyboard: [opciones.map(t => ({ text: ETIQUETA[t], callback_data: `tgfichar:${t}` }))] },
  });
}

async function pedirUbicacionParaFichaje(db, chatId, tipo) {
  await guardarFichajePendiente(db, chatId, tipo);
  await avisarEmpleado(chatId,
    `📍 Para fichar ${VERBO_FICHAJE_LARGO[tipo]}, comparte tu ubicación: toca el clip 📎 → Ubicación → Enviar mi ubicación actual.`
  );
}

/**
 * Registra el fichaje si la ubicación compartida cae dentro del radio del
 * centro. No es la app: aquí no hay red del bar ni código QR que demuestren
 * presencia, así que esta comprobación ES la prueba de presencia — de ahí
 * que se rechacen sin contemplaciones las ubicaciones reenviadas (alguien
 * podría reenviarse a sí mismo una ubicación de otro momento) y las que
 * caen fuera del radio, sin margen de duda.
 */
async function ficharPorUbicacion(db, req, empleado, chatId, message) {
  await initFichajePendiente(db);
  const p = await db.execute({ sql: `SELECT tipo FROM telegram_fichaje_pendiente WHERE chat_id = ?`, args: [String(chatId)] });
  if (!p.rows.length) {
    await avisarEmpleado(chatId, 'No te había pedido ninguna ubicación. Escribe /fichar primero.');
    return;
  }
  const tipo = p.rows[0].tipo;

  if (message.forward_date || message.forward_origin || message.forward_from) {
    await avisarEmpleado(chatId, '❌ Esa ubicación viene reenviada, no compartida ahora mismo. No se ha registrado el fichaje.');
    return;
  }

  const centro = empleado.centro || '';
  const cfg = await getCentroCfg(db, centro);
  if (!hayUbicacionConfigurada(cfg)) {
    await limpiarFichajePendiente(db, chatId);
    await avisarEmpleado(chatId, 'El fichaje por Telegram ya no está activado para tu centro.');
    return;
  }

  const distancia = distanciaMetros(
    message.location.latitude, message.location.longitude,
    Number(cfg.ubicacion_lat), Number(cfg.ubicacion_lng)
  );
  if (distancia > cfg.radio_fichaje_m) {
    // No se limpia el pendiente: puede ser un GPS impreciso momentáneo, y
    // tiene sentido dejar que lo intente otra vez sin repetir /fichar.
    await avisarEmpleado(chatId, `❌ Estás a ${Math.round(distancia)} m del local (máximo ${cfg.radio_fichaje_m} m). No se ha registrado el fichaje.`);
    return;
  }

  // Puede que el estado haya cambiado entre /fichar y ahora (otro fichaje de
  // por medio, o dos toques seguidos): se revalida antes de escribir nada.
  const vigentes = await opcionesDeFichaje(db, empleado, centro);
  if (!vigentes.includes(tipo)) {
    await limpiarFichajePendiente(db, chatId);
    await avisarEmpleado(chatId, 'Eso ya no encaja con tu turno actual. Escribe /fichar de nuevo.');
    return;
  }

  await limpiarFichajePendiente(db, chatId);

  const ahora = Date.now();
  const { fecha, hora } = fechaYHoraLocal(ahora, cfg.zona_horaria);
  const distanciaRedondeada = Math.round(distancia);
  const result = await db.execute({
    sql: `INSERT INTO fichajes (empleado, tipo, fecha, hora, timestamp, centro, device_id, motivo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      empleado.nombre, tipo, fecha, hora, ahora, centro, `tg:${chatId}`,
      `Fichado por Telegram compartiendo ubicación (a ${distanciaRedondeada} m del local).`,
    ],
  });

  await auditar(db, req, {
    tipo_evento: 'FICHAJE_POR_TELEGRAM', entidad: 'fichajes', entidad_id: result.lastInsertRowid?.toString(),
    empleado: empleado.nombre, centro, device_id: `tg:${chatId}`,
    payload: { tipo, distancia_m: distanciaRedondeada },
  });

  await avisarEmpleado(chatId, `✅ Registrado: ${VERBO_FICHAJE_LARGO[tipo]} a las ${hora.slice(0, 5)}.`);

  const VERBO_CORTO = { entrada: 'entrada', salida: 'salida', inicio_descanso: 'inicio de descanso', fin_descanso: 'vuelta de descanso' };
  await avisarTelegram(conEnlacePanel(
    `📍 <b>${escTelegram(empleado.nombre)}</b> ha fichado su ${VERBO_CORTO[tipo]} a las ${hora.slice(0, 5)} por Telegram `
    + `(a ${distanciaRedondeada} m del local).`,
    centro
  ));
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

/** Núcleo compartido por la vía directa (una línea) y el asistente guiado. */
async function guardarSolicitudCorreccion(db, req, empleado, chatId, fecha, tipoFichaje, hora, motivo) {
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

  await guardarSolicitudCorreccion(db, req, empleado, chatId, fecha, tipoFichaje, hora, motivo);
}

// ── Asistente guiado: /corregir e /incidencia y /falta tocados como botón ──
// Un chat de Telegram no tiene formularios: la alternativa a "escribe todo
// en una línea con este formato exacto" es preguntar un dato cada vez, igual
// que ya se hace para completar tareas NUMERO/TEXTO o para fichar por
// ubicación. Estado en la misma línea que `telegram_tarea_pendiente` /
// `telegram_fichaje_pendiente`: una fila por chat, se sobrescribe si se
// vuelve a arrancar, y cualquier otra acción (comando, botón u otro asistente)
// la cancela — ver limpiarTodosPendientes.
let flujoPendienteListo = false;
async function initFlujoPendiente(db) {
  if (flujoPendienteListo) return;
  await db.execute(`
    CREATE TABLE IF NOT EXISTS telegram_flujo_pendiente (
      chat_id TEXT PRIMARY KEY,
      flujo TEXT NOT NULL,
      paso TEXT NOT NULL,
      datos TEXT NOT NULL DEFAULT '{}',
      creado_en INTEGER NOT NULL
    )
  `);
  flujoPendienteListo = true;
}

async function guardarFlujo(db, chatId, flujo, paso, datos) {
  await initFlujoPendiente(db);
  await db.execute({
    sql: `INSERT INTO telegram_flujo_pendiente (chat_id, flujo, paso, datos, creado_en) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(chat_id) DO UPDATE SET flujo = excluded.flujo, paso = excluded.paso, datos = excluded.datos, creado_en = excluded.creado_en`,
    args: [String(chatId), flujo, paso, JSON.stringify(datos || {}), Date.now()],
  });
}

async function leerFlujo(db, chatId) {
  await initFlujoPendiente(db);
  const r = await db.execute({ sql: `SELECT flujo, paso, datos FROM telegram_flujo_pendiente WHERE chat_id = ?`, args: [String(chatId)] });
  if (!r.rows.length) return null;
  let datos = {};
  try { datos = JSON.parse(r.rows[0].datos || '{}'); } catch {}
  return { flujo: r.rows[0].flujo, paso: r.rows[0].paso, datos };
}

async function limpiarFlujo(db, chatId) {
  await initFlujoPendiente(db);
  await db.execute({ sql: `DELETE FROM telegram_flujo_pendiente WHERE chat_id = ?`, args: [String(chatId)] });
}

/** Cancela cualquier otra cosa que estuviera esperando respuesta, al empezar algo nuevo. */
async function limpiarTodosPendientes(db, chatId) {
  await limpiarPendiente(db, chatId);
  await limpiarFichajePendiente(db, chatId);
  await limpiarFlujo(db, chatId);
}

async function iniciarFlujoCorregir(db, chatId) {
  await guardarFlujo(db, chatId, 'corregir', 'fecha', {});
  await avisarEmpleado(chatId, '📅 ¿Qué día quieres corregir? Elige un botón, o escribe la fecha en formato AAAA-MM-DD.', {
    reply_markup: { inline_keyboard: [[
      { text: 'Hoy', callback_data: 'tgflujo:fecha:hoy' },
      { text: 'Ayer', callback_data: 'tgflujo:fecha:ayer' },
    ]] },
  });
}

async function avanzarFlujoCorregirFecha(db, chatId, fecha) {
  await guardarFlujo(db, chatId, 'corregir', 'tipo', { fecha });
  await avisarEmpleado(chatId, '¿Qué movimiento fue? Elige uno:', {
    reply_markup: { inline_keyboard: [
      [{ text: 'Entrada', callback_data: 'tgflujo:tipo:entrada' }, { text: 'Salida', callback_data: 'tgflujo:tipo:salida' }],
      [{ text: 'Inicio descanso', callback_data: 'tgflujo:tipo:inicio_descanso' }, { text: 'Fin descanso', callback_data: 'tgflujo:tipo:fin_descanso' }],
    ] },
  });
}

async function avanzarFlujoCorregirTipo(db, chatId, datosPrevios, tipoFichaje) {
  await guardarFlujo(db, chatId, 'corregir', 'hora', { ...datosPrevios, tipoFichaje });
  await avisarEmpleado(chatId, '¿A qué hora debería estar? Escríbela en formato HH:MM.');
}

async function iniciarFlujoNota(db, chatId, tipo) {
  await guardarFlujo(db, chatId, tipo, 'texto', {});
  const pregunta = tipo === 'incidencia' ? '🔧 ¿Qué incidencia hay? Escríbela.' : '📦 ¿Qué se ha acabado? Escríbelo.';
  await avisarEmpleado(chatId, pregunta);
}

/** Callback de un botón del asistente (fecha o tipo de fichaje). */
async function avanzarFlujoCallback(db, empleado, chatId, campo, valor) {
  const flujo = await leerFlujo(db, chatId);
  if (!flujo || flujo.flujo !== 'corregir') return; // asistente ya cancelado o caducado: botón obsoleto, se ignora

  if (campo === 'fecha' && flujo.paso === 'fecha') {
    const cfg = await getCentroCfg(db, empleado.centro || '');
    const ahora = fechaYHoraLocal(Date.now(), cfg.zona_horaria).fecha;
    const ayer = fechaYHoraLocal(Date.now() - 24 * 60 * 60 * 1000, cfg.zona_horaria).fecha;
    await avanzarFlujoCorregirFecha(db, chatId, valor === 'hoy' ? ahora : ayer);
  } else if (campo === 'tipo' && flujo.paso === 'tipo') {
    await avanzarFlujoCorregirTipo(db, chatId, flujo.datos, valor);
  }
}

/**
 * Continúa un asistente a partir de un mensaje de texto normal (no comando ni
 * botón). Devuelve true si el mensaje era la respuesta que el asistente
 * esperaba (para que manejarMensaje no lo trate como otra cosa).
 */
async function intentarContinuarFlujo(db, req, empleado, chatId, texto) {
  const flujo = await leerFlujo(db, chatId);
  if (!flujo) return false;
  const valor = texto.trim();

  if (flujo.flujo === 'corregir') {
    if (flujo.paso === 'fecha') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
        await avisarEmpleado(chatId, '❌ La fecha debe ser AAAA-MM-DD (o toca Hoy/Ayer arriba).');
        return true;
      }
      await avanzarFlujoCorregirFecha(db, chatId, valor);
      return true;
    }
    if (flujo.paso === 'tipo') {
      const tipoFichaje = valor.toLowerCase();
      if (!TIPOS_FICHAJE_CORREGIR.includes(tipoFichaje)) {
        await avisarEmpleado(chatId, `❌ El tipo debe ser uno de: ${TIPOS_FICHAJE_CORREGIR.join(', ')} (o toca uno de los botones de arriba).`);
        return true;
      }
      await avanzarFlujoCorregirTipo(db, chatId, flujo.datos, tipoFichaje);
      return true;
    }
    if (flujo.paso === 'hora') {
      if (!/^\d{1,2}:\d{2}$/.test(valor)) {
        await avisarEmpleado(chatId, '❌ La hora debe ser HH:MM.');
        return true;
      }
      await guardarFlujo(db, chatId, 'corregir', 'motivo', { ...flujo.datos, hora: valor });
      await avisarEmpleado(chatId, '¿Qué pasó? Cuéntamelo brevemente.');
      return true;
    }
    if (flujo.paso === 'motivo') {
      if (!valor) { await avisarEmpleado(chatId, '❌ Falta el motivo.'); return true; }
      await limpiarFlujo(db, chatId);
      const { fecha, tipoFichaje, hora } = flujo.datos;
      await guardarSolicitudCorreccion(db, req, empleado, chatId, fecha, tipoFichaje, hora, valor);
      return true;
    }
  }

  if ((flujo.flujo === 'incidencia' || flujo.flujo === 'falta') && flujo.paso === 'texto') {
    await limpiarFlujo(db, chatId);
    const cfg = await getCentroCfg(db, empleado.centro || '');
    await crearNotaTurno(db, req, empleado, cfg, chatId, flujo.flujo, texto);
    return true;
  }

  if (flujo.flujo === 'caja') {
    return await continuarFlujoCaja(db, req, chatId, flujo, valor);
  }

  return false;
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

// ── Cierre de caja desde el chat ────────────────────────────────
// Asistente guiado (misma maquinaria de telegram_flujo_pendiente que
// /corregir): pedir los 15 tramos de billete/moneda uno a uno sería
// tedioso, así que se piden en una sola línea con un orden fijo — igual
// que /corregir admite "todo en una línea" para quien no quiere ir paso a
// paso. Todas las escrituras van por las mismas funciones que usa
// api/caja.js (crearApertura, confirmarApertura, guardarCierre), así que
// da igual si el turno se abre o se cierra desde el panel o desde aquí:
// es el mismo camino, las mismas fórmulas y el mismo aviso al dueño.
const ETIQUETA_TURNO_CAJA = { manana: 'Turno 1 (mañana)', tarde: 'Turno 2 (tarde)' };
const EMOJI_SEMAFORO_CAJA = { verde: '🟢', naranja: '🟠', rojo: '🔴' };

function eurosTexto(n) {
  if (n === null || n === undefined) return '—';
  return `${(Math.round(Number(n) * 100) / 100).toFixed(2).replace('.', ',')} €`;
}
function firmadoTexto(n) {
  const v = Number(n) || 0;
  return (v > 0 ? '+' : '') + eurosTexto(v);
}

function plantillaDesglose() {
  return DENOMINACIONES.map(d => (d.valor >= 1 ? String(d.valor) : d.valor.toFixed(2))).join(' ');
}

/** 15 números en el orden fijo de DENOMINACIONES, separados por espacio. Cuentas, no importes: enteros ≥ 0. */
function parseDesgloseTexto(texto) {
  const partes = String(texto || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length !== DENOMINACIONES.length) {
    return { ok: false, error: `Tienen que ser ${DENOMINACIONES.length} números separados por espacio, en este orden (de 500€ a 1 céntimo):\n<code>${plantillaDesglose()}</code>` };
  }
  const desglose = {};
  for (let i = 0; i < DENOMINACIONES.length; i++) {
    const n = Number(String(partes[i]).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return { ok: false, error: `"${escTelegram(partes[i])}" no es un número entero válido — son cuántos billetes/monedas hay, no un importe.` };
    }
    desglose[DENOMINACIONES[i].clave] = n;
  }
  return { ok: true, desglose };
}

/** Un número suelto, en euros, ≥ 0. */
function parseImporteTexto(texto) {
  const n = Number(String(texto || '').trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function pedirDesgloseApertura(db, chatId, turno, centro) {
  const cabecera = `💰 Abriendo <b>${escTelegram(ETIQUETA_TURNO_CAJA[turno.turno] || turno.turno)}</b> (${turno.fecha}).`;
  if (turno.apertura_fondo_editable) {
    await guardarFlujo(db, chatId, 'caja', 'apertura_fondo', { centro, turnoId: turno.id });
    await avisarEmpleado(chatId, `${cabecera}\nNo se encontró el fondo del turno anterior. ¿Cuánto fondo de caja inicial pones? Escribe solo el número, en euros.`);
    return;
  }
  await guardarFlujo(db, chatId, 'caja', 'apertura_desglose', { centro, turnoId: turno.id, fondoManual: null });
  await avisarEmpleado(chatId, `${cabecera}\nFondo heredado: <b>${eurosTexto(turno.apertura_fondo_heredado)}</b>.\nEnvíame el desglose del cajón: ${DENOMINACIONES.length} números en este orden, separados por espacio.\n\n<code>${plantillaDesglose()}</code>`);
}

async function iniciarFlujoCaja(db, req, empleado, chatId) {
  const centro = await centroDeEmpleado(db, empleado.nombre, empleado.centro || '');
  const activo = await cajaTurnoActivo(db, centro);

  if (!activo || activo.estado === 'cerrado') {
    await guardarFlujo(db, chatId, 'caja', 'elegir_turno', { centro });
    await avisarEmpleado(chatId, '💰 ¿Qué turno vas a abrir?', {
      reply_markup: { inline_keyboard: [[
        { text: '🌅 Turno 1 (mañana)', callback_data: 'tgcaja:manana' },
        { text: '🌆 Turno 2 (tarde)', callback_data: 'tgcaja:tarde' },
      ]] },
    });
    return;
  }

  if (String(activo.empleado).trim().toLowerCase() !== empleado.nombre.trim().toLowerCase()) {
    const verbo = activo.estado === 'pendiente' ? 'la apertura de' : 'este turno de caja de';
    await avisarEmpleado(chatId, `${escTelegram(activo.empleado)} ha empezado ${verbo} ${escTelegram(ETIQUETA_TURNO_CAJA[activo.turno] || activo.turno)} y no lo he terminado con nadie más. Que lo continúe ella, o pide a gerencia que lo revise.`);
    return;
  }

  if (activo.estado === 'pendiente') {
    await pedirDesgloseApertura(db, chatId, activo, centro);
    return;
  }

  // apertura_ok | reabierto
  await guardarFlujo(db, chatId, 'caja', 'cierre_desglose', { centro, turnoId: activo.id, turno: activo.turno, fecha: activo.fecha });
  await avisarEmpleado(chatId, `💰 Cerrando <b>${escTelegram(ETIQUETA_TURNO_CAJA[activo.turno] || activo.turno)}</b> (${activo.fecha}).\nEnvíame el desglose del cajón: ${DENOMINACIONES.length} números en este orden, separados por espacio.\n\n<code>${plantillaDesglose()}</code>`);
}

/** Botón de "Turno 1"/"Turno 2" al elegir qué apertura empezar. */
async function avanzarFlujoCajaTurno(db, req, empleado, chatId, turno) {
  const flujo = await leerFlujo(db, chatId);
  if (!flujo || flujo.flujo !== 'caja' || flujo.paso !== 'elegir_turno') return;
  const centro = flujo.datos.centro;

  const r = await cajaCrearApertura(db, req, { centro, turno, empleado: empleado.nombre });
  if (!r.ok) {
    await limpiarFlujo(db, chatId);
    await avisarEmpleado(chatId, `❌ ${r.error}`);
    return;
  }
  const activo = await cajaTurnoActivo(db, centro);
  await pedirDesgloseApertura(db, chatId, activo, centro);
}

/** Continúa el asistente de caja a partir de un mensaje de texto (siempre devuelve true: el texto ya se ha usado). */
async function continuarFlujoCaja(db, req, chatId, flujo, valor) {
  if (flujo.paso === 'apertura_fondo') {
    const n = parseImporteTexto(valor);
    if (n === null) { await avisarEmpleado(chatId, '❌ Escribe solo el número del fondo, en euros (ej. 100).'); return true; }
    await guardarFlujo(db, chatId, 'caja', 'apertura_desglose', { ...flujo.datos, fondoManual: n });
    await avisarEmpleado(chatId, `Envíame el desglose del cajón: ${DENOMINACIONES.length} números en este orden, separados por espacio.\n\n<code>${plantillaDesglose()}</code>`);
    return true;
  }

  if (flujo.paso === 'apertura_desglose') {
    const p = parseDesgloseTexto(valor);
    if (!p.ok) { await avisarEmpleado(chatId, `❌ ${p.error}`); return true; }
    await limpiarFlujo(db, chatId);
    const r = await cajaConfirmarApertura(db, req, { id: flujo.datos.turnoId, desglose: p.desglose, fondoManual: flujo.datos.fondoManual });
    if (!r.ok) { await avisarEmpleado(chatId, `❌ ${r.error}`); return true; }
    await avisarEmpleado(chatId, `✅ Apertura confirmada. Total contado: ${eurosTexto(r.total_contado)}. Diferencia: ${firmadoTexto(r.diferencia)}.`);
    return true;
  }

  if (flujo.paso === 'cierre_desglose') {
    const p = parseDesgloseTexto(valor);
    if (!p.ok) { await avisarEmpleado(chatId, `❌ ${p.error}`); return true; }
    await guardarFlujo(db, chatId, 'caja', 'cierre_fondo', { ...flujo.datos, desglose: p.desglose });
    await avisarEmpleado(chatId, '¿Cuánto fondo dejas para el siguiente turno? Escribe solo el número, en euros.');
    return true;
  }

  if (flujo.paso === 'cierre_fondo') {
    const n = parseImporteTexto(valor);
    if (n === null) { await avisarEmpleado(chatId, '❌ Escribe solo el número del fondo, en euros.'); return true; }
    await guardarFlujo(db, chatId, 'caja', 'cierre_tpv', { ...flujo.datos, fondoDefinido: n });
    await avisarEmpleado(chatId, 'Ahora el TPV: 3 números separados por espacio — efectivo, tarjeta y voids (pon 0 si no hay).\nEjemplo: 100 30 0');
    return true;
  }

  if (flujo.paso === 'cierre_tpv') {
    const partes = valor.trim().split(/\s+/).map(x => Number(String(x).replace(',', '.')));
    if (partes.length !== 3 || partes.some(n => !Number.isFinite(n) || n < 0)) {
      await avisarEmpleado(chatId, '❌ Tienen que ser 3 números (efectivo tarjeta voids), separados por espacio. Ejemplo: 100 30 0');
      return true;
    }
    await guardarFlujo(db, chatId, 'caja', 'cierre_tickets', {
      ...flujo.datos, tpvEfectivo: partes[0], tpvTarjeta: partes[1], tpvVoids: partes[2],
    });
    await avisarEmpleado(chatId, '¿Cuántos tickets? Escribe el número, o "-" si no lo llevas.');
    return true;
  }

  if (flujo.paso === 'cierre_tickets') {
    let tickets = null;
    const limpio = valor.trim();
    if (limpio !== '-' && limpio !== '') {
      const n = Number(limpio);
      if (!Number.isInteger(n) || n < 0) { await avisarEmpleado(chatId, '❌ Escribe un número entero, o "-" si no llevas tickets.'); return true; }
      tickets = n;
    }
    await guardarFlujo(db, chatId, 'caja', 'cierre_datafonos', { ...flujo.datos, numTickets: tickets });
    await avisarEmpleado(chatId, 'Por último, los importes de los datáfonos separados por espacio (normalmente 2). Ejemplo: 20 10');
    return true;
  }

  if (flujo.paso === 'cierre_datafonos') {
    const partes = valor.trim().split(/\s+/).map(x => Number(String(x).replace(',', '.')));
    if (!partes.length || partes.some(n => !Number.isFinite(n) || n < 0)) {
      await avisarEmpleado(chatId, '❌ Escribe uno o más importes separados por espacio. Ejemplo: 20 10');
      return true;
    }
    await limpiarFlujo(db, chatId);
    const datafonos = partes.map((importe, i) => ({ nombre: `Datáfono ${i + 1}`, importe }));
    const r = await cajaGuardarCierre(db, req, {
      id: flujo.datos.turnoId, desglose: flujo.datos.desglose, fondoDefinido: flujo.datos.fondoDefinido,
      tpvEfectivo: flujo.datos.tpvEfectivo, tpvTarjeta: flujo.datos.tpvTarjeta, tpvVoids: flujo.datos.tpvVoids,
      numTickets: flujo.datos.numTickets, datafonos,
    });
    if (!r.ok) { await avisarEmpleado(chatId, `❌ ${r.error}`); return true; }
    await avisarEmpleado(chatId,
      `${EMOJI_SEMAFORO_CAJA[r.semaforo] || ''} Cierre guardado.\n`
      + `Diferencia efectivo: ${firmadoTexto(r.dif_efectivo)}. Diferencia tarjeta: ${firmadoTexto(r.dif_tarjeta)}.`
    );
    return true;
  }

  return false;
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

  // Si había un asistente guiado o una tarea de NUMERO o TEXTO esperando
  // respuesta, cualquier texto normal se interpreta como esa respuesta —
  // salvo que sea justo un comando o un botón, que se entiende como que la
  // persona ha cambiado de tema.
  if (!esBoton && !esComando) {
    const atendidoFlujo = await intentarContinuarFlujo(db, req, empleado, chatId, texto);
    if (atendidoFlujo) return;
    const atendido = await intentarCompletarPendiente(db, req, empleado, chatId, texto);
    if (atendido) return;
  } else {
    await limpiarTodosPendientes(db, chatId);
  }

  // Un botón del teclado manda su etiqueta tal cual, como si se hubiera
  // escrito el comando a mano — pero sin nada detrás, así que no se le puede
  // pasar como argumentos (sería la etiqueta del propio botón).
  const comando = BOTON_A_COMANDO[texto] || comandoDe(texto);
  const argumentos = esBoton ? '' : argumentosDe(texto);

  if (comando === '/salir') return desvincular(db, req, empleado, chatId);
  if (comando === '/ayuda' || comando === '/start') return enviarAyuda(chatId, empleado);

  const cfg = await getCentroCfg(db, empleado.centro || '');
  if (comando === '/horario') return responderHorario(db, empleado, chatId);
  if (comando === '/horas') return responderHoras(db, empleado, chatId, cfg);
  if (comando === '/tareas') return responderTareas(db, empleado, chatId, cfg);
  if (comando === '/corregir') {
    return argumentos.trim()
      ? crearSolicitudCorreccion(db, req, empleado, chatId, argumentos)
      : iniciarFlujoCorregir(db, chatId);
  }
  if (comando === '/incidencia' || comando === '/falta') {
    const tipoNota = comando === '/incidencia' ? 'incidencia' : 'falta';
    return argumentos.trim()
      ? crearNotaTurno(db, req, empleado, cfg, chatId, tipoNota, argumentos)
      : iniciarFlujoNota(db, chatId, tipoNota);
  }
  if (comando === '/fichar') return iniciarFichaje(db, empleado, chatId, cfg);
  if (comando === '/caja') return iniciarFlujoCaja(db, req, empleado, chatId);

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
  const partes = datos.split(':');
  const accion = partes[0];

  if (accion === 'tgflujo') {
    await responderCallbackEmpleado(callbackQuery.id);
    await avanzarFlujoCallback(db, empleado, chatId, partes[1], partes[2]);
    return;
  }
  if (accion === 'tgcaja') {
    await responderCallbackEmpleado(callbackQuery.id);
    await avanzarFlujoCajaTurno(db, req, empleado, chatId, partes[1]);
    return;
  }

  const idTexto = partes[1];

  if (accion === 'tgfichar') {
    await limpiarFlujo(db, chatId);
    await responderCallbackEmpleado(callbackQuery.id);
    await pedirUbicacionParaFichaje(db, chatId, idTexto);
    return;
  }

  const instanciaId = Number(idTexto);
  if (!Number.isFinite(instanciaId)) {
    await responderCallbackEmpleado(callbackQuery.id);
    return;
  }

  if (accion === 'tgcompletar') {
    await limpiarFlujo(db, chatId);
    const r = await completarTarea(db, req, empleado, instanciaId, {});
    await responderCallbackEmpleado(callbackQuery.id, r.error ? `❌ ${r.error}` : '✅ Hecho');
    return;
  }
  if (accion === 'tgnumero' || accion === 'tgtexto') {
    await limpiarFlujo(db, chatId);
    await guardarPendiente(db, chatId, instanciaId, accion === 'tgnumero' ? 'numero' : 'texto');
    await responderCallbackEmpleado(callbackQuery.id, accion === 'tgnumero' ? 'Mándame el número' : 'Mándame el texto');
    await avisarEmpleado(chatId, accion === 'tgnumero' ? '✏️ Escribe el número para esa tarea.' : '✏️ Escribe la anotación para esa tarea.');
    return;
  }
  await responderCallbackEmpleado(callbackQuery.id);
}

async function manejarUbicacion(db, req, message) {
  const chatId = message.chat?.id;
  if (chatId === undefined || chatId === null) return;

  const empleado = await identificarPorTelegramChatId(db, chatId);
  if (!empleado) {
    await avisarEmpleado(chatId, '👋 Para empezar, escríbeme tu PIN (el mismo que usas para fichar o para las tareas).');
    return;
  }

  await ficharPorUbicacion(db, req, empleado, chatId, message);
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
    else if (update.message?.location) await manejarUbicacion(db, req, update.message);
    else if (update.message?.text) await manejarMensaje(db, req, update.message);
    // Siempre 200: Telegram reintenta el mismo update si no responde rápido.
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(200).json({ ok: true });
  }
}
