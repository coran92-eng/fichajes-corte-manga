import { getDbClient } from "./db.js";

export default async function handler(req, res) {
  try {
    const db = getDbClient();

    // Crear tabla si no existe (normalmente esto se hace una vez por CLI, pero para facilitar el setup lo ponemos aquí)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS fichajes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        empleado TEXT NOT NULL,
        tipo TEXT NOT NULL,
        fecha TEXT NOT NULL,
        hora TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        centro TEXT NOT NULL DEFAULT ''
      )
    `);

    try {
      await db.execute("ALTER TABLE fichajes ADD COLUMN centro TEXT NOT NULL DEFAULT ''");
    } catch {}

    try {
      await db.execute("ALTER TABLE fichajes ADD COLUMN corregido INTEGER NOT NULL DEFAULT 0");
    } catch {}

    if (req.method === "GET") {
      const { empleado, limit, centro } = req.query;

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

      let query = "SELECT * FROM fichajes";
      if (conditions.length) query += " WHERE " + conditions.join(" AND ");
      query += " ORDER BY timestamp DESC";

      if (limit) {
        query += " LIMIT ?";
        args.push(parseInt(limit, 10));
      }

      const result = await db.execute({ sql: query, args });
      return res.status(200).json(result.rows);
    } 
    else if (req.method === "POST") {
      const { empleado, tipo, fecha, hora, timestamp, centro = '' } = req.body;

      if (!empleado || !tipo || !fecha || !hora || !timestamp) {
        return res.status(400).json({ error: "Faltan campos requeridos" });
      }

      const result = await db.execute({
        sql: "INSERT INTO fichajes (empleado, tipo, fecha, hora, timestamp, centro) VALUES (?, ?, ?, ?, ?, ?)",
        args: [empleado, tipo, fecha, hora, timestamp, centro],
      });

      return res.status(201).json({ success: true, id: result.lastInsertRowid.toString() });
    } 
    else if (req.method === "DELETE") {
      const { id, empleado } = req.query;
      if (id && empleado) {
        await db.execute({
          sql: "DELETE FROM fichajes WHERE timestamp = ? AND empleado = ?",
          args: [parseInt(id, 10), empleado],
        });
        return res.status(200).json({ success: true, message: "Registro eliminado" });
      }
      await db.execute("DELETE FROM fichajes");
      return res.status(200).json({ success: true, message: "Todos los registros eliminados" });
    } 
    else {
      return res.status(405).json({ error: "Method not allowed" });
    }
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}
