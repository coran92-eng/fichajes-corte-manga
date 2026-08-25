import { getDbClient } from "./_db.js";
import {
  hashPin, esEncargadoOSuperior, pinYaEnUso, auditar, PIN_DIGITOS,
  guardarPinAdmin, hayPinAdmin, esPinAdmin, nivelDesdeReq,
} from "./_tareas-lib.js";
import crypto from "node:crypto";

const DEFAULTS = ['Albert','Maikel','Carlos','Jecko','Pol','Sonia','Nacho','Claudia'];

// El esquema se prepara una vez por instancia, no en cada petición: eran seis
// viajes a la base antes de cada consulta, y es justo lo que dejó colgadas las
// pantallas del panel y de los horarios.
let esquemaListo = false;

async function prepararEsquema(db) {
  if (esquemaListo) return;

  await db.execute(`
    CREATE TABLE IF NOT EXISTS empleados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      centro TEXT NOT NULL DEFAULT ''
    )
  `);

  try { await db.execute("ALTER TABLE empleados ADD COLUMN centro TEXT NOT NULL DEFAULT ''"); } catch {}
  try { await db.execute("ALTER TABLE empleados ADD COLUMN rol TEXT NOT NULL DEFAULT ''"); } catch {}
  // PIN para autorizar acciones en la tablet compartida (módulo de tareas).
  try { await db.execute("ALTER TABLE empleados ADD COLUMN pin_hash TEXT NOT NULL DEFAULT ''"); } catch {}
  // Horario habitual (JSON por día de la semana, 1=lunes ... 7=domingo).
  try { await db.execute("ALTER TABLE empleados ADD COLUMN horario_habitual TEXT NOT NULL DEFAULT ''"); } catch {}

  // El nombre es la identidad: con él se busca el PIN, se firman las sesiones
  // y se une el historial de fichajes. Sin esta restricción se podían crear
  // dos «Albert», y entonces "INSERT OR IGNORE" no ignoraba nada, la búsqueda
  // se quedaba con el primero y los UPDATE tocaban a los dos.
  // Si ya hay duplicados el índice falla; se resuelven uniendo nombres desde
  // la pantalla "Arreglar fichajes", que se escribió justo para esto.
  try {
    await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_empleados_nombre ON empleados (LOWER(TRIM(nombre)))");
  } catch {}

  esquemaListo = true;
}

/** Un PIN de seis dígitos que no tenga ya otro empleado. */
async function generarPin(db, paraQuien) {
  for (let intento = 0; intento < 20; intento++) {
    const n = crypto.randomInt(0, 10 ** PIN_DIGITOS);
    const pin = String(n).padStart(PIN_DIGITOS, '0');
    // Si dos personas comparten número, el PIN deja de identificar a una sola
    // —que es justo lo que se le está pidiendo—, así que se descarta.
    if (!(await pinYaEnUso(db, pin, paraQuien))) return pin;
  }
  return null;
}

export default async function handler(req, res) {
  try {
    const db = getDbClient();
    await prepararEsquema(db);

    // ── PIN de gerencia ──
    // Vive aquí porque es gestión de PIN, aunque no sea de ningún empleado.
    if (req.query.recurso === 'pin-admin') {
      if (nivelDesdeReq(req) !== 'ADMIN') {
        return res.status(403).json({ error: "Solo gerencia" });
      }

      if (req.method === "GET") {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ configurado: await hayPinAdmin(db) });
      }

      if (req.method === "POST") {
        // Se genera aquí y se enseña una vez: igual que el de los empleados,
        // se guarda hasheado y después ya no hay forma de recuperarlo.
        let pin = null;
        for (let i = 0; i < 20 && !pin; i++) {
          const cand = String(crypto.randomInt(0, 10 ** PIN_DIGITOS)).padStart(PIN_DIGITOS, '0');
          // No puede chocar con el de nadie: si coincidiera, el mismo número
          // llevaría a dos sitios distintos.
          if (!(await pinYaEnUso(db, cand)) && !(await esPinAdmin(db, cand))) pin = cand;
        }
        if (!pin) return res.status(500).json({ error: "No se ha podido generar un PIN libre" });

        await guardarPinAdmin(db, pin);
        await auditar(db, req, { tipo_evento: 'PIN_GERENCIA_GENERADO', entidad: 'mantenimiento' }).catch(() => {});
        return res.status(200).json({ success: true, pin });
      }

      if (req.method === "DELETE") {
        await guardarPinAdmin(db, '');
        await auditar(db, req, { tipo_evento: 'PIN_GERENCIA_RETIRADO', entidad: 'mantenimiento' }).catch(() => {});
        return res.status(200).json({ success: true });
      }
    }

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
      // Dar de alta estaba abierto a cualquiera. Como la identidad de la gente
      // vive en esta tabla, no puede seguir así.
      if (!esEncargadoOSuperior(req)) {
        return res.status(403).json({ error: "No autorizado" });
      }
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
      if (!esEncargadoOSuperior(req)) {
        return res.status(403).json({ error: "No autorizado" });
      }
      const { nombre, centro, rol, pin, horario_habitual } = req.body;
      if (!nombre || !nombre.trim()) {
        return res.status(400).json({ error: "Nombre requerido" });
      }
      // Actualiza solo los campos presentes (para permitir cambiar rol sin tocar centro y viceversa)
      const sets = [];
      const args = [];
      if (typeof centro === 'string') { sets.push("centro = ?"); args.push(centro); }
      if (typeof rol === 'string')    { sets.push("rol = ?");    args.push(rol); }

      // El PIN lo genera el servidor y se enseña UNA vez: como se guarda
      // hasheado, después ya no hay forma de recuperarlo, solo de generar otro.
      let pinGenerado = null;
      if (pin !== undefined) {
        const limpio = String(pin).trim();

        if (limpio === '') {
          // Quitar el PIN cierra además todas sus sesiones, porque el hash
          // entra en la firma del testigo.
          sets.push("pin_hash = ?");
          args.push('');
        } else if (limpio === 'generar') {
          pinGenerado = await generarPin(db, nombre.trim());
          if (!pinGenerado) {
            return res.status(500).json({ error: "No se ha podido generar un PIN libre" });
          }
          sets.push("pin_hash = ?");
          args.push(hashPin(nombre.trim(), pinGenerado));
        } else if (!/^\d{4,8}$/.test(limpio)) {
          return res.status(422).json({ error: `El PIN debe tener ${PIN_DIGITOS} dígitos` });
        } else if (await pinYaEnUso(db, limpio, nombre.trim())) {
          return res.status(409).json({ error: "Ese PIN ya lo tiene otra persona. Prueba con otro." });
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

      if (pin !== undefined) {
        await auditar(db, req, {
          tipo_evento: pinGenerado ? 'PIN_GENERADO' : 'PIN_CAMBIADO',
          entidad: 'empleados', entidad_id: nombre.trim(), empleado: nombre.trim(),
        }).catch(() => {});
      }

      // El PIN viaja en la respuesta una sola vez, para poder enseñárselo.
      return res.status(200).json({ success: true, pin: pinGenerado || undefined });
    }
    else if (req.method === "DELETE") {
      // Igual que el alta: borrar un empleado estaba al alcance de cualquiera.
      if (!esEncargadoOSuperior(req)) {
        return res.status(403).json({ error: "No autorizado" });
      }
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
