import { getDbClient } from "./db.js";
import { initSchema, getCentroCfg, epochDesdeLocal, auditar } from "./_tareas-lib.js";

/** La traza no debe tumbar un arreglo que ya se ha aplicado. */
async function auditarSuave(db, req, datos) {
  try { await auditar(db, req, datos); } catch {}
}

/**
 * Arreglos de datos que antes había que hacer a mano en la base.
 *
 * Los dos casos reales: alguien se va sin fichar la salida y se queda
 * "trabajando" para siempre, y un empleado que se da de alta otra vez con el
 * nombre escrito de otra forma, lo que parte su historial en dos personas.
 * Borrar el fichaje o el empleado resuelve la pantalla pero pierde las horas,
 * así que aquí se cierra el turno con su hora real y se fusiona el nombre.
 */

/** Todas las tablas donde el nombre de una persona viaja como texto. */
const COLUMNAS_CON_NOMBRE = [
  ['fichajes', 'empleado'],
  ['horarios', 'empleado'],
  ['solicitudes', 'empleado'],
  ['turno_notas', 'autor'],
  ['turno_notas', 'resuelto_por'],
  ['turno_notas_vistos', 'empleado'],
  ['tarea_instancias', 'completada_por'],
  ['evento_auditoria', 'empleado'],
];

/** Turnos abiertos: la última marca de la persona no es una salida. */
async function turnosAbiertos(db, centro) {
  // Se mira solo la última semana: un turno "abierto" de hace un mes es un
  // registro olvidado, no alguien que siga dentro.
  const desde = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const cond = ["timestamp >= ?"];
  const args = [desde];
  if (centro) {
    cond.push("(LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?)) OR TRIM(COALESCE(centro,'')) = '')");
    args.push(centro);
  }

  const r = await db.execute({
    sql: `SELECT empleado, tipo, fecha, hora, timestamp, centro FROM fichajes
          WHERE ${cond.join(' AND ')} ORDER BY timestamp DESC`,
    args,
  });

  const porEmpleado = {};
  for (const f of r.rows) (porEmpleado[f.empleado] ||= []).push(f);

  const abiertos = [];
  for (const [empleado, registros] of Object.entries(porEmpleado)) {
    if (registros[0].tipo === 'salida') continue;
    const entrada = registros.find(f => f.tipo === 'entrada');
    if (!entrada) continue;
    abiertos.push({
      empleado,
      centro: entrada.centro || '',
      fecha: entrada.fecha,
      hora: entrada.hora,
      timestamp: Number(entrada.timestamp),
      horas_abierto: Math.round((Date.now() - Number(entrada.timestamp)) / 3600000),
      ultimo_tipo: registros[0].tipo,
    });
  }

  abiertos.sort((a, b) => a.timestamp - b.timestamp);
  return abiertos;
}

export default async function handler(req, res) {
  try {
    const db = getDbClient();
    await initSchema(db);
    // La columna la crea normalmente /api/fichajes; aquí se asegura por si
    // este endpoint es el primero en tocar la base tras un despliegue.
    try { await db.execute("ALTER TABLE fichajes ADD COLUMN motivo TEXT NOT NULL DEFAULT ''"); } catch {}

    const accion = req.query?.accion || req.body?.accion || '';

    if (req.method === 'GET' && accion === 'turnos-abiertos') {
      return res.status(200).json(await turnosAbiertos(db, req.query.centro || ''));
    }

    if (req.method === 'POST' && accion === 'cerrar-turno') {
      const { empleado, centro = '', fecha, hora } = req.body || {};
      if (!empleado || !/^\d{4}-\d{2}-\d{2}$/.test(fecha || '') || !/^\d{2}:\d{2}/.test(hora || '')) {
        return res.status(400).json({ error: "Faltan empleado, fecha (YYYY-MM-DD) u hora (HH:MM)" });
      }

      const abiertos = await turnosAbiertos(db, centro);
      const turno = abiertos.find(t => t.empleado === empleado);
      if (!turno) {
        return res.status(404).json({ error: "Esa persona no tiene ningún turno abierto" });
      }

      const cfg = await getCentroCfg(db, centro || turno.centro);
      const hhmm = String(hora).slice(0, 5);
      const ts = epochDesdeLocal(fecha, hhmm, cfg.zona_horaria);

      if (ts <= turno.timestamp) {
        return res.status(400).json({
          error: `La salida debe ser posterior a la entrada (${turno.fecha} ${String(turno.hora).slice(0, 5)})`,
        });
      }
      if (ts > Date.now() + 60000) {
        return res.status(400).json({ error: "La salida no puede estar en el futuro" });
      }

      // corregido = 1 deja claro que no lo fichó la persona, lo arregló gerencia.
      const r = await db.execute({
        sql: `INSERT INTO fichajes (empleado, tipo, fecha, hora, timestamp, centro, corregido, motivo)
              VALUES (?, 'salida', ?, ?, ?, ?, 1, ?)`,
        args: [
          empleado, fecha, `${hhmm}:00`, ts, centro || turno.centro,
          'Salida añadida por gerencia: se cerró un turno que quedó sin fichar.',
        ],
      });

      await auditarSuave(db, req, {
        tipo_evento: 'TURNO_CERRADO_A_MANO', entidad: 'fichajes',
        entidad_id: r.lastInsertRowid?.toString(),
        empleado, centro: centro || turno.centro,
        payload: { entrada: `${turno.fecha} ${turno.hora}`, salida: `${fecha} ${hhmm}` },
      });

      return res.status(201).json({ success: true });
    }

    if (req.method === 'POST' && accion === 'renombrar') {
      const origen = String(req.body?.origen || '').trim();
      const destino = String(req.body?.destino || '').trim();
      if (!origen || !destino) {
        return res.status(400).json({ error: "Faltan el nombre actual y el nuevo" });
      }
      if (origen === destino) {
        return res.status(400).json({ error: "Los dos nombres son el mismo" });
      }

      // El destino debe existir ya como empleado: así el nombre bueno es
      // siempre uno dado de alta, no una errata que se propaga a todo.
      const dest = await db.execute({
        sql: "SELECT nombre FROM empleados WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))",
        args: [destino],
      });
      if (!dest.rows.length) {
        return res.status(400).json({ error: `"${destino}" no está dado de alta como empleado` });
      }
      const nombreBueno = dest.rows[0].nombre;

      const movidos = {};
      for (const [tabla, columna] of COLUMNAS_CON_NOMBRE) {
        try {
          const r = await db.execute({
            sql: `UPDATE ${tabla} SET ${columna} = ? WHERE TRIM(${columna}) = TRIM(?)`,
            args: [nombreBueno, origen],
          });
          const n = Number(r.rowsAffected || 0);
          if (n) movidos[`${tabla}.${columna}`] = n;
        } catch {
          // Una tabla que aún no existe en esta base no debe cortar la fusión.
        }
      }

      // Si el nombre viejo seguía dado de alta, se retira: ya está fusionado.
      try {
        await db.execute({
          sql: "DELETE FROM empleados WHERE TRIM(nombre) = TRIM(?)",
          args: [origen],
        });
      } catch {}

      await auditarSuave(db, req, {
        tipo_evento: 'EMPLEADO_FUSIONADO', entidad: 'empleados',
        empleado: nombreBueno, centro: req.body?.centro || '',
        payload: { origen, destino: nombreBueno, movidos },
      });

      const total = Object.values(movidos).reduce((a, b) => a + b, 0);
      return res.status(200).json({ success: true, destino: nombreBueno, total, movidos });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}
