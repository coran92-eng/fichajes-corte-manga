import { getDbClient } from "./db.js";
import { hashPin, esEncargadoOSuperior } from "./_tareas-lib.js";

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

    // PIN para autorizar acciones en la tablet compartida (módulo de tareas).
    try {
      await db.execute("ALTER TABLE empleados ADD COLUMN pin_hash TEXT NOT NULL DEFAULT ''");
    } catch {}

    // Horario habitual (JSON por día de la semana, 1=lunes ... 7=domingo).
    // Se configura una vez y sirve de referencia cuando no hay horario semanal
    // validado, para no depender de que alguien lo suba cada semana.
    try {
      await db.execute("ALTER TABLE empleados ADD COLUMN horario_habitual TEXT NOT NULL DEFAULT ''");
    } catch {}

    if (req.method === "GET") {
      res.setHeader('Cache-Control', 'no-store');
      const { centro } = req.query;
      let result;
      // Nunca se devuelve el hash del PIN: solo si lo tiene puesto o no.
      const COLS = "nombre, centro, rol, horario_habitual, CASE WHEN COALESCE(pin_hash,'') = '' THEN 0 ELSE 1 END AS tiene_pin";

      if (centro) {
        // Empleados del centro + los que no tengan centro asignado.
        // Comparación tolerante: ignora mayúsculas y espacios sobrantes.
        result = await db.execute({
          sql: `SELECT ${COLS} FROM empleados WHERE LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?)) OR TRIM(COALESCE(centro,'')) = '' ORDER BY nombre ASC`,
          args: [centro]
        });
      } else {
        result = await db.execute(`SELECT ${COLS} FROM empleados ORDER BY nombre ASC`);
      }

      if (result.rows.length === 0) {
        if (centro) {
          // No hay empleados para este centro, usar todos los empleados
          result = await db.execute(`SELECT ${COLS} FROM empleados ORDER BY nombre ASC`);
        }
        if (result.rows.length === 0) {
          // Tabla vacía, insertar defaults
          for (const nombre of DEFAULTS) {
            await db.execute({ sql: "INSERT OR IGNORE INTO empleados (nombre, centro) VALUES (?, '')", args: [nombre] });
          }
          result = await db.execute(`SELECT ${COLS} FROM empleados ORDER BY nombre ASC`);
        }
      }

      return res.status(200).json(result.rows.map(r => ({
        nombre: r.nombre,
        centro: r.centro,
        rol: r.rol || '',
        horario_habitual: r.horario_habitual || '',
        tiene_pin: Number(r.tiene_pin) === 1,
      })));
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
      const { nombre, centro, rol, pin, horario_habitual } = req.body;
      if (!nombre || !nombre.trim()) {
        return res.status(400).json({ error: "Nombre requerido" });
      }
      // Actualiza solo los campos presentes (para permitir cambiar rol sin tocar centro y viceversa)
      const sets = [];
      const args = [];
      if (typeof centro === 'string') { sets.push("centro = ?"); args.push(centro); }
      if (typeof rol === 'string')    { sets.push("rol = ?");    args.push(rol); }

      // El PIN solo lo puede fijar/borrar el encargado o gerencia.
      if (pin !== undefined) {
        if (!esEncargadoOSuperior(req)) {
          return res.status(403).json({ error: "Solo el encargado puede asignar el PIN" });
        }
        const limpio = String(pin).trim();
        if (limpio === '') {
          sets.push("pin_hash = ?");
          args.push('');
        } else if (!/^\d{4,6}$/.test(limpio)) {
          return res.status(422).json({ error: "El PIN debe tener entre 4 y 6 dígitos" });
        } else {
          sets.push("pin_hash = ?");
          args.push(hashPin(nombre.trim(), limpio));
        }
      }

      if (typeof horario_habitual === 'string') {
        // Se guarda tal cual, pero comprobando que es JSON válido.
        if (horario_habitual !== '') {
          try { JSON.parse(horario_habitual); }
          catch { return res.status(422).json({ error: "Horario habitual no válido" }); }
        }
        sets.push("horario_habitual = ?");
        args.push(horario_habitual);
      }

      if (sets.length === 0) {
        return res.status(400).json({ error: "Nada que actualizar (indica centro, rol, pin u horario)" });
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
