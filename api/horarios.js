import { getDbClient } from "./_db.js";
import { centroDeEmpleado, centroCanonico } from "./_tareas-lib.js";

// El esquema se prepara una vez por instancia, no en cada petición. Antes
// eran ocho viajes a la base de datos antes de la consulta —cuatro de ellos
// ALTER que fallan y se capturan— y las funciones de Vercel se cortan a los
// 10 s: la petición moría antes de responder y el usuario solo veía
// "Cargando...".
let esquemaListo = false;

async function prepararEsquema(db) {
  if (esquemaListo) return;

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

  try { await db.execute("CREATE INDEX IF NOT EXISTS idx_horarios_estado ON horarios (estado, fecha)"); } catch {}
  try { await db.execute("CREATE INDEX IF NOT EXISTS idx_horarios_centro_fecha ON horarios (centro, fecha)"); } catch {}
  try { await db.execute("CREATE INDEX IF NOT EXISTS idx_horarios_empleado_fecha ON horarios (empleado, fecha)"); } catch {}

  esquemaListo = true;
}

export default async function handler(req, res) {
  try {
    const db = getDbClient();
    const t0 = Date.now();
    await prepararEsquema(db);
    const msEsquema = Date.now() - t0;

    // Modo diagnóstico: dice cuánto ocupa la tabla y en qué se va el tiempo.
    // Sirve para no volver a suponer cuando una pantalla no carga.
    if (req.method === "GET" && req.query.diagnostico === '1') {
      const t1 = Date.now();
      const total = await db.execute("SELECT COUNT(*) AS n FROM horarios");
      const porEstado = await db.execute(
        "SELECT estado, COUNT(*) AS n FROM horarios GROUP BY estado"
      );
      const porCentro = await db.execute(
        "SELECT centro, COUNT(*) AS n FROM horarios GROUP BY centro"
      );
      return res.status(200).json({
        filas: Number(total.rows[0]?.n || 0),
        por_estado: porEstado.rows,
        por_centro: porCentro.rows,
        ms_esquema: msEsquema,
        ms_consultas: Date.now() - t1,
      });
    }

    if (req.method === "GET") {
      const {
        empleado, centro, semana, estado, fecha, fecha_desde, fecha_hasta,
        orden, limite, resumen,
      } = req.query;

      // Lista de semanas con cuántos turnos tiene cada una. Es lo que ve la
      // pantalla de validación al abrirse: se valida semana a semana, así que
      // no hay motivo para bajar todos los turnos de golpe.
      if (resumen === 'semanas') {
        const cond = [];
        const argsR = [];
        if (estado) { cond.push("estado = ?"); argsR.push(estado); }
        if (centro) { cond.push("LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?))"); argsR.push(centro); }

        const sql = `SELECT semana, centro, COUNT(*) AS turnos,
                            COUNT(DISTINCT empleado) AS personas,
                            MIN(fecha) AS desde, MAX(fecha) AS hasta
                     FROM horarios
                     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
                     GROUP BY semana, centro
                     ORDER BY semana DESC
                     LIMIT 40`;
        const r = await db.execute({ sql, args: argsR });
        res.setHeader('X-Ms-Total', String(Date.now() - t0));
        return res.status(200).json(r.rows);
      }

      let conditions = [];
      let args = [];

      if (empleado) {
        conditions.push("empleado = ?");
        args.push(empleado);
      }
      if (centro) {
        conditions.push("LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?))");
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

      // 'desc' sirve para pedir lo más reciente cuando hay mucho acumulado
      // (la pantalla de validación); el resto de llamadas siguen en orden de
      // agenda, que es como se leen.
      query += orden === 'desc'
        ? " ORDER BY fecha DESC, hora_entrada ASC"
        : " ORDER BY fecha ASC, hora_entrada ASC";

      // Techo siempre presente: una consulta sin límite acaba colgando la
      // pantalla en cuanto la tabla crece, y sin decir por qué. Va inline
      // (ya es un entero acotado) porque LIMIT con parámetro ligado ha dado
      // problemas en esta ruta.
      const tope = Math.min(3000, Math.max(1, parseInt(limite, 10) || 2000));
      query += ` LIMIT ${tope}`;

      const result = await db.execute({ sql: query, args });
      res.setHeader('X-Ms-Esquema', String(msEsquema));
      res.setHeader('X-Ms-Total', String(Date.now() - t0));
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

      // Cada fila de horario es de un empleado concreto, así que su ficha es
      // la fuente de verdad del centro (igual que en fichajes). Se resuelve
      // una sola vez y se reutiliza en el DELETE y en el INSERT siguientes:
      // si cada uno normalizara por su cuenta, uno podría comparar contra la
      // ficha y el otro guardar lo que mandó el cliente, y volveríamos a
      // dejar horarios duplicados o fantasma (el mismo fallo que tuvo esta
      // tabla antes).
      const centroResuelto = await centroDeEmpleado(db, empleado, centro);

      // Sin normalizar centro, un turno reenviado con el centro escrito de
      // otra forma no borraría el anterior: se quedarían los dos, y cuál
      // "gana" en las pantallas que lo muestran depende del orden de lectura.
      await db.execute({
        sql: `DELETE FROM horarios WHERE empleado = ? AND fecha = ?
              AND LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?))`,
        args: [empleado, fecha, centroResuelto],
      });

      const result = await db.execute({
        sql: "INSERT INTO horarios (empleado, centro, fecha, hora_entrada, hora_salida, semana, estado, creado_en, notas, rol_primera, hora_cambio, rol_segunda, hora_descanso) VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?, ?)",
        args: [empleado, centroResuelto, fecha, hora_entrada, hora_salida, semana, Date.now(), notas, rol_primera, hora_cambio, rol_segunda, hora_descanso],
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
        // Sin normalizar el centro, validar la semana entera no tocaba ni una
        // fila si el centro venía escrito de otra forma —y devolvía success
        // igual, así que el cuadrante se quedaba sin validar sin que nadie se
        // enterara—. Se devuelve cuántas filas se han cambiado por lo mismo:
        // un cero es la señal de que algo no cuadra.
        const r = await db.execute({
          sql: `UPDATE horarios SET estado = ?
                WHERE semana = ? AND LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?))`,
          args: [estado, semana, centro || ''],
        });
        return res.status(200).json({ success: true, filas: Number(r.rowsAffected || 0) });
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
