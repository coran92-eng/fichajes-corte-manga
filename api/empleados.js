import { getDbClient } from "./db.js";

const DEFAULTS = ['Albert','Maikel','Carlos','Jecko','Pol','Sonia','Nacho','Claudia'];

export default async function handler(req, res) {
  try {
    const db = getDbClient();

    await db.execute(`
      CREATE TABLE IF NOT EXISTS empleados (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        centro TEXT NOT NULL DEFAULT ''
      )
    `);

    try {
      await db.execute("ALTER TABLE empleados ADD COLUMN centro TEXT NOT NULL DEFAULT ''");
    } catch {}

    try {
      await db.execute("ALTER TABLE empleados ADD COLUMN rol TEXT NOT NULL DEFAULT ''");
    } catch {}

    if (req.method === "GET") {
      res.setHeader('Cache-Control', 'no-store');
      const { centro } = req.query;
      let result;

      if (centro) {
        // Empleados del centro + los que no tengan centro asignado.
        // Comparación tolerante: ignora mayúsculas y espacios sobrantes.
        result = await db.execute({
          sql: "SELECT nombre, centro, rol FROM empleados WHERE LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?)) OR TRIM(COALESCE(centro,'')) = '' ORDER BY nombre ASC",
          args: [centro]
        });
      } else {
        result = await db.execute("SELECT nombre, centro, rol FROM empleados ORDER BY nombre ASC");
      }

      if (result.rows.length === 0) {
        if (centro) {
          // No hay empleados para este centro, usar todos los empleados
          result = await db.execute("SELECT nombre, centro, rol FROM empleados ORDER BY nombre ASC");
        }
        if (result.rows.length === 0) {
          // Tabla vacía, insertar defaults
          for (const nombre of DEFAULTS) {
            await db.execute({ sql: "INSERT OR IGNORE INTO empleados (nombre, centro) VALUES (?, '')", args: [nombre] });
          }
          result = await db.execute("SELECT nombre, centro, rol FROM empleados ORDER BY nombre ASC");
        }
      }

      return res.status(200).json(result.rows.map(r => ({ nombre: r.nombre, centro: r.centro, rol: r.rol || '' })));
    }
    else if (req.method === "POST") {
      const { nombre, centro = '', rol = '' } = req.body;
      if (!nombre || !nombre.trim()) {
        return res.status(400).json({ error: "Nombre requerido" });
      }
      await db.execute({
        sql: "INSERT OR IGNORE INTO empleados (nombre, centro, rol) VALUES (?, ?, ?)",
        args: [nombre.trim(), centro, rol]
      });
      return res.status(201).json({ success: true });
    }
    else if (req.method === "PUT") {
      const { nombre, centro, rol } = req.body;
      if (!nombre || !nombre.trim()) {
        return res.status(400).json({ error: "Nombre requerido" });
      }
      // Actualiza solo los campos presentes (para permitir cambiar rol sin tocar centro y viceversa)
      const sets = [];
      const args = [];
      if (typeof centro === 'string') { sets.push("centro = ?"); args.push(centro); }
      if (typeof rol === 'string')    { sets.push("rol = ?");    args.push(rol); }
      if (sets.length === 0) {
        return res.status(400).json({ error: "Nada que actualizar (indica centro o rol)" });
      }
      args.push(nombre.trim());
      await db.execute({
        sql: `UPDATE empleados SET ${sets.join(', ')} WHERE nombre = ?`,
        args
      });
      return res.status(200).json({ success: true });
    }
    else if (req.method === "DELETE") {
      const { nombre } = req.body;
      if (!nombre) {
        return res.status(400).json({ error: "Nombre requerido" });
      }
      await db.execute({
        sql: "DELETE FROM empleados WHERE nombre = ?",
        args: [nombre]
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
