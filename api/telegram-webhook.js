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
 * Soporta, todo con su botón fijo debajo del chat, para no tener que
 * escribir ni recordar ningún comando:
 *   - /hoy → resumen del día en curso por centro: recuento, quién está
 *     fichado dentro, fichajes de hoy y detalle tarea a tarea (quién la hizo,
 *     o quién de su rol está dentro si sigue sin hacerse).
 *   - /horarios → el cuadrante subido, turno a turno, con lo que aún está
 *     sin validar marcado aparte.
 *   - /solicitudes → las correcciones de fichaje pendientes, una por
 *     mensaje, con botones para aprobar o rechazar sin salir del chat.
 *   - /incidencias → lo que está roto o agotado y sigue sin resolverse.
 *   - /abiertos → quién sigue fichado como presente sin haber salido.
 *   - /dispositivos → móviles usados por más de una persona.
 *   - /caja → estado de hoy de la caja (apertura/cierre de cada turno, con
 *     el semáforo), por centro. Solo lectura: cada cierre y cada reapertura
 *     ya avisan solos (§ api/caja.js), y reabrir un cierre se hace desde el
 *     panel, no desde aquí — necesita un motivo escrito de verdad y el bot
 *     del dueño no tiene ninguna maquinaria para pedir texto libre.
 *   - el botón "Marcar como no aplica" del aviso de tarea vencida.
 *
 * Lo que NO está aquí a propósito: dar de alta o borrar empleados, cambiar
 * un PIN, configurar la red o la ubicación del centro. Son formularios con
 * varios campos y consecuencias que conviene ver bien antes de confirmar —
 * se quedan en el panel, no se fuerzan a caber en un botón de chat.
 */
import { getDbClient } from "./_db.js";
import {
  initSchema, getCentroCfg, fechaOperativaDe, epochDesdeLocal, auditar,
  quienEstaDentro, esDelRol, generarInstancias, marcarVencidas,
} from "./_tareas-lib.js";
import {
  avisarTelegram, escTelegram, hayTelegramConfigurado,
  responderCallbackTelegram, editarBotonesTelegram,
} from "./_telegram.js";
import { turnosAbiertos, dispositivosCompartidos } from "./mantenimiento.js";
import { resolverSolicitud } from "./solicitudes.js";
import { listarTurnos as cajaListarTurnos, hoyEnCentro } from "./caja.js";

const MOTIVO_TELEGRAM = 'Marcado desde Telegram por el dueño';

const EMOJI_ESTADO = {
  COMPLETADA: '✅', COMPLETADA_TARDIA: '✅', NO_APLICA: '🚫', VENCIDA: '⏰', PENDIENTE: '⏳',
};
const VERBO_FICHAJE = {
  entrada: 'entrada', salida: 'salida', inicio_descanso: 'descanso', fin_descanso: 'vuelta',
};

/** Línea de detalle de una tarea: quién la hizo, o quién debería estar haciéndola. */
function lineaTarea(t, dentro) {
  const emoji = EMOJI_ESTADO[t.estado] || '•';
  const nombre = escTelegram(t.nombre) + (t.criticidad === 'BLOQUEANTE' ? ' (bloqueante)' : '');

  if (t.estado === 'COMPLETADA' || t.estado === 'COMPLETADA_TARDIA') {
    const quien = t.completada_por ? escTelegram(t.completada_por) : 'sin nombre registrado';
    return `${emoji} ${nombre} — ${quien}${t.estado === 'COMPLETADA_TARDIA' ? ' (tarde)' : ''}`;
  }
  if (t.estado === 'NO_APLICA') {
    return `${emoji} ${nombre} — no aplica${t.motivo_no_aplica ? `: ${escTelegram(t.motivo_no_aplica)}` : ''}`;
  }

  // PENDIENTE o VENCIDA: quién de su rol está fichado dentro ahora mismo.
  const responsables = dentro.filter(p => esDelRol(t.rol_responsable, p.rol));
  const quien = !dentro.length
    ? 'nadie fichado dentro'
    : responsables.length
      ? `dentro: ${responsables.map(p => escTelegram(p.nombre)).join(', ')}`
      : `nadie de ${escTelegram((t.rol_responsable || '').toLowerCase())} dentro (sí: ${dentro.map(p => escTelegram(p.nombre)).join(', ')})`;
  return `${emoji} ${nombre} — ${quien}`;
}

/** Fichajes de hoy agrupados por empleado, en el orden en que ocurrieron. */
function lineaFichajes(fichajes) {
  const porEmpleado = new Map();
  for (const f of fichajes) {
    const k = f.empleado;
    if (!porEmpleado.has(k)) porEmpleado.set(k, []);
    const verbo = VERBO_FICHAJE[f.tipo] || f.tipo;
    porEmpleado.get(k).push(`${verbo} ${String(f.hora).slice(0, 5)}`);
  }
  return [...porEmpleado.entries()]
    .map(([nombre, eventos]) => `${escTelegram(nombre)}: ${eventos.join(', ')}`)
    .join('\n');
}

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

// Un botón del teclado (§ TECLADO_DUENO en _telegram.js) manda su etiqueta
// tal cual, como si se hubiera escrito el comando a mano.
const BOTON_A_COMANDO = {
  '📋 Resumen de hoy': '/hoy',
  '📅 Horarios': '/horarios',
  '✏️ Solicitudes': '/solicitudes',
  '🔧 Incidencias': '/incidencias',
  '🚪 Turnos abiertos': '/abiertos',
  '📱 Móviles compartidos': '/dispositivos',
  '💰 Caja': '/caja',
};

/**
 * Trocea líneas en mensajes de como mucho `maxLen` caracteres (Telegram
 * corta a los 4096), sin partir ninguna línea por la mitad.
 */
function trocear(lineas, maxLen = 3500) {
  const bloques = [];
  let actual = '';
  for (const linea of lineas) {
    const candidato = actual ? `${actual}\n${linea}` : linea;
    if (candidato.length > maxLen && actual) {
      bloques.push(actual);
      actual = linea;
    } else {
      actual = candidato;
    }
  }
  if (actual) bloques.push(actual);
  return bloques;
}

/** Un texto por centro: Telegram corta los mensajes a 4096 caracteres, y
 * juntar todos los centros en uno solo hacía que a partir de dos o tres el
 * mensaje entero se perdiera. */
async function resumenHoy() {
  const db = getDbClient();
  await initSchema(db);

  const centros = await db.execute("SELECT centro FROM centros_cfg");
  const bloques = [];

  for (const { centro } of centros.rows) {
    const cfg = await getCentroCfg(db, centro);
    const hoy = fechaOperativaDe(Date.now(), cfg);
    const inicioHoyTs = epochDesdeLocal(hoy, cfg.inicio_jornada, cfg.zona_horaria);

    // Las tareas del día se creaban solo al abrir la pantalla de tareas, así
    // que si nadie había entrado en la app todavía, /hoy contestaba que no
    // había ninguna dada de alta y una tarea pasada de plazo no se detectaba
    // ni se avisaba. Preguntar por el día lo pone al día.
    await generarInstancias(db, centro, hoy, cfg);
    await marcarVencidas(db, centro, hoy);

    const r = await db.execute({
      sql: `SELECT i.estado, i.completada_por, i.motivo_no_aplica,
                   p.nombre, p.criticidad, p.rol_responsable
            FROM tarea_instancias i
            JOIN tarea_plantillas p ON p.id = i.plantilla_version_id
            WHERE LOWER(TRIM(COALESCE(i.centro,''))) = LOWER(TRIM(?))
              AND i.fecha_operativa = ?
            ORDER BY i.ventana_inicio_ts ASC`,
      args: [centro, hoy],
    });
    const dentro = await quienEstaDentro(db, centro);
    const fichajes = await db.execute({
      sql: `SELECT empleado, tipo, hora FROM fichajes
            WHERE LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?))
              AND timestamp >= ?
            ORDER BY timestamp ASC`,
      args: [centro, inicioHoyTs],
    });

    // Centro sin ninguna tarea generada todavía para hoy y sin fichajes: nada que resumir.
    if (!r.rows.length && !fichajes.rows.length) continue;

    const cabecera = [`📋 <b>Hoy</b> (${hoy}) — ${escTelegram(centro)}`];
    if (r.rows.length) {
      const total = r.rows.length;
      const completadas = r.rows.filter(t => t.estado === 'COMPLETADA' || t.estado === 'COMPLETADA_TARDIA').length;
      const pendientes = r.rows.filter(t => t.estado === 'PENDIENTE').length;
      const vencidas = r.rows.filter(t => t.estado === 'VENCIDA').length;
      cabecera.push(`${completadas}/${total} hechas, ${pendientes} pendientes${vencidas ? `, ${vencidas} vencidas` : ''}`);
    }
    const lineas = [cabecera.join('\n')];

    lineas.push(dentro.length
      ? `🚪 Dentro ahora: ${dentro.map(p => escTelegram(p.nombre)).join(', ')}`
      : '🚪 Nadie fichado dentro ahora mismo.');

    if (fichajes.rows.length) {
      lineas.push(`🕐 Fichajes de hoy:\n${lineaFichajes(fichajes.rows)}`);
    }

    if (r.rows.length) {
      lineas.push(`Tareas:\n${r.rows.map(t => lineaTarea(t, dentro)).join('\n')}`);
    }

    bloques.push(lineas.join('\n\n'));
  }

  return bloques;
}

// Tope defensivo por centro: en la práctica nunca hay tantos turnos subidos
// de golpe, pero sin límite una tabla que crece acaba colgando el mensaje
// (y pasándose de los 4096 caracteres que admite Telegram).
const TOPE_HORARIOS_POR_CENTRO = 150;

/**
 * El cuadrante subido, turno a turno, agrupado por día — lo que hoy solo se
 * ve abriendo "Horario de Turno" en el panel. Marca aparte lo que sigue sin
 * validar, para que se note de un vistazo si hace falta pasar por el panel a
 * validar la semana.
 */
async function resumenHorarios() {
  const db = getDbClient();
  await initSchema(db);

  const centros = await db.execute("SELECT centro FROM centros_cfg");
  const bloques = [];

  for (const { centro } of centros.rows) {
    const cfg = await getCentroCfg(db, centro);
    const hoy = fechaOperativaDe(Date.now(), cfg);

    const r = await db.execute({
      sql: `SELECT empleado, fecha, hora_entrada, hora_salida, estado, rol_primera
            FROM horarios
            WHERE LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?)) AND fecha >= ?
            ORDER BY fecha ASC, hora_entrada ASC
            LIMIT ?`,
      args: [centro, hoy, TOPE_HORARIOS_POR_CENTRO + 1],
    });
    if (!r.rows.length) continue;

    const filas = r.rows.slice(0, TOPE_HORARIOS_POR_CENTRO);
    const hayMas = r.rows.length > TOPE_HORARIOS_POR_CENTRO;
    const pendientes = filas.filter(f => f.estado === 'pendiente').length;

    const lineas = [`📅 <b>Horarios</b> — ${escTelegram(centro)}`];
    if (pendientes) lineas.push(`⏳ ${pendientes} turno${pendientes !== 1 ? 's' : ''} todavía sin validar.`);

    let diaActual = '';
    for (const f of filas) {
      if (f.fecha !== diaActual) {
        diaActual = f.fecha;
        lineas.push(`\n<b>${f.fecha}</b>`);
      }
      const marca = f.estado === 'pendiente' ? ' ⏳' : f.estado === 'rechazado' ? ' ❌' : '';
      const rol = f.rol_primera ? ` (${escTelegram(f.rol_primera)})` : '';
      lineas.push(
        `${String(f.hora_entrada).slice(0, 5)}–${String(f.hora_salida).slice(0, 5)} `
        + `${escTelegram(f.empleado)}${rol}${marca}`
      );
    }
    if (hayMas) lineas.push('\n… y más turnos a partir de ahí. Ábrelo en el panel para verlos todos.');

    bloques.push(...trocear(lineas));
  }

  return bloques;
}

const TIPOS_FICHAJE_LARGO = {
  entrada: 'entrada', salida: 'salida', inicio_descanso: 'inicio de descanso', fin_descanso: 'fin de descanso',
};

/**
 * Solicitudes de corrección pendientes, una por mensaje —cada una necesita
 * sus propios botones de aprobar/rechazar, atados a su id— con el mismo
 * camino de aprobación que ya usa el panel (§ resolverSolicitud en
 * solicitudes.js), para no mantener esa lógica en dos sitios.
 */
async function responderSolicitudesPendientes() {
  const db = getDbClient();
  await initSchema(db);
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

  const r = await db.execute("SELECT * FROM solicitudes WHERE estado = 'pendiente' ORDER BY creado_en ASC LIMIT 30");
  if (!r.rows.length) {
    await avisarTelegram('✏️ No hay solicitudes de corrección pendientes.');
    return;
  }

  for (const s of r.rows) {
    const campo = TIPOS_FICHAJE_LARGO[s.tipo_fichaje] || s.tipo_fichaje;
    const verbo = s.tipo_solicitud === 'crear' ? `crear un fichaje de ${campo}`
      : s.tipo_solicitud === 'eliminar' ? `eliminar su ${campo}`
      : `corregir su ${campo}`;
    const horaTxt = s.hora_original
      ? `${String(s.hora_original).slice(0, 5)} → ${String(s.hora_propuesta).slice(0, 5)}`
      : String(s.hora_propuesta || '').slice(0, 5);

    const texto = `✏️ <b>${escTelegram(s.empleado)}</b> pide ${escTelegram(verbo)} del ${s.fecha}`
      + (horaTxt ? ` (${escTelegram(horaTxt)})` : '')
      + ` en ${escTelegram(s.centro || '')}.\nMotivo: ${escTelegram(s.motivo)}`;

    await avisarTelegram(texto, {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Aprobar', callback_data: `sol_aprobar:${s.id}` },
          { text: '❌ Rechazar', callback_data: `sol_rechazar:${s.id}` },
        ]],
      },
    });
  }
}

/** Copia exacta del esquema de turno-notas.js: cualquiera de las dos rutas puede llegar primero. */
async function initTurnoNotasLocal(db) {
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

/** Incidencias (roto/averiado) y faltas (agotado) sin resolver, por centro. */
async function resumenIncidencias() {
  const db = getDbClient();
  await initSchema(db);
  await initTurnoNotasLocal(db);

  const centros = await db.execute("SELECT centro FROM centros_cfg");
  const bloques = [];
  const EMOJI_TIPO = { incidencia: '🔧', falta: '📦' };

  for (const { centro } of centros.rows) {
    const r = await db.execute({
      sql: `SELECT tipo, texto, autor, prioridad, fecha_operativa
            FROM turno_notas
            WHERE LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?))
              AND tipo IN ('incidencia','falta') AND estado IN ('abierta','en_curso')
            ORDER BY CASE prioridad WHEN 'alta' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, creado_en DESC
            LIMIT 60`,
      args: [centro],
    });
    if (!r.rows.length) continue;

    const lineas = [`🔧 <b>Incidencias y faltas abiertas</b> — ${escTelegram(centro)}`];
    for (const n of r.rows) {
      const emoji = EMOJI_TIPO[n.tipo] || '•';
      const prioridad = n.prioridad === 'alta' ? ' 🔴' : '';
      lineas.push(`${emoji} ${escTelegram(n.texto)}${prioridad} — ${escTelegram(n.autor || 'sin autor')} (${n.fecha_operativa})`);
    }
    bloques.push(...trocear(lineas));
  }

  if (!bloques.length) return ['🔧 Ninguna incidencia ni falta abierta ahora mismo.'];
  return bloques;
}

/** Quién sigue fichado como presente sin haber salido, en todos los centros. */
async function resumenTurnosAbiertos() {
  const db = getDbClient();
  await initSchema(db);
  const abiertos = await turnosAbiertos(db, '');
  if (!abiertos.length) return ['🚪 Ningún turno sin cerrar. Todo en orden.'];

  const lineas = ['🚪 <b>Turnos sin cerrar</b>'];
  for (const t of abiertos) {
    lineas.push(
      `${escTelegram(t.empleado)} (${escTelegram(t.centro)}): entró el ${t.fecha} a las ${String(t.hora).slice(0, 5)} `
      + `— lleva ${t.horas_abierto} h marcado como presente`
    );
  }
  lineas.push('\nCiérralos desde "Arreglar fichajes" en el panel, con la hora real de salida.');
  return trocear(lineas);
}

/** Móviles con fichajes de más de una persona, en todos los centros. */
async function resumenDispositivosCompartidos() {
  const db = getDbClient();
  await initSchema(db);
  const datos = await dispositivosCompartidos(db, '');
  if (!datos.length) return ['📱 Ningún móvil compartido entre dos personas ahora mismo.'];

  const lineas = ['📱 <b>Móviles compartidos</b>'];
  for (const d of datos) {
    lineas.push(`\n<b>${escTelegram(d.propietario)}</b> (${escTelegram(d.centro)}) — ${d.total_propietario} fichajes suyos con este aparato`);
    for (const p of d.prestados.slice(0, 5)) {
      const verbo = VERBO_FICHAJE[p.tipo] || p.tipo;
      lineas.push(`  ${escTelegram(p.empleado)} fichó ${verbo} el ${p.fecha} a las ${p.hora}`);
    }
    if (d.prestados.length > 5) lineas.push(`  … y ${d.prestados.length - 5} vez${d.prestados.length - 5 !== 1 ? 'es' : ''} más. Verlo entero en "Arreglar fichajes".`);
  }
  return trocear(lineas);
}

const ETIQUETA_TURNO_CAJA = { manana: 'Turno 1 (mañana)', tarde: 'Turno 2 (tarde)' };
const EMOJI_ESTADO_CAJA = { pendiente: '⏳', apertura_ok: '🔓', cerrado: '✅', reabierto: '♻️' };
const EMOJI_SEMAFORO_CAJA = { verde: '🟢', naranja: '🟠', rojo: '🔴' };

/** Estado de hoy de la caja (apertura/cierre de cada turno), por centro. Solo lectura: reabrir se hace desde el panel. */
async function resumenCaja() {
  const db = getDbClient();
  await initSchema(db);
  const centros = await db.execute("SELECT centro FROM centros_cfg");
  const bloques = [];

  for (const { centro } of centros.rows) {
    const cfg = await getCentroCfg(db, centro);
    const hoy = hoyEnCentro(cfg);
    const turnos = await cajaListarTurnos(db, { centro, fecha_desde: hoy, fecha_hasta: hoy });
    if (!turnos.length) continue;

    const lineas = [`💰 <b>Caja de hoy</b> (${hoy}) — ${escTelegram(centro)}`];
    for (const t of turnos.slice().reverse()) {
      const emoji = EMOJI_ESTADO_CAJA[t.estado] || '•';
      let linea = `${emoji} ${escTelegram(ETIQUETA_TURNO_CAJA[t.turno] || t.turno)} — ${escTelegram(t.empleado)}: ${t.estado}`;
      if (t.cierre_semaforo) {
        linea += ` ${EMOJI_SEMAFORO_CAJA[t.cierre_semaforo] || ''} (dif. efvo ${firmadoTexto(t.cierre_dif_efectivo)}, tarj. ${firmadoTexto(t.cierre_dif_tarjeta)})`;
      }
      lineas.push(linea);
    }
    bloques.push(...trocear(lineas));
  }

  if (!bloques.length) return ['💰 Ningún turno de caja movido hoy todavía.'];
  return bloques;
}

function firmadoTexto(n) {
  const v = Number(n) || 0;
  const euros = (Math.round(Math.abs(v) * 100) / 100).toFixed(2).replace('.', ',');
  return `${v > 0 ? '+' : v < 0 ? '-' : ''}${euros} €`;
}

async function manejarMensaje(message) {
  if (!esDelDueno(message.chat?.id)) return;
  const texto = String(message.text || '').trim();
  const comando = BOTON_A_COMANDO[texto] || comandoDe(texto);

  if (comando === '/solicitudes') { await responderSolicitudesPendientes(); return; }

  const PRODUCTORES = {
    '/hoy': resumenHoy,
    '/horarios': resumenHorarios,
    '/incidencias': resumenIncidencias,
    '/abiertos': resumenTurnosAbiertos,
    '/dispositivos': resumenDispositivosCompartidos,
    '/caja': resumenCaja,
  };
  const productor = PRODUCTORES[comando];
  if (!productor) return;

  const bloques = await productor();
  // Aunque no haya nada que contar hay que contestar algo: si el dueño toca
  // un botón y no le llega nada, no sabe si es que no hay nada o si el bot
  // está roto.
  if (!bloques.length) {
    await avisarTelegram('Nada que enseñar ahora mismo.');
    return;
  }
  for (const bloque of bloques) await avisarTelegram(bloque);
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

/**
 * Aprueba o rechaza una solicitud de corrección desde sus botones, por el
 * mismo camino que el panel (§ resolverSolicitud en solicitudes.js): así
 * aprobarla desde Telegram inserta o modifica el fichaje real exactamente
 * igual que aprobarla desde ahí, sin duplicar esa lógica aquí.
 */
async function resolverSolicitudCallback(callbackQuery, estado) {
  const [, idTexto] = String(callbackQuery.data || '').split(':');
  const id = Number(idTexto);
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;

  if (!Number.isFinite(id)) {
    await responderCallbackTelegram(callbackQuery.id, 'Solicitud no válida');
    return;
  }

  const db = getDbClient();
  await initSchema(db);

  const r = await resolverSolicitud(db, id, estado, 'Resuelta desde Telegram');
  if (chatId && messageId) await editarBotonesTelegram(chatId, messageId, { inline_keyboard: [] });

  if (!r.ok) {
    await responderCallbackTelegram(callbackQuery.id, r.error || 'No se pudo resolver');
    return;
  }

  await responderCallbackTelegram(callbackQuery.id, estado === 'aprobada' ? 'Aprobada' : 'Rechazada');
  const emoji = estado === 'aprobada' ? '✅' : '❌';
  await avisarTelegram(
    `${emoji} Solicitud de <b>${escTelegram(r.sol.empleado)}</b> (${r.sol.fecha}) `
    + `${estado === 'aprobada' ? 'aprobada' : 'rechazada'} desde Telegram.`
  );
}

async function manejarCallback(req, callbackQuery) {
  if (!esDelDueno(callbackQuery.message?.chat?.id)) return;

  const datos = String(callbackQuery.data || '');
  if (datos.startsWith('no_aplica:')) {
    await marcarNoAplica(req, callbackQuery);
  } else if (datos.startsWith('sol_aprobar:')) {
    await resolverSolicitudCallback(callbackQuery, 'aprobada');
  } else if (datos.startsWith('sol_rechazar:')) {
    await resolverSolicitudCallback(callbackQuery, 'rechazada');
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
