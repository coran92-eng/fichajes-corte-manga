import { getDbClient } from "./_db.js";
import {
  initSchema, getCentroCfg, esRedAutorizada, ipDeReq, huellaRed, auditar,
} from "./_tareas-lib.js";

/** Contraseña de gerencia o de encargado, para autorizar excepciones. */
function claveResponsableValida(clave) {
  if (!clave) return false;
  const admin = process.env.ADMIN_PASSWORD || "123456";
  const encargado = process.env.ENCARGADO_PASSWORD || "123456";
  return clave === admin || clave === encargado;
}

// El esquema se prepara una vez por instancia, no en cada petición. Eran seis
// viajes a la base de datos —cuatro de ellos ALTER que fallan y se capturan—
// antes de tocar la consulta, y en la pantalla del panel eso bastaba para
// pasarse del tiempo de espera. Mismo arreglo que se hizo en horarios.js.
let esquemaListo = false;

async function prepararEsquema(db) {
  if (esquemaListo) return;

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

  try { await db.execute("ALTER TABLE fichajes ADD COLUMN centro TEXT NOT NULL DEFAULT ''"); } catch {}
  try { await db.execute("ALTER TABLE fichajes ADD COLUMN corregido INTEGER NOT NULL DEFAULT 0"); } catch {}

  // Hora prevista del fichaje: la que declara el empleado al entrar y la que
  // marca el horario al salir. Permite comparar lo previsto con lo fichado.
  try { await db.execute("ALTER TABLE fichajes ADD COLUMN hora_prevista TEXT NOT NULL DEFAULT ''"); } catch {}

  // Explicación cuando el fichaje no cuadra con el horario: salida más tarde
  // de la hora (la escribe el empleado) o salida anticipada autorizada.
  try { await db.execute("ALTER TABLE fichajes ADD COLUMN motivo TEXT NOT NULL DEFAULT ''"); } catch {}

  // Todas las pantallas leen por rango de fechas o por empleado; sin índice
  // cada consulta recorría la tabla entera.
  try { await db.execute("CREATE INDEX IF NOT EXISTS idx_fichajes_ts ON fichajes (timestamp)"); } catch {}
  try { await db.execute("CREATE INDEX IF NOT EXISTS idx_fichajes_emp_ts ON fichajes (empleado, timestamp)"); } catch {}

  esquemaListo = true;
}

export default async function handler(req, res) {
  try {
    const db = getDbClient();
    const t0 = Date.now();
    await prepararEsquema(db);
    const msEsquema = Date.now() - t0;

    if (req.method === "GET") {
      const { empleado, limit, centro, desde, hasta } = req.query;

      let conditions = [];
      let args = [];

      if (empleado) {
        conditions.push("empleado = ?");
        args.push(empleado);
      }
      if (centro) {
        conditions.push("(LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?)) OR TRIM(COALESCE(centro,'')) = '')");
        args.push(centro);
      }
      if (desde) {
        conditions.push("timestamp >= ?");
        args.push(parseInt(desde, 10));
      }
      if (hasta) {
        conditions.push("timestamp < ?");
        args.push(parseInt(hasta, 10));
      }

      let query = "SELECT * FROM fichajes";
      if (conditions.length) query += " WHERE " + conditions.join(" AND ");
      query += " ORDER BY timestamp DESC";

      // Techo siempre presente: sin él, una llamada sin filtros se traía la
      // tabla entera y crecía con el uso hasta colgar la pantalla. Va inline
      // porque ya es un entero acotado.
      const tope = Math.min(20000, Math.max(1, parseInt(limit, 10) || 5000));
      query += ` LIMIT ${tope}`;

      const result = await db.execute({ sql: query, args });
      res.setHeader('X-Ms-Esquema', String(msEsquema));
      res.setHeader('X-Ms-Total', String(Date.now() - t0));
      return res.status(200).json(result.rows);
    }
    else if (req.method === "POST") {
      const {
        empleado, tipo, fecha, hora, timestamp, centro = '', hora_prevista = '',
        password_responsable = '', motivo = '',
      } = req.body;

      if (!empleado || !tipo || !fecha || !hora || !timestamp) {
        return res.status(400).json({ error: "Faltan campos requeridos" });
      }

      // Solo se ficha desde la red del local (§7). Si el centro no tiene
      // ninguna red autorizada todavía, no se restringe nada: así configurarlo
      // es una decisión, no un requisito para que la app funcione.
      let fueraDeRed = false;
      if (centro) {
        await initSchema(db);
        const cfg = await getCentroCfg(db, centro);
        const red = esRedAutorizada(req, cfg);

        if (!red.permitido) {
          // Excepción con contraseña de responsable: si alguien tiene que
          // fichar desde fuera por un motivo real, ese tiempo debe quedar
          // registrado igualmente.
          if (!claveResponsableValida(password_responsable)) {
            return res.status(403).json({
              error: "Solo puedes fichar desde el local",
              motivo: "red",
            });
          }
          fueraDeRed = true;
        }
      }

      const result = await db.execute({
        sql: "INSERT INTO fichajes (empleado, tipo, fecha, hora, timestamp, centro, hora_prevista, motivo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [empleado, tipo, fecha, hora, timestamp, centro, hora_prevista, String(motivo || '').slice(0, 500)],
      });

      if (fueraDeRed) {
        await auditar(db, req, {
          tipo_evento: 'FICHAJE_FUERA_DE_RED', entidad: 'fichajes',
          entidad_id: result.lastInsertRowid?.toString(),
          empleado, centro,
          payload: { tipo, hora, red: huellaRed(ipDeReq(req)) },
        });
      }

      return res.status(201).json({
        success: true,
        id: result.lastInsertRowid.toString(),
        fuera_de_red: fueraDeRed,
      });
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
