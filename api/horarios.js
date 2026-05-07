import { getDbClient } from "./db.js";

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

    if (req.method === "GET") {
      const { empleado, centro, semana, estado, fecha } = req.query;

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

      let query = "SELECT * FROM horarios";
      if (conditions.length) query += " WHERE " + conditions.join(" AND ");
      query += " ORDER BY fecha ASC, hora_entrada ASC";

      const result = await db.execute({ sql: query, args });
      return res.status(200).json(result.rows);
    }
    else if (req.method === "POST") {
      const { empleado, centro = '', fecha, hora_entrada, hora_salida, semana, notas = '' } = req.body;

      if (!empleado || !fecha || !hora_entrada || !hora_salida || !semana) {
        return res.status(400).json({ error: "Faltan campos requeridos" });
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const minDate = new Date(today);
      minDate.setDate(minDate.getDate() + 14);

      const scheduleDate = new Date(fecha);
      scheduleDate.setHours(0, 0, 0, 0);

      if (scheduleDate < minDate) {
        return res.status(400).json({ error: "Los horarios deben enviarse con al menos 2 semanas de antelación" });
      }

      await db.execute({
        sql: "DELETE FROM horarios WHERE empleado = ? AND fecha = ? AND centro = ?",
        args: [empleado, fecha, centro],
      });

      const result = await db.execute({
        sql: "INSERT INTO horarios (empleado, centro, fecha, hora_entrada, hora_salida, semana, estado, creado_en, notas) VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?, ?)",
        args: [empleado, centro, fecha, hora_entrada, hora_salida, semana, Date.now(), notas],
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
