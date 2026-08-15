import { getDbClient } from "./_db.js";

export default async function handler(req, res) {
  try {
    const db = getDbClient();

    await db.execute(`
      CREATE TABLE IF NOT EXISTS horarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        empleado TEXT NOT NULL,
        centro TEXT NOT NULL DEFAULT '',
        fecha TEXT NOT NULL,
        hora_entrada TEXT NOT NULL,
        hora_salida TEXT NOT NULL,
        semana TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'pendiente',
        creado_en INTEGER NOT NULL,
        notas TEXT NOT NULL DEFAULT ''
      )
    `);

    // Migraciones para rol del día, cambio a media jornada y descanso planificado
    try { await db.execute("ALTER TABLE horarios ADD COLUMN rol_primera TEXT NOT NULL DEFAULT ''"); } catch {}
    try { await db.execute("ALTER TABLE horarios ADD COLUMN hora_cambio TEXT NOT NULL DEFAULT ''"); } catch {}
    try { await db.execute("ALTER TABLE horarios ADD COLUMN rol_segunda TEXT NOT NULL DEFAULT ''"); } catch {}
    try { await db.execute("ALTER TABLE horarios ADD COLUMN hora_descanso TEXT NOT NULL DEFAULT ''"); } catch {}

    if (req.method === "GET") {
      const { empleado, centro, semana, estado, fecha, fecha_desde, fecha_hasta } = req.query;

      let conditions = [];
      let args = [];

      if (empleado) {
        conditions.push("empleado = ?");
        args.push(empleado);
      }
      if (centro) {
        conditions.push("centro = ?");
        args.push(centro);
      }
      if (semana) {
        conditions.push("semana = ?");
        args.push(semana);
      }
      if (estado) {
        conditions.push("estado = ?");
        args.push(estado);
      }
      if (fecha) {
        conditions.push("fecha = ?");
        args.push(fecha);
      }
      // Rango de fechas: la pantalla de fichaje pide ayer/hoy/mañana de una vez
      // para localizar el turno en curso aunque cruce la medianoche.
      if (fecha_desde) {
        conditions.push("fecha >= ?");
        args.push(fecha_desde);
      }
      if (fecha_hasta) {
        conditions.push("fecha <= ?");
        args.push(fecha_hasta);
      }

      let query = "SELECT * FROM horarios";
      if (conditions.length) query += " WHERE " + conditions.join(" AND ");
      query += " ORDER BY fecha ASC, hora_entrada ASC";

      const result = await db.execute({ sql: query, args });
      return res.status(200).json(result.rows);
    }
    else if (req.method === "POST") {
      const {
        empleado, centro = '', fecha,
        hora_entrada, hora_salida, semana, notas = '',
        rol_primera = '', hora_cambio = '', rol_segunda = '',
        hora_descanso = '', origen = ''
      } = req.body;

      if (!empleado || !fecha || !hora_entrada || !hora_salida || !semana) {
        return res.status(400).json({ error: "Faltan campos requeridos" });
      }

      // Se aceptan horarios de cualquier fecha. Antes se exigía enviarlos con
      // dos semanas de antelación, pero en la práctica el cuadrante se cierra
      // sobre la marcha y esa regla solo impedía registrar lo que ya estaba
      // decidido.

      await db.execute({
        sql: "DELETE FROM horarios WHERE empleado = ? AND fecha = ? AND centro = ?",
        args: [empleado, fecha, centro],
      });

      const result = await db.execute({
        sql: "INSERT INTO horarios (empleado, centro, fecha, hora_entrada, hora_salida, semana, estado, creado_en, notas, rol_primera, hora_cambio, rol_segunda, hora_descanso) VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?, ?)",
        args: [empleado, centro, fecha, hora_entrada, hora_salida, semana, Date.now(), notas, rol_primera, hora_cambio, rol_segunda, hora_descanso],
      });

      return res.status(201).json({ success: true, id: result.lastInsertRowid.toString() });
    }
    else if (req.method === "PUT") {
      const { semana, centro, estado, ids } = req.body;

      if (!estado || (estado !== 'validado' && estado !== 'rechazado')) {
        return res.status(400).json({ error: "El estado debe ser 'validado' o 'rechazado'" });
      }

      if (ids && Array.isArray(ids)) {
        for (const id of ids) {
          await db.execute({
            sql: "UPDATE horarios SET estado = ? WHERE id = ?",
            args: [estado, id],
          });
        }
      } else {
        await db.execute({
          sql: "UPDATE horarios SET estado = ? WHERE semana = ? AND centro = ?",
          args: [estado, semana, centro],
        });
      }

      return res.status(200).json({ success: true });
    }
    else if (req.method === "DELETE") {
      const { id } = req.query;

      await db.execute({
        sql: "DELETE FROM horarios WHERE id = ?",
        args: [id],
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
