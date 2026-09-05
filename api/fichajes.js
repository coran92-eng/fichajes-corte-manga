import { getDbClient } from "./_db.js";
import {
  initSchema, getCentroCfg, esRedAutorizada, ipDeReq, huellaRed, auditar,
  emitirTokenQr, validarTokenQr, hayQrConfigurado, exigirQr,
  idDispositivo, esEncargadoOSuperior, verificarPin,
} from "./_tareas-lib.js";
import { avisarTelegram, escTelegram } from "./_telegram.js";

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

  // Ventana del código del bar con el que se fichó. Sirve para impedir que un
  // mismo código valga dos veces a la misma persona.
  try { await db.execute("ALTER TABLE fichajes ADD COLUMN qr_ventana INTEGER"); } catch {}
  try { await db.execute("CREATE INDEX IF NOT EXISTS idx_fichajes_qr ON fichajes (empleado, qr_ventana)"); } catch {}

  // Aparato con el que se fichó (§ dispositivo compartido): si el mismo
  // aparato ficha como dos personas distintas, probablemente alguien le dejó
  // el móvil a un compañero. No identifica a nadie por sí solo —lo pone el
  // propio cliente—, pero sirve para que salte un aviso.
  try { await db.execute("ALTER TABLE fichajes ADD COLUMN device_id TEXT NOT NULL DEFAULT ''"); } catch {}

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

// Mismo margen que ya usan el móvil y el panel para decidir qué es "puntual":
// 5 min en la entrada, 15 en la salida (irse un poco más tarde es habitual;
// llegar tarde no debería serlo tanto).
const MARGEN_ENTRADA_MIN = 5;
const MARGEN_SALIDA_MIN = 15;

/**
 * Avisa por Telegram de cada entrada y salida, comparada con el horario
 * previsto de esa persona ese día — de dónde sale "quién llega tarde, quién
 * se va antes". No bloquea el fichaje si Telegram falla o si no hay horario
 * cargado: avisa igual, diciendo que no hay con qué comparar.
 */
async function avisarFichajeTelegram(db, { empleado, tipo, centro, timestamp, hora }) {
  if (tipo !== 'entrada' && tipo !== 'salida') return;

  try {
    const fecha = fechaJornada(Number(timestamp));
    let prevista = '';
    try {
      const r = await db.execute({
        sql: `SELECT hora_entrada, hora_salida FROM horarios
              WHERE empleado = ? AND fecha = ?
                AND (LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?)) OR TRIM(COALESCE(centro,'')) = '')
                AND LOWER(TRIM(COALESCE(estado,''))) <> 'rechazado'
              LIMIT 1`,
        args: [empleado, fecha, centro || ''],
      });
      if (r.rows.length) {
        const campo = tipo === 'entrada' ? 'hora_entrada' : 'hora_salida';
        prevista = String(r.rows[0][campo] || '').slice(0, 5);
      }
    } catch {}

    const horaReal = String(hora).slice(0, 5);
    const emoji = tipo === 'entrada' ? '🟢' : '🔵';
    const verbo = tipo === 'entrada' ? 'ha fichado su entrada' : 'ha fichado su salida';
    let texto = `${emoji} <b>${escTelegram(empleado)}</b> ${verbo} a las ${horaReal}`;

    if (!prevista) {
      texto += ' (sin horario cargado ese día, no se puede comparar).';
    } else {
      const diff = difMin(minutosDeHHMM(horaReal), minutosDeHHMM(prevista));
      const margen = tipo === 'entrada' ? MARGEN_ENTRADA_MIN : MARGEN_SALIDA_MIN;
      texto += ` (previsto ${prevista}) — `;
      if (diff === null) {
        texto += 'horario no válido para comparar.';
      } else if (Math.abs(diff) <= margen) {
        texto += tipo === 'entrada' ? 'puntual ✅' : 'a su hora ✅';
      } else if (diff > 0) {
        texto += tipo === 'entrada' ? `${diff} min tarde ⚠️` : `${diff} min más tarde de lo previsto ⚠️`;
      } else {
        texto += tipo === 'entrada' ? `${-diff} min antes de su hora` : `${-diff} min antes de lo previsto`;
      }
    }

    await avisarTelegram(texto);
  } catch {}
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
    sql: `SELECT empleado, tipo, hora, fecha, timestamp, motivo, device_id
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

  // Un mismo aparato fichando como dos personas: lo más probable es que
  // alguien le haya dejado el móvil a un compañero, o le haya pedido que
  // cerrara su sesión para fichar él. El iPad del bar queda fuera a
  // propósito: a ese sí lo usa todo el mundo, y no dice nada raro.
  let confiados = [];
  if (centro) {
    try {
      const cfg = await getCentroCfg(db, centro);
      confiados = String(cfg.dispositivos_confianza || '').split(',').map(x => x.trim()).filter(Boolean);
    } catch {}
  }
  const porDispositivo = {};
  for (const f of marcas.rows) {
    const dev = String(f.device_id || '').trim();
    if (!dev || confiados.includes(dev)) continue;
    const grupo = (porDispositivo[dev] ||= new Map());
    grupo.set(clave(f.empleado), f.empleado);
  }
  const dispositivosCompartidos = Object.entries(porDispositivo)
    .filter(([, personas]) => personas.size > 1)
    .map(([dispositivo, personas]) => ({ dispositivo, personas: [...personas.values()] }));

  return {
    dias, previsto_dia: previstoDia, motivos, marcas_leidas: marcas.rows.length,
    dispositivos_compartidos: dispositivosCompartidos,
  };
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
    // Código rotatorio que muestra el iPad del bar. Solo se entrega desde la
    // red del local o con sesión de encargado: si cualquiera pudiera pedirlo
    // desde casa, el código no probaría nada.
    if (req.method === "GET" && req.query.recurso === "qr") {
      const centro = req.query.centro || "";
      if (!centro) return res.status(400).json({ error: "Centro requerido" });
      if (!hayQrConfigurado()) {
        return res.status(503).json({ error: "El código del local no está configurado", motivo: "sin_qr" });
      }

      await initSchema(db);
      const cfg = await getCentroCfg(db, centro);
      const red = esRedAutorizada(req, cfg);
      if (!red.permitido && !esEncargadoOSuperior(req)) {
        return res.status(403).json({ error: "Este código solo se puede mostrar desde el local" });
      }

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(emitirTokenQr(centro));
    }

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
        password_responsable = '', motivo = '', qr = '', pin = '',
      } = req.body;

      if (!empleado || !tipo || !fecha || !hora || !timestamp) {
        return res.status(400).json({ error: "Faltan campos requeridos" });
      }

      // Solo se ficha desde la red del local (§7). Si el centro no tiene
      // ninguna red autorizada todavía, no se restringe nada: así configurarlo
      // es una decisión, no un requisito para que la app funcione.
      // Un fichaje sin centro no es válido: no se sabría a qué local pertenece,
      // y además se saltaría el código del bar, que va firmado por centro.
      if (!centro && hayQrConfigurado()) {
        return res.status(400).json({ error: "Falta el centro del fichaje" });
      }

      let fueraDeRed = false;
      let sinPinAutorizado = false;
      let ventanaQrUsada = null;

      if (centro) {
        await initSchema(db);
        const cfg = await getCentroCfg(db, centro);
        const red = esRedAutorizada(req, cfg);

        // Quién ficha: en el móvil lo dice la sesión del PIN, sin que haga
        // falta volver a teclearlo en cada fichaje. El iPad del bar no tiene
        // sesión propia —es una pantalla compartida—, así que sin PIN hace
        // falta que lo autorice un encargado: es lo que impide que un
        // compañero te fiche la entrada o la salida desde ahí. Un empleado
        // que todavía no tiene PIN asignado sigue sin bloquearse (§ modo
        // simple), igual que ya pasa al completar tareas.
        const sesionToken = req.body.sesion || req.headers['x-sesion'] || '';
        const identidad = await verificarPin(db, empleado, pin, sesionToken);
        if (!identidad.ok) {
          if (!claveResponsableValida(password_responsable)) {
            return res.status(403).json({
              error: "Ficha desde tu móvil. Si no lo tienes a mano, pide que te lo autorice un encargado.",
              motivo: "identidad",
            });
          }
          sinPinAutorizado = true;
        }

        // Desde un móvil hay que haber leído el código del iPad. El iPad del
        // propio bar está registrado como dispositivo de confianza y ficha
        // como siempre: no tiene sentido pedirle que lea su propia pantalla.
        // Y mientras no haya ningún aparato de confianza, no se exige nada:
        // nadie está enseñando el código todavía (ver `exigirQr`).
        if (exigirQr(req, cfg)) {
          const v = validarTokenQr(centro, qr);
          if (!v.ok) {
            return res.status(403).json({
              error: v.motivo === 'falta'
                ? "Para fichar desde el móvil, lee antes el código de la pantalla del bar"
                : "Ese código ya ha caducado. Vuelve a leer el de la pantalla del bar",
              motivo: "qr",
            });
          }

          // Un mismo código sirve a varias personas —entran juntas al cambio de
          // turno— pero no dos veces a la misma: así cada acción exige que
          // alguien esté delante del iPad en ese momento.
          const repe = await db.execute({
            sql: "SELECT 1 FROM fichajes WHERE empleado = ? AND qr_ventana = ? LIMIT 1",
            args: [empleado, v.ventana],
          });
          if (repe.rows.length) {
            return res.status(409).json({
              error: "Ya has usado este código. Pide uno nuevo en la pantalla del bar",
              motivo: "qr_repetido",
            });
          }
          ventanaQrUsada = v.ventana;
        }

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
        sql: "INSERT INTO fichajes (empleado, tipo, fecha, hora, timestamp, centro, hora_prevista, motivo, qr_ventana, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [empleado, tipo, fecha, hora, timestamp, centro, hora_prevista, String(motivo || '').slice(0, 500), ventanaQrUsada, idDispositivo(req)],
      });

      if (fueraDeRed) {
        await auditar(db, req, {
          tipo_evento: 'FICHAJE_FUERA_DE_RED', entidad: 'fichajes',
          entidad_id: result.lastInsertRowid?.toString(),
          empleado, centro,
          payload: { tipo, hora, red: huellaRed(ipDeReq(req)) },
        });
      }

      if (sinPinAutorizado) {
        await auditar(db, req, {
          tipo_evento: 'FICHAJE_SIN_PIN_AUTORIZADO', entidad: 'fichajes',
          entidad_id: result.lastInsertRowid?.toString(),
          empleado, centro, device_id: idDispositivo(req),
          payload: { tipo, hora },
        }).catch(() => {});
      }

      if (ventanaQrUsada !== null) {
        await auditar(db, req, {
          tipo_evento: 'FICHAJE_POR_QR', entidad: 'fichajes',
          entidad_id: result.lastInsertRowid?.toString(),
          empleado, centro, device_id: idDispositivo(req),
          payload: { tipo, hora, ventana: ventanaQrUsada },
        }).catch(() => {});
      }

      await avisarFichajeTelegram(db, { empleado, tipo, centro, timestamp, hora });

      return res.status(201).json({
        success: true,
        id: result.lastInsertRowid.toString(),
        fuera_de_red: fueraDeRed,
        sin_pin_autorizado: sinPinAutorizado,
        por_qr: ventanaQrUsada !== null,
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
