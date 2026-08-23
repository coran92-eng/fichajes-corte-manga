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

const CORTE_JORNADA = 7;   // la jornada del bar va de 07:00 a 07:00
const DIA_MS = 24 * 60 * 60 * 1000;

const dosCifras = n => String(n).padStart(2, '0');
const minutosDeHHMM = h => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(h || '').trim());
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return a > 23 || b > 59 ? null : a * 60 + b;
};
/** Diferencia en minutos resuelta por el lado más cercano del reloj. */
const difMin = (a, b) => {
  if (a === null || b === null) return null;
  let d = a - b;
  if (d > 720) d -= 1440;
  if (d < -720) d += 1440;
  return d;
};

/**
 * Fecha de la jornada a la que pertenece un instante. Se calcula sobre la hora
 * local de Madrid, no la del servidor, que en Vercel va en UTC.
 */
function fechaJornada(ts) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date(ts));
  const de = t => p.find(x => x.type === t)?.value || '';
  const hora = Number(de('hour'));
  const natural = `${de('year')}-${de('month')}-${de('day')}`;
  if (hora >= CORTE_JORNADA) return natural;
  const d = new Date(`${natural}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${dosCifras(d.getUTCMonth() + 1)}-${dosCifras(d.getUTCDate())}`;
}

/** Qué hizo una persona en su jornada, a partir de sus marcas en orden. */
function jornadaDe(nombre, eventos, prev) {
  let entradaTs = null, descansoIni = null, restar = 0, minutos = 0;
  const descansos = [];
  let entrada = null, salida = null;

  for (const f of eventos) {
    const ts = Number(f.timestamp);
    if (f.tipo === 'entrada') {
      if (!entrada) entrada = f;
      entradaTs = ts; descansoIni = null; restar = 0;
    } else if (f.tipo === 'inicio_descanso') {
      if (entradaTs !== null) descansoIni = f;
    } else if (f.tipo === 'fin_descanso') {
      if (descansoIni) {
        const min = Math.round((ts - Number(descansoIni.timestamp)) / 60000);
        restar += ts - Number(descansoIni.timestamp);
        descansos.push({ ini: String(descansoIni.hora).slice(0, 5), fin: String(f.hora).slice(0, 5), min });
        descansoIni = null;
      }
    } else if (f.tipo === 'salida') {
      salida = f;
      if (entradaTs !== null) {
        if (descansoIni) { restar += ts - Number(descansoIni.timestamp); descansoIni = null; }
        minutos += Math.max(0, (ts - entradaTs - restar) / 60000);
      }
      entradaTs = null; restar = 0;
    }
  }

  const hEnt = entrada ? String(entrada.hora).slice(0, 5) : null;
  const hSal = salida ? String(salida.hora).slice(0, 5) : null;

  return {
    nombre,
    entrada: hEnt, salida: hSal,
    prevEntrada: prev?.hora_entrada ? String(prev.hora_entrada).slice(0, 5) : null,
    prevSalida: prev?.hora_salida ? String(prev.hora_salida).slice(0, 5) : null,
    difEnt: hEnt && prev?.hora_entrada ? difMin(minutosDeHHMM(hEnt), minutosDeHHMM(prev.hora_entrada)) : null,
    difSal: hSal && prev?.hora_salida ? difMin(minutosDeHHMM(hSal), minutosDeHHMM(prev.hora_salida)) : null,
    minutos: Math.round(minutos),
    // Un turno sin cerrar no suma horas: inventarle una salida las falsearía.
    abierto: entradaTs !== null,
    descansos,
    descansoMin: descansos.reduce((a, d) => a + d.min, 0),
    descansoAbierto: !!descansoIni,
  };
}

/** Todo lo que el panel necesita, ya cruzado y en unos pocos KB. */
async function resumenPanel(db, { centro, desde, hasta }) {
  const cond = ["timestamp >= ?", "timestamp < ?"];
  const args = [desde, hasta];
  if (centro) {
    cond.push("(LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?)) OR TRIM(COALESCE(centro,'')) = '')");
    args.push(centro);
  }

  // Solo las columnas que se usan: 'motivo' puede traer texto largo y no hace
  // falta más que en las salidas.
  const marcas = await db.execute({
    sql: `SELECT empleado, tipo, hora, fecha, timestamp, motivo
          FROM fichajes WHERE ${cond.join(' AND ')}
          ORDER BY timestamp ASC LIMIT 8000`,
    args,
  });

  const fDesde = fechaJornada(desde);
  const fHasta = fechaJornada(hasta);
  let cuadrante = { rows: [] };
  try {
    cuadrante = await db.execute({
      sql: `SELECT empleado, fecha, hora_entrada, hora_salida FROM horarios
            WHERE fecha >= ? AND fecha <= ? AND centro = ?
              AND LOWER(TRIM(COALESCE(estado,''))) <> 'rechazado'
            LIMIT 3000`,
      args: [fDesde, fHasta, centro || ''],
    });
  } catch {}

  const clave = n => String(n || '').trim().toUpperCase();
  const prevDe = {};
  for (const h of cuadrante.rows) prevDe[`${h.fecha}|${clave(h.empleado)}`] = h;

  const porDia = {};
  for (const f of marcas.rows) {
    const fecha = fechaJornada(Number(f.timestamp));
    (porDia[fecha] ||= {});
    (porDia[fecha][clave(f.empleado)] ||= { nombre: f.empleado, ev: [] }).ev.push(f);
  }

  const dias = Object.entries(porDia)
    .map(([fecha, gente]) => ({
      fecha,
      personas: Object.entries(gente)
        .map(([k, p]) => jornadaDe(p.nombre, p.ev, prevDe[`${fecha}|${k}`]))
        .sort((a, b) => String(a.entrada || '99').localeCompare(String(b.entrada || '99'))),
    }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  // Horas previstas por día, incluyendo a quien estaba puesto y no fichó.
  const previstoDia = {};
  for (const h of cuadrante.rows) {
    const ini = minutosDeHHMM(h.hora_entrada), fin = minutosDeHHMM(h.hora_salida);
    if (ini === null || fin === null) continue;
    previstoDia[h.fecha] = (previstoDia[h.fecha] || 0) + ((fin <= ini ? fin + 1440 : fin) - ini);
  }

  // Entradas y salidas con explicación: es lo que hay que leer, y ya no se
  // publica en el parte del turno que ve todo el equipo.
  const motivos = marcas.rows
    .filter(f => (f.tipo === 'salida' || f.tipo === 'entrada') && String(f.motivo || '').trim())
    .slice(-8).reverse()
    .map(f => ({ empleado: f.empleado, fecha: f.fecha, tipo: f.tipo, motivo: String(f.motivo).slice(0, 300) }));

  return { dias, previsto_dia: previstoDia, motivos, marcas_leidas: marcas.rows.length };
}

export default async function handler(req, res) {
  try {
    const db = getDbClient();
    const t0 = Date.now();
    await prepararEsquema(db);
    const msEsquema = Date.now() - t0;

    // Resumen para el panel de gerencia. Antes se mandaban al navegador
    // varios miles de filas para que las cruzara allí: una fila responde en
    // 185 ms y varios miles no responden. Aquí se leen las columnas justas, se
    // cruza con el cuadrante y se devuelven unos pocos KB ya masticados.
    if (req.method === "GET" && req.query.resumen === "panel") {
      const centro = req.query.centro || "";
      const desde = parseInt(req.query.desde, 10) || 0;
      const hasta = parseInt(req.query.hasta, 10) || Date.now();

      const salida = await resumenPanel(db, { centro, desde, hasta });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Ms-Total', String(Date.now() - t0));
      return res.status(200).json({ ...salida, ms_esquema: msEsquema });
    }

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
