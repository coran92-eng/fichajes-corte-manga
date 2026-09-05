import { getDbClient } from "./_db.js";
import { initSchema, getCentroCfg, fechaOperativaDe, epochDesdeLocal, minutosDeHora } from "./_tareas-lib.js";
import { avisarTelegram, escTelegram, hayTelegramConfigurado, conEnlacePanel } from "./_telegram.js";

const DIA_MS = 24 * 60 * 60 * 1000;
const norm = s => String(s || '').trim().toLowerCase();

// Mismo margen que fichajes.js usa para decidir si una entrada es puntual.
const MARGEN_ENTRADA_MIN = 5;

/** Suma (o resta) días a una fecha YYYY-MM-DD, en aritmética de calendario pura. */
function sumarDiasLocal(fecha, dias) {
  const [Y, M, D] = String(fecha).split('-').map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D));
  d.setUTCDate(d.getUTCDate() + dias);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * ¿Es lunes el día de hoy (fecha real, no la operativa) en la zona del centro?
 * `ts` es inyectable para poder probar la lógica sin mockear el reloj global.
 */
function esLunes(tz, ts = Date.now()) {
  const dow = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(ts));
  return dow === 'Mon';
}

/**
 * Minutos trabajados a partir de las marcas de UNA persona, en orden. Igual de
 * simple que jornadaDe() en fichajes.js pero sin lo que aquí no hace falta
 * (comparar con el horario día a día): esto es un total informativo de la
 * semana, no tiene que cuadrar al segundo.
 */
function minutosTrabajados(eventos) {
  let entradaTs = null, descansoIni = null, restar = 0, minutos = 0;
  for (const f of eventos) {
    const ts = Number(f.timestamp);
    if (f.tipo === 'entrada') {
      entradaTs = ts; descansoIni = null; restar = 0;
    } else if (f.tipo === 'inicio_descanso') {
      if (entradaTs !== null) descansoIni = ts;
    } else if (f.tipo === 'fin_descanso') {
      if (descansoIni !== null) { restar += ts - descansoIni; descansoIni = null; }
    } else if (f.tipo === 'salida') {
      if (entradaTs !== null) {
        if (descansoIni !== null) { restar += ts - descansoIni; descansoIni = null; }
        minutos += Math.max(0, (ts - entradaTs - restar) / 60000);
      }
      entradaTs = null; restar = 0;
    }
  }
  return minutos;
}

const VERBO_TIPO = {
  entrada: 'entró',
  inicio_descanso: 'inició descanso',
  fin_descanso: 'volvió de descanso',
};

/**
 * Turnos que se quedaron abiertos: el último fichaje de cada persona (de
 * cualquier día hasta ayer inclusive) no fue una salida.
 */
async function turnosSinCerrar(db, centro, finTs) {
  const r = await db.execute({
    sql: `SELECT f.empleado, f.tipo, f.fecha, f.hora
          FROM fichajes f
          WHERE LOWER(TRIM(COALESCE(f.centro,''))) = LOWER(TRIM(?))
            AND f.timestamp < ?
            AND f.timestamp = (
              SELECT MAX(f2.timestamp) FROM fichajes f2
              WHERE f2.empleado = f.empleado
                AND LOWER(TRIM(COALESCE(f2.centro,''))) = LOWER(TRIM(?))
                AND f2.timestamp < ?
            )`,
    args: [centro, finTs, centro, finTs],
  });
  return r.rows.filter(f => f.tipo !== 'salida');
}

/** Quién tenía horario asignado ayer y no fichó ni una entrada. */
async function sinFicharTeniendoHorario(db, centro, ayer, inicioTs, finTs) {
  const horarios = await db.execute({
    sql: `SELECT empleado, hora_entrada, hora_salida FROM horarios
          WHERE LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?))
            AND fecha = ?
            AND LOWER(TRIM(COALESCE(estado,''))) <> 'rechazado'`,
    args: [centro, ayer],
  });
  if (!horarios.rows.length) return [];

  const entradas = await db.execute({
    sql: `SELECT DISTINCT empleado FROM fichajes
          WHERE LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?))
            AND tipo = 'entrada'
            AND timestamp >= ? AND timestamp < ?`,
    args: [centro, inicioTs, finTs],
  });
  const fichados = new Set(entradas.rows.map(f => norm(f.empleado)));

  return horarios.rows.filter(h => !fichados.has(norm(h.empleado)));
}

/** Resumen de ayer para un centro: tareas + turnos abiertos + ausencias con horario. */
async function enviarResumenDiario(db, centro, cfg, ayer, inicioAyerTs, finAyerTs) {
  const r = await db.execute({
    sql: `SELECT i.estado, p.nombre, p.criticidad
          FROM tarea_instancias i
          JOIN tarea_plantillas p ON p.id = i.plantilla_version_id
          WHERE LOWER(TRIM(COALESCE(i.centro,''))) = LOWER(TRIM(?))
            AND i.fecha_operativa = ?`,
    args: [centro, ayer],
  });

  const abiertos = await turnosSinCerrar(db, centro, finAyerTs);
  const sinFichar = await sinFicharTeniendoHorario(db, centro, ayer, inicioAyerTs, finAyerTs);

  // Nada que contar ese día: ni tareas dadas de alta, ni incidencias de
  // fichaje. No vale la pena avisar de un centro sin nada que resumir.
  if (!r.rows.length && !abiertos.length && !sinFichar.length) return;

  const lineas = [`📋 <b>Resumen de ayer</b> (${ayer}) — ${escTelegram(centro)}`];

  if (r.rows.length) {
    const total = r.rows.length;
    const completadas = r.rows.filter(t => t.estado === 'COMPLETADA' || t.estado === 'COMPLETADA_TARDIA').length;
    const tardias = r.rows.filter(t => t.estado === 'COMPLETADA_TARDIA').length;
    const sinHacer = r.rows.filter(t => t.estado === 'PENDIENTE' || t.estado === 'VENCIDA');
    const bloqueantesSinHacer = sinHacer.filter(t => t.criticidad === 'BLOQUEANTE');
    const normalesSinHacer = sinHacer.filter(t => t.criticidad !== 'BLOQUEANTE');

    lineas.push(`${completadas}/${total} tareas hechas${tardias ? `, ${tardias} tarde` : ''}`);
    if (bloqueantesSinHacer.length) {
      lineas.push(`🔴 Sin hacer, bloqueante: ${bloqueantesSinHacer.map(t => escTelegram(t.nombre)).join(', ')}`);
    }
    if (normalesSinHacer.length) {
      lineas.push(`⚠️ Sin hacer: ${normalesSinHacer.map(t => escTelegram(t.nombre)).join(', ')}`);
    }
    if (!sinHacer.length && !tardias) lineas.push('✅ Todo en orden.');
  }

  for (const f of abiertos) {
    const verbo = VERBO_TIPO[f.tipo] || 'última marca';
    lineas.push(`⚠️ Turno sin cerrar: ${escTelegram(f.empleado)} (${verbo} el ${f.fecha} a las ${String(f.hora).slice(0, 5)})`);
  }

  for (const h of sinFichar) {
    lineas.push(`🚫 No fichó entrada aunque tenía horario: ${escTelegram(h.empleado)} (previsto ${String(h.hora_entrada).slice(0, 5)}–${String(h.hora_salida).slice(0, 5)})`);
  }

  await avisarTelegram(conEnlacePanel(lineas.join('\n'), centro));
}

/** Resumen de los últimos 7 días (horas + tareas + puntualidad), solo los lunes. */
async function enviarResumenSemanal(db, centro, cfg, ayer, finSemanaTs) {
  const inicioSemana = sumarDiasLocal(ayer, -6); // 7 días: inicioSemana..ayer inclusive
  const inicioSemanaTs = epochDesdeLocal(inicioSemana, cfg.inicio_jornada, cfg.zona_horaria);

  const fichajes = await db.execute({
    sql: `SELECT empleado, tipo, hora, timestamp FROM fichajes
          WHERE LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?))
            AND timestamp >= ? AND timestamp < ?
          ORDER BY timestamp ASC`,
    args: [centro, inicioSemanaTs, finSemanaTs],
  });

  const porEmpleado = new Map();
  for (const f of fichajes.rows) {
    const k = norm(f.empleado);
    if (!porEmpleado.has(k)) porEmpleado.set(k, []);
    porEmpleado.get(k).push(f);
  }
  let minutosTotales = 0;
  for (const eventos of porEmpleado.values()) minutosTotales += minutosTrabajados(eventos);

  const tareas = await db.execute({
    sql: `SELECT i.estado FROM tarea_instancias i
          WHERE LOWER(TRIM(COALESCE(i.centro,''))) = LOWER(TRIM(?))
            AND i.fecha_operativa >= ? AND i.fecha_operativa <= ?`,
    args: [centro, inicioSemana, ayer],
  });
  const totalTareas = tareas.rows.length;
  const hechasTareas = tareas.rows.filter(t => t.estado === 'COMPLETADA' || t.estado === 'COMPLETADA_TARDIA').length;
  const tardiasTareas = tareas.rows.filter(t => t.estado === 'COMPLETADA_TARDIA').length;

  // Nada que resumir esta semana: ni fichajes ni tareas dadas de alta.
  if (!fichajes.rows.length && !totalTareas) return;

  // Puntualidad de las entradas: se compara cada fichaje de entrada con el
  // horario de ese día, si lo había. Es aproximado a propósito —no hace falta
  // más para un resumen informativo— así que se omite en silencio cuando no
  // hay con qué comparar en absoluto.
  const horarios = await db.execute({
    sql: `SELECT empleado, fecha, hora_entrada FROM horarios
          WHERE LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?))
            AND fecha >= ? AND fecha <= ?
            AND LOWER(TRIM(COALESCE(estado,''))) <> 'rechazado'`,
    args: [centro, inicioSemana, ayer],
  });
  const previstoDe = new Map();
  for (const h of horarios.rows) previstoDe.set(`${h.fecha}|${norm(h.empleado)}`, h.hora_entrada);

  let puntuales = 0, tardePuntualidad = 0;
  for (const f of fichajes.rows) {
    if (f.tipo !== 'entrada') continue;
    const fechaOp = fechaOperativaDe(Number(f.timestamp), cfg);
    const prevista = previstoDe.get(`${fechaOp}|${norm(f.empleado)}`);
    if (!prevista) continue;
    const diff = minutosDeHora(String(f.hora).slice(0, 5)) - minutosDeHora(prevista);
    if (diff <= MARGEN_ENTRADA_MIN) puntuales++; else tardePuntualidad++;
  }

  const horas = (minutosTotales / 60).toFixed(1).replace('.', ',');
  const lineas = [
    `📊 <b>Resumen de la semana</b> (${inicioSemana} a ${ayer}) — ${escTelegram(centro)}`,
    `🕐 ${horas} horas trabajadas`,
  ];
  if (totalTareas) {
    lineas.push(`✅ ${hechasTareas}/${totalTareas} tareas hechas${tardiasTareas ? ` (${tardiasTareas} tarde)` : ''}`);
  }
  if (puntuales + tardePuntualidad > 0) {
    lineas.push(`🎯 ${puntuales} entradas puntuales, ${tardePuntualidad} tarde`);
  }

  await avisarTelegram(conEnlacePanel(lineas.join('\n'), centro));
}

/**
 * Resumen de ayer, una vez al día. Lo dispara el cron de Vercel (vercel.json);
 * nadie más debería poder llamarlo, así que exige el secreto que Vercel
 * manda solo. Sin él configurado, se acepta igualmente para no romper el cron
 * en el primer despliegue —hay un aviso en los logs, no un 401 a ciegas.
 */
export default async function handler(req, res) {
  const secreto = process.env.CRON_SECRET;
  if (secreto && req.headers.authorization !== `Bearer ${secreto}`) {
    return res.status(401).json({ error: "No autorizado" });
  }

  if (!hayTelegramConfigurado()) {
    return res.status(200).json({ ok: true, aviso: "Telegram no configurado: nada que mandar" });
  }

  try {
    const db = getDbClient();
    await initSchema(db);

    // Un resumen por centro: cada uno tiene su propia jornada operativa.
    const centros = await db.execute("SELECT centro FROM centros_cfg");

    for (const { centro } of centros.rows) {
      const cfg = await getCentroCfg(db, centro);
      const ayer = fechaOperativaDe(Date.now() - DIA_MS, cfg);
      const hoyOperativo = fechaOperativaDe(Date.now(), cfg);
      const inicioAyerTs = epochDesdeLocal(ayer, cfg.inicio_jornada, cfg.zona_horaria);
      const finAyerTs = epochDesdeLocal(hoyOperativo, cfg.inicio_jornada, cfg.zona_horaria);

      await enviarResumenDiario(db, centro, cfg, ayer, inicioAyerTs, finAyerTs);

      // El resumen semanal solo se manda los lunes; el cron sigue corriendo
      // todos los días a las 06:00 UTC (§vercel.json), esto es una decisión
      // dentro del propio handler, no un cron aparte.
      if (esLunes(cfg.zona_horaria)) {
        await enviarResumenSemanal(db, centro, cfg, ayer, finAyerTs);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}
