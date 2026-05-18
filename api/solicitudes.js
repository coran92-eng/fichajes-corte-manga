import { getDbClient } from "./db.js";

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
        conditions.push("centro = ?");
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

      const result = await db.execute({
        sql: `INSERT INTO solicitudes
          (empleado, centro, tipo_solicitud, fichaje_id, tipo_fichaje, fecha, hora_original, hora_propuesta, motivo, estado, creado_en)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)`,
        args: [
          empleado, centro, tipo_solicitud, fichaje_id, tipo_fichaje, fecha,
          hora_original, hora_propuesta, motivo, Date.now(),
        ],
      });

      return res.status(201).json({ success: true, id: result.lastInsertRowid.toString() });
    }
    else if (req.method === "PUT") {
      const { id, estado, nota_admin = '' } = req.body;

      if (!id) {
        return res.status(400).json({ error: "Falta el id de la solicitud" });
      }
      if (estado !== 'aprobada' && estado !== 'rechazada') {
        return res.status(400).json({ error: "El estado debe ser 'aprobada' o 'rechazada'" });
      }

      const solRes = await db.execute({
        sql: "SELECT * FROM solicitudes WHERE id = ?",
        args: [id],
      });
      const sol = solRes.rows[0];
      if (!sol) {
        return res.status(404).json({ error: "Solicitud no encontrada" });
      }
      if (sol.estado !== 'pendiente') {
        return res.status(409).json({ error: "La solicitud ya fue resuelta" });
      }

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
            await db.execute({
              sql: "DELETE FROM fichajes WHERE id = ?",
              args: [sol.fichaje_id],
            });
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
        args: [estado, nota_admin, Date.now(), id],
      });

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
