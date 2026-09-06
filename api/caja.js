/**
 * Cierre de caja: apertura de turno (con fondo heredado del turno anterior),
 * cierre (desglose de efectivo, TPV, datáfonos, semáforo de descuadre) y
 * reapertura por gerencia. Migrado de la app aparte "cierrecaja"
 * (React + Supabase) — aquí es una tabla más de esta base de datos, sin
 * cuenta de Supabase, y con dos caminos más para entrar: el panel y los
 * bots de Telegram (§ telegram-empleados.js, telegram-webhook.js), que
 * llaman a las funciones exportadas de este archivo directamente, sin pasar
 * por HTTP.
 *
 * Reglas de negocio replicadas tal cual de cierrecaja: los 15 tramos de
 * billete/moneda, la cadena de fondo heredado (mañana hereda de la tarde
 * del día anterior; tarde hereda de la mañana del mismo día), las fórmulas
 * de diferencia y el semáforo (verde/naranja/rojo), y que reabrir nunca
 * vuelve a dejar editable la apertura, solo el cierre.
 *
 * Lo que se corrige a propósito respecto a cierrecaja: el nombre del
 * empleado sale de la identidad verificada por PIN, no de un campo de texto
 * libre; se añade `centro` (cierrecaja no tenía más de un local); guardar
 * un cierre es atómico con `db.batch()` (cierrecaja hacía tres escrituras
 * sueltas sin transacción).
 */
import { getDbClient } from "./_db.js";
import {
  initSchema, getCentroCfg, centroDeEmpleado, verificarPin, turnoAbierto,
  esEncargadoOSuperior, nivelDesdeReq, auditar, sumarDias, partesEnZona,
  totalDesglose, semaforoCaja,
} from "./_tareas-lib.js";
import { avisarTelegram, escTelegram, conEnlacePanel } from "./_telegram.js";

const TURNOS = ['manana', 'tarde'];
const pad2 = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round(n * 100) / 100;

/** Fecha de calendario real en la zona horaria del centro — sin jornada
 * operativa: aquí el turno es una elección explícita (mañana/tarde), no
 * algo que se infiera de la hora, igual que en cierrecaja. */
export function hoyEnCentro(cfg) {
  const p = partesEnZona(Date.now(), cfg.zona_horaria);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function turnoYFechaAnterior(turno, fecha) {
  return turno === 'manana'
    ? { turno: 'tarde', fecha: sumarDias(fecha, -1) }
    : { turno: 'manana', fecha };
}

/** JSON guardado como TEXT -> objeto; booleano guardado como 0/1 -> bool. */
function formatearTurno(row) {
  if (!row) return null;
  return {
    ...row,
    apertura_desglose: row.apertura_desglose ? JSON.parse(row.apertura_desglose) : null,
    cierre_desglose: row.cierre_desglose ? JSON.parse(row.cierre_desglose) : null,
    apertura_fondo_editable: !!row.apertura_fondo_editable,
  };
}

/**
 * De quién hereda el fondo un turno: el `cierre_fondo_definido` del turno
 * anterior en la cadena, y si ese turno anterior ya está cerrado.
 * `fondo: null` + `encontrado: false` = no hay turno anterior (el primero
 * de la historia para ese centro): el fondo pasa a ser editable a mano.
 */
export async function obtenerFondoAnterior(db, centro, turno, fecha) {
  const ant = turnoYFechaAnterior(turno, fecha);
  const r = await db.execute({
    sql: `SELECT estado, cierre_fondo_definido FROM caja_turnos
          WHERE LOWER(TRIM(centro)) = LOWER(TRIM(?)) AND turno = ? AND fecha = ? LIMIT 1`,
    args: [centro, ant.turno, ant.fecha],
  });
  if (!r.rows.length) return { fondo: null, encontrado: false, cerrado: true };
  const row = r.rows[0];
  const fondo = row.cierre_fondo_definido === null || row.cierre_fondo_definido === undefined
    ? null : Number(row.cierre_fondo_definido);
  return { fondo, encontrado: true, cerrado: row.estado === 'cerrado' };
}

/** El turno "activo" del centro: el último por fecha/turno (mismo criterio
 * que cierrecaja — 'tarde' > 'manana' alfabéticamente, así que ORDER BY
 * turno DESC ya deja la tarde antes que la mañana del mismo día). */
export async function turnoActivo(db, centro) {
  const r = await db.execute({
    sql: `SELECT * FROM caja_turnos WHERE LOWER(TRIM(centro)) = LOWER(TRIM(?))
          ORDER BY fecha DESC, turno DESC, id DESC LIMIT 1`,
    args: [centro],
  });
  return formatearTurno(r.rows[0]);
}

export async function progresoHoy(db, centro, hoy) {
  const r = await db.execute({
    sql: `SELECT turno, estado FROM caja_turnos WHERE LOWER(TRIM(centro)) = LOWER(TRIM(?)) AND fecha = ?`,
    args: [centro, hoy],
  });
  return r.rows;
}

/**
 * Empieza una apertura ('pendiente'). Si el turno pedido ya tiene una fila
 * hoy en este centro, la fecha se adelanta a mañana — mismo mecanismo de
 * "avance de día" que ya usaba cierrecaja para no chocar con la clave única.
 */
export async function crearApertura(db, req, { centro, turno, empleado }) {
  if (!TURNOS.includes(turno)) return { ok: false, status: 422, error: "El turno debe ser 'manana' o 'tarde'" };

  const cfg = await getCentroCfg(db, centro);
  const hoy = hoyEnCentro(cfg);
  const yaHoy = await db.execute({
    sql: `SELECT 1 FROM caja_turnos WHERE LOWER(TRIM(centro)) = LOWER(TRIM(?)) AND turno = ? AND fecha = ? LIMIT 1`,
    args: [centro, turno, hoy],
  });
  const fecha = yaHoy.rows.length ? sumarDias(hoy, 1) : hoy;

  const fondoInfo = await obtenerFondoAnterior(db, centro, turno, fecha);
  if (fondoInfo.encontrado && !fondoInfo.cerrado) {
    return { ok: false, status: 409, error: "El turno anterior todavía no está cerrado. Pide a gerencia que lo cierre primero." };
  }
  const editable = !fondoInfo.encontrado || fondoInfo.fondo === null;

  try {
    const ahora = Date.now();
    const r = await db.execute({
      sql: `INSERT INTO caja_turnos
            (centro, turno, fecha, empleado, apertura_fondo_heredado, apertura_fondo_editable, estado, creado_en, actualizado_en)
            VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?, ?)`,
      args: [centro, turno, fecha, empleado, fondoInfo.fondo, editable ? 1 : 0, ahora, ahora],
    });
    await auditar(db, req, {
      tipo_evento: 'CAJA_APERTURA_INICIADA', entidad: 'caja_turnos',
      entidad_id: r.lastInsertRowid?.toString(), empleado, centro,
      payload: { turno, fecha },
    });
    return {
      ok: true, id: Number(r.lastInsertRowid), fecha,
      fondo_heredado: fondoInfo.fondo, fondo_editable: editable,
    };
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      return { ok: false, status: 409, error: "Ya hay una apertura para ese turno y esa fecha. Recarga la pantalla." };
    }
    throw e;
  }
}

/**
 * Confirma la apertura ya iniciada: guarda el desglose contado y calcula la
 * diferencia contra el fondo (heredado, o el escrito a mano si era
 * editable — que además se guarda aquí en `apertura_fondo_heredado`, cosa
 * que cierrecaja no llegaba a hacer y perdía el valor tecleado).
 */
export async function confirmarApertura(db, req, { id, desglose, fondoManual }) {
  const t = await db.execute({ sql: "SELECT * FROM caja_turnos WHERE id = ?", args: [id] });
  if (!t.rows.length) return { ok: false, status: 404, error: "Turno no encontrado" };
  const turno = t.rows[0];
  if (turno.estado !== 'pendiente') return { ok: false, status: 409, error: "Esta apertura ya está confirmada" };

  const totalContado = totalDesglose(desglose);
  const fondoBase = turno.apertura_fondo_editable ? round2(Number(fondoManual) || 0) : (Number(turno.apertura_fondo_heredado) || 0);
  const diferencia = round2(totalContado - fondoBase);
  const ahora = Date.now();

  await db.execute({
    sql: `UPDATE caja_turnos SET apertura_desglose = ?, apertura_total_contado = ?, apertura_diferencia = ?,
          apertura_fondo_heredado = ?, apertura_confirmada_en = ?, estado = 'apertura_ok', actualizado_en = ?
          WHERE id = ?`,
    args: [JSON.stringify(desglose), totalContado, diferencia, fondoBase, ahora, ahora, id],
  });
  await auditar(db, req, {
    tipo_evento: 'CAJA_APERTURA_CONFIRMADA', entidad: 'caja_turnos', entidad_id: String(id),
    empleado: turno.empleado, centro: turno.centro,
    payload: { total_contado: totalContado, diferencia },
  });
  return { ok: true, total_contado: totalContado, diferencia, fondo_base: fondoBase };
}

/**
 * Guarda el cierre: desglose, TPV, datáfonos (se borran los anteriores del
 * turno y se insertan los nuevos, igual que cierrecaja) y el semáforo — todo
 * en una sola transacción (`db.batch`), porque cierrecaja hacía esto en tres
 * escrituras sueltas sin ninguna garantía si la segunda o la tercera fallaba
 * a medias. Avisa por Telegram al terminar, con el semáforo destacado si es
 * rojo — el mismo aviso, llames a esta función desde el panel o desde el
 * asistente guiado de Telegram.
 */
export async function guardarCierre(db, req, { id, desglose, fondoDefinido, tpvEfectivo, tpvTarjeta, tpvVoids, numTickets, datafonos }) {
  const t = await db.execute({ sql: "SELECT * FROM caja_turnos WHERE id = ?", args: [id] });
  if (!t.rows.length) return { ok: false, status: 404, error: "Turno no encontrado" };
  const turno = t.rows[0];
  if (!['apertura_ok', 'reabierto'].includes(turno.estado)) {
    return { ok: false, status: 409, error: "Este turno no está listo para cerrar" };
  }

  const totalCaja = totalDesglose(desglose);
  const fondo = round2(Number(fondoDefinido) || 0);
  const efectivoNeto = round2(totalCaja - fondo);
  const tEfectivo = round2(Number(tpvEfectivo) || 0);
  const tTarjeta = round2(Number(tpvTarjeta) || 0);
  const totalDatafonos = round2((datafonos || []).reduce((acc, d) => acc + (Number(d.importe) || 0), 0));
  const difEfectivo = round2(efectivoNeto - tEfectivo);
  const difTarjeta = round2(totalDatafonos - tTarjeta);
  const semaforo = semaforoCaja(difEfectivo, difTarjeta);
  const voids = tpvVoids === '' || tpvVoids === null || tpvVoids === undefined ? null : round2(Number(tpvVoids) || 0);
  const tickets = numTickets === '' || numTickets === null || numTickets === undefined ? null : Math.trunc(Number(numTickets) || 0);
  const ahora = Date.now();

  const filasDatafonos = (datafonos || []).map((d, i) => ({
    nombre: String(d.nombre || `Datáfono ${i + 1}`).trim() || `Datáfono ${i + 1}`,
    importe: round2(Number(d.importe) || 0),
    orden: i + 1,
  }));

  await db.batch([
    {
      sql: `UPDATE caja_turnos SET
              cierre_desglose = ?, cierre_total_caja = ?, cierre_fondo_definido = ?,
              cierre_efectivo_neto = ?, cierre_tpv_efectivo = ?, cierre_tpv_tarjeta = ?,
              cierre_tpv_voids = ?, cierre_num_tickets = ?, cierre_dif_efectivo = ?,
              cierre_dif_tarjeta = ?, cierre_semaforo = ?, cierre_confirmado_en = ?,
              estado = 'cerrado', actualizado_en = ?
            WHERE id = ?`,
      args: [
        JSON.stringify(desglose), totalCaja, fondo, efectivoNeto, tEfectivo, tTarjeta,
        voids, tickets, difEfectivo, difTarjeta, semaforo, ahora, ahora, id,
      ],
    },
    { sql: `DELETE FROM caja_datafonos WHERE turno_id = ?`, args: [id] },
    ...filasDatafonos.map((f) => ({
      sql: `INSERT INTO caja_datafonos (turno_id, nombre, importe, orden) VALUES (?, ?, ?, ?)`,
      args: [id, f.nombre, f.importe, f.orden],
    })),
  ], "write");

  await auditar(db, req, {
    tipo_evento: 'CAJA_CIERRE_GUARDADO', entidad: 'caja_turnos', entidad_id: String(id),
    empleado: turno.empleado, centro: turno.centro,
    payload: { semaforo, dif_efectivo: difEfectivo, dif_tarjeta: difTarjeta },
  });

  const ETIQUETA_TURNO = { manana: 'Turno 1 (mañana)', tarde: 'Turno 2 (tarde)' };
  const EMOJI_SEMAFORO = { verde: '🟢', naranja: '🟠', rojo: '🔴' };
  const cabecera = semaforo === 'rojo'
    ? `🔴 <b>Descuadre en el cierre de caja</b>`
    : `${EMOJI_SEMAFORO[semaforo]} Cierre de caja confirmado`;
  await avisarTelegram(conEnlacePanel(
    `${cabecera}\n${escTelegram(ETIQUETA_TURNO[turno.turno])} · ${turno.fecha} · ${escTelegram(turno.centro)} · ${escTelegram(turno.empleado)}\n`
    + `Diferencia efectivo: ${difEfectivo >= 0 ? '+' : ''}${difEfectivo.toFixed(2)} € · `
    + `Diferencia tarjeta: ${difTarjeta >= 0 ? '+' : ''}${difTarjeta.toFixed(2)} €`,
    turno.centro
  ));

  return { ok: true, semaforo, dif_efectivo: difEfectivo, dif_tarjeta: difTarjeta, efectivo_neto: efectivoNeto, turno };
}

/**
 * Reabre un turno cerrado (solo gerencia, motivo de al menos 10 caracteres,
 * igual que cierrecaja). Nunca deja editable la apertura otra vez, solo el
 * cierre — y no borra los valores del cierre anterior, se sobrescriben si
 * se vuelve a guardar.
 */
export async function reabrirTurno(db, req, { id, motivo, nivel }) {
  const texto = String(motivo || '').trim();
  if (texto.length < 10) return { ok: false, status: 422, error: "El motivo debe tener al menos 10 caracteres" };

  const t = await db.execute({ sql: "SELECT * FROM caja_turnos WHERE id = ?", args: [id] });
  if (!t.rows.length) return { ok: false, status: 404, error: "Turno no encontrado" };
  const turno = t.rows[0];
  if (turno.estado !== 'cerrado') return { ok: false, status: 409, error: "Solo se puede reabrir un turno cerrado" };

  const ahora = Date.now();
  await db.execute({
    sql: `INSERT INTO caja_reaperturas (turno_id, motivo, nivel, creado_en) VALUES (?, ?, ?, ?)`,
    args: [id, texto, nivel, ahora],
  });
  await db.execute({
    sql: `UPDATE caja_turnos SET estado = 'reabierto', cierre_confirmado_en = NULL, actualizado_en = ? WHERE id = ?`,
    args: [ahora, id],
  });
  await auditar(db, req, {
    tipo_evento: 'CAJA_REABIERTA', entidad: 'caja_turnos', entidad_id: String(id), centro: turno.centro,
    payload: { motivo: texto, nivel },
  });

  const ETIQUETA_TURNO = { manana: 'Turno 1 (mañana)', tarde: 'Turno 2 (tarde)' };
  await avisarTelegram(conEnlacePanel(
    `♻️ <b>Cierre reabierto</b> por ${nivel === 'ADMIN' ? 'gerencia' : 'encargado'}\n`
    + `${escTelegram(ETIQUETA_TURNO[turno.turno] || turno.turno)} · ${turno.fecha} · ${escTelegram(turno.centro)}\n`
    + `Motivo: ${escTelegram(texto)}`,
    turno.centro
  ));

  return { ok: true, turno };
}

export async function listarTurnos(db, filtros = {}) {
  const cond = [];
  const args = [];
  if (filtros.centro) { cond.push("LOWER(TRIM(centro)) = LOWER(TRIM(?))"); args.push(filtros.centro); }
  if (filtros.fecha_desde) { cond.push("fecha >= ?"); args.push(filtros.fecha_desde); }
  if (filtros.fecha_hasta) { cond.push("fecha <= ?"); args.push(filtros.fecha_hasta); }
  if (filtros.turno) { cond.push("turno = ?"); args.push(filtros.turno); }
  if (filtros.semaforo) { cond.push("cierre_semaforo = ?"); args.push(filtros.semaforo); }
  if (filtros.empleado) { cond.push("LOWER(empleado) LIKE LOWER(?)"); args.push(`%${filtros.empleado}%`); }

  const sql = `SELECT * FROM caja_turnos ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
               ORDER BY fecha DESC, turno DESC LIMIT 500`;
  const r = await db.execute({ sql, args });
  return r.rows.map(formatearTurno);
}

export async function detalleTurno(db, id) {
  const t = await db.execute({ sql: "SELECT * FROM caja_turnos WHERE id = ?", args: [id] });
  if (!t.rows.length) return null;
  const datafonos = await db.execute({ sql: "SELECT nombre, importe, orden FROM caja_datafonos WHERE turno_id = ? ORDER BY orden", args: [id] });
  const reaperturas = await db.execute({ sql: "SELECT motivo, nivel, creado_en FROM caja_reaperturas WHERE turno_id = ? ORDER BY id DESC", args: [id] });
  return { ...formatearTurno(t.rows[0]), datafonos: datafonos.rows, reaperturas: reaperturas.rows };
}

export default async function handler(req, res) {
  try {
    const db = getDbClient();
    await initSchema(db);
    const accion = req.query?.accion || '';

    if (req.method === 'GET' && accion === 'activo') {
      const centro = await centroDeEmpleado(db, req.query.empleado || '', req.query.centro || '');
      const cfg = await getCentroCfg(db, centro);
      const hoy = hoyEnCentro(cfg);
      const [activo, progreso] = await Promise.all([
        turnoActivo(db, centro),
        progresoHoy(db, centro, hoy),
      ]);
      return res.status(200).json({ centro, hoy, turno_activo: activo, progreso_hoy: progreso });
    }

    if (req.method === 'POST' && accion === 'crear-apertura') {
      const b = req.body || {};
      const empleado = String(b.empleado || '').trim();
      const pin = await verificarPin(db, empleado, b.pin, b.sesion || req.headers['x-sesion'] || '');
      if (!pin.ok) return res.status(403).json({ error: pin.motivo });

      const centro = await centroDeEmpleado(db, empleado, b.centro || '');
      const conTurno = await turnoAbierto(db, empleado, centro);
      if (!conTurno && !pin.sinPin) return res.status(403).json({ error: "Debes fichar tu entrada para abrir caja" });

      const r = await crearApertura(db, req, { centro, turno: b.turno, empleado });
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      return res.status(201).json(r);
    }

    if (req.method === 'PUT' && accion === 'confirmar-apertura') {
      const b = req.body || {};
      const empleado = String(b.empleado || '').trim();
      const pin = await verificarPin(db, empleado, b.pin, b.sesion || req.headers['x-sesion'] || '');
      if (!pin.ok) return res.status(403).json({ error: pin.motivo });

      const id = Number(b.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id requerido" });
      const t = await db.execute({ sql: "SELECT empleado FROM caja_turnos WHERE id = ?", args: [id] });
      if (!t.rows.length) return res.status(404).json({ error: "Turno no encontrado" });
      if (String(t.rows[0].empleado).trim().toLowerCase() !== empleado.toLowerCase()) {
        return res.status(403).json({ error: "Esta apertura la empezó otra persona" });
      }

      const r = await confirmarApertura(db, req, { id, desglose: b.desglose, fondoManual: b.fondo_manual });
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      return res.status(200).json(r);
    }

    if (req.method === 'PUT' && accion === 'guardar-cierre') {
      const b = req.body || {};
      const empleado = String(b.empleado || '').trim();
      const pin = await verificarPin(db, empleado, b.pin, b.sesion || req.headers['x-sesion'] || '');
      if (!pin.ok) return res.status(403).json({ error: pin.motivo });

      const id = Number(b.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id requerido" });
      const t = await db.execute({ sql: "SELECT empleado FROM caja_turnos WHERE id = ?", args: [id] });
      if (!t.rows.length) return res.status(404).json({ error: "Turno no encontrado" });
      if (String(t.rows[0].empleado).trim().toLowerCase() !== empleado.toLowerCase()) {
        return res.status(403).json({ error: "Este turno lo empezó otra persona" });
      }

      const r = await guardarCierre(db, req, {
        id, desglose: b.desglose, fondoDefinido: b.fondo_definido,
        tpvEfectivo: b.tpv_efectivo, tpvTarjeta: b.tpv_tarjeta, tpvVoids: b.tpv_voids,
        numTickets: b.num_tickets, datafonos: b.datafonos,
      });
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      return res.status(200).json({
        success: true, semaforo: r.semaforo, dif_efectivo: r.dif_efectivo,
        dif_tarjeta: r.dif_tarjeta, efectivo_neto: r.efectivo_neto,
      });
    }

    if (req.method === 'GET' && accion === 'listado') {
      if (!esEncargadoOSuperior(req)) return res.status(403).json({ error: "No autorizado" });
      const filas = await listarTurnos(db, req.query);
      return res.status(200).json(filas);
    }

    if (req.method === 'GET' && accion === 'detalle') {
      if (!esEncargadoOSuperior(req)) return res.status(403).json({ error: "No autorizado" });
      const id = Number(req.query.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id requerido" });
      const d = await detalleTurno(db, id);
      if (!d) return res.status(404).json({ error: "No encontrado" });
      return res.status(200).json(d);
    }

    if (req.method === 'POST' && accion === 'reabrir') {
      if (!esEncargadoOSuperior(req)) return res.status(403).json({ error: "No autorizado" });
      const b = req.body || {};
      const id = Number(b.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id requerido" });
      const r = await reabrirTurno(db, req, { id, motivo: b.motivo, nivel: nivelDesdeReq(req) });
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}
