import { getDbClient } from "./_db.js";
import { avisarTelegram, escTelegram, conEnlacePanel } from "./_telegram.js";
import { centroDeEmpleado, telegramChatDeEmpleado, esEncargadoOSuperior } from "./_tareas-lib.js";
import { avisarEmpleado } from "./_telegram-empleados.js";

const TIPOS_SOLICITUD = ['modificar', 'crear', 'eliminar'];
const TIPOS_FICHAJE = ['entrada', 'salida', 'inicio_descanso', 'fin_descanso'];

function horaCompleta(hora) {
  const partes = String(hora).split(':');
  while (partes.length < 3) partes.push('00');
  return partes.slice(0, 3).map(p => p.padStart(2, '0')).join(':');
}

function calcularTimestamp(fecha, hora) {
  const ms = new Date(`${fecha}T${horaCompleta(hora)}`).getTime();
  return Number.isNaN(ms) ? Date.now() : ms;
}

/**
 * Aplica una decisión sobre una solicitud pendiente: aprobarla inserta,
 * modifica o borra el fichaje real que pedía; rechazarla no toca fichajes.
 * En los dos casos, queda resuelta y se avisa a quien la pidió. Usado tanto
 * por el PUT de abajo (desde el panel) como por el botón aprobar/rechazar
 * del bot de gerencia en Telegram (§ telegram-webhook.js) — mismo camino,
 * para no mantener la lógica de "aprobar" en dos sitios distintos.
 *
 * Devuelve { ok: true } o { ok: false, status, error }.
 */
export async function resolverSolicitud(db, id, estado, notaAdmin = '') {
  if (estado !== 'aprobada' && estado !== 'rechazada') {
    return { ok: false, status: 400, error: "El estado debe ser 'aprobada' o 'rechazada'" };
  }

  const solRes = await db.execute({ sql: "SELECT * FROM solicitudes WHERE id = ?", args: [id] });
  const sol = solRes.rows[0];
  if (!sol) return { ok: false, status: 404, error: "Solicitud no encontrada" };
  if (sol.estado !== 'pendiente') return { ok: false, status: 409, error: "La solicitud ya fue resuelta" };

  if (estado === 'aprobada') {
    const hora = horaCompleta(sol.hora_propuesta || sol.hora_original);
    const ts = calcularTimestamp(sol.fecha, hora);

    if (sol.tipo_solicitud === 'crear') {
      await db.execute({
        sql: "INSERT INTO fichajes (empleado, tipo, fecha, hora, timestamp, centro, corregido) VALUES (?, ?, ?, ?, ?, ?, 1)",
        args: [sol.empleado, sol.tipo_fichaje, sol.fecha, hora, ts, sol.centro || ''],
      });
    } else if (sol.tipo_solicitud === 'modificar') {
      let targetId = sol.fichaje_id;
      if (!targetId) {
        const f = await db.execute({
          sql: "SELECT id FROM fichajes WHERE empleado = ? AND fecha = ? AND tipo = ? ORDER BY timestamp DESC LIMIT 1",
          args: [sol.empleado, sol.fecha, sol.tipo_fichaje],
        });
        targetId = f.rows[0]?.id ?? null;
      }
      if (targetId) {
        await db.execute({
          sql: "UPDATE fichajes SET hora = ?, timestamp = ?, corregido = 1 WHERE id = ?",
          args: [hora, ts, targetId],
        });
      } else {
        await db.execute({
          sql: "INSERT INTO fichajes (empleado, tipo, fecha, hora, timestamp, centro, corregido) VALUES (?, ?, ?, ?, ?, ?, 1)",
          args: [sol.empleado, sol.tipo_fichaje, sol.fecha, hora, ts, sol.centro || ''],
        });
      }
    } else if (sol.tipo_solicitud === 'eliminar') {
      if (sol.fichaje_id) {
        await db.execute({ sql: "DELETE FROM fichajes WHERE id = ?", args: [sol.fichaje_id] });
      } else {
        await db.execute({
          sql: "DELETE FROM fichajes WHERE id = (SELECT id FROM fichajes WHERE empleado = ? AND fecha = ? AND tipo = ? ORDER BY timestamp DESC LIMIT 1)",
          args: [sol.empleado, sol.fecha, sol.tipo_fichaje],
        });
      }
    }
  }

  await db.execute({
    sql: "UPDATE solicitudes SET estado = ?, nota_admin = ?, resuelto_en = ? WHERE id = ?",
    args: [estado, notaAdmin, Date.now(), id],
  });

  // Quien la pidió se entera de si se aprobó o se rechazó, en vez de tener
  // que volver a mirar si ya se resolvió.
  const chatId = await telegramChatDeEmpleado(db, sol.empleado);
  if (chatId) {
    const emoji = estado === 'aprobada' ? '✅' : '❌';
    await avisarEmpleado(chatId,
      `${emoji} Tu solicitud del ${sol.fecha} ha sido ${estado === 'aprobada' ? 'aprobada' : 'rechazada'}.`
      + (notaAdmin ? `\n${escTelegram(notaAdmin)}` : '')
    );
  }

  return { ok: true, sol };
}

export default async function handler(req, res) {
  try {
    const db = getDbClient();

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

    try {
      await db.execute("ALTER TABLE fichajes ADD COLUMN corregido INTEGER NOT NULL DEFAULT 0");
    } catch {}

    if (req.method === "GET") {
      const { estado, empleado, centro } = req.query;

      let conditions = [];
      let args = [];

      if (estado) {
        conditions.push("estado = ?");
        args.push(estado);
      }
      if (empleado) {
        conditions.push("empleado = ?");
        args.push(empleado);
      }
      if (centro) {
        conditions.push("LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?))");
        args.push(centro);
      }

      let query = "SELECT * FROM solicitudes";
      if (conditions.length) query += " WHERE " + conditions.join(" AND ");
      query += " ORDER BY creado_en DESC";

      const result = await db.execute({ sql: query, args });
      return res.status(200).json(result.rows);
    }
    else if (req.method === "POST") {
      const {
        empleado,
        centro = '',
        tipo_solicitud,
        fichaje_id = null,
        tipo_fichaje,
        fecha,
        hora_original = '',
        hora_propuesta = '',
        motivo,
      } = req.body;

      if (!empleado || !tipo_solicitud || !tipo_fichaje || !fecha || !motivo) {
        return res.status(400).json({ error: "Faltan campos requeridos" });
      }
      if (!TIPOS_SOLICITUD.includes(tipo_solicitud)) {
        return res.status(400).json({ error: "tipo_solicitud no válido" });
      }
      if (!TIPOS_FICHAJE.includes(tipo_fichaje)) {
        return res.status(400).json({ error: "tipo_fichaje no válido" });
      }
      if ((tipo_solicitud === 'crear' || tipo_solicitud === 'modificar') && !hora_propuesta) {
        return res.status(400).json({ error: "Falta la hora propuesta" });
      }

      const centroResuelto = await centroDeEmpleado(db, empleado, centro);

      const result = await db.execute({
        sql: `INSERT INTO solicitudes
          (empleado, centro, tipo_solicitud, fichaje_id, tipo_fichaje, fecha, hora_original, hora_propuesta, motivo, estado, creado_en)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)`,
        args: [
          empleado, centroResuelto, tipo_solicitud, fichaje_id, tipo_fichaje, fecha,
          hora_original, hora_propuesta, motivo, Date.now(),
        ],
      });

      // Toda solicitud de corrección avisa: es el empleado pidiendo que
      // alguien con acceso al panel revise y apruebe o rechace un fichaje.
      const campo = String(tipo_fichaje).replace(/_/g, ' ');
      const verbo = tipo_solicitud === 'crear'
        ? `crear un fichaje de ${campo} el ${fecha} a las ${hora_propuesta}`
        : tipo_solicitud === 'modificar'
          ? `corregir su ${campo} del ${fecha}` + (hora_original
              ? ` (${hora_original} → ${hora_propuesta})`
              : ` a las ${hora_propuesta}`)
          : `eliminar su ${campo} del ${fecha}` + (hora_original ? ` (${hora_original})` : '');

      await avisarTelegram(conEnlacePanel(
        `✏️ <b>${escTelegram(empleado)}</b> ha pedido ${escTelegram(verbo)} en ${escTelegram(centroResuelto || 'la app')}.\n`
        + `Motivo: ${escTelegram(motivo)}`,
        centroResuelto
      ));

      return res.status(201).json({ success: true, id: result.lastInsertRowid.toString() });
    }
    else if (req.method === "PUT") {
      // Aprobar o rechazar una solicitud inserta/modifica/borra fichajes de
      // verdad: antes no había ninguna comprobación, así que cualquiera con
      // la URL podía aprobarse su propia solicitud.
      if (!esEncargadoOSuperior(req)) {
        return res.status(403).json({ error: "No autorizado" });
      }
      const { id, estado, nota_admin = '' } = req.body;
      if (!id) {
        return res.status(400).json({ error: "Falta el id de la solicitud" });
      }

      const r = await resolverSolicitud(db, id, estado, nota_admin);
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      return res.status(200).json({ success: true });
    }
    else {
      return res.status(405).json({ error: "Method not allowed" });
    }
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}
