import crypto from "node:crypto";
import { avisarTelegram, escTelegram, conEnlacePanel } from "./_telegram.js";

// ── Constantes de dominio ─────────────────────────────────────
export const BLOQUES = ['APERTURA', 'DURANTE_SERVICIO', 'CAMBIO_TURNO', 'CIERRE', 'SEMANAL', 'MENSUAL'];
export const ROLES = ['SALA', 'COCINA', 'BARRA', 'ENCARGADO', 'LIMPIEZA'];
export const TIPOS_EVIDENCIA = ['CHECK', 'FOTO', 'NUMERO', 'TEXTO', 'FOTO+NUMERO'];
export const CRITICIDADES = ['BLOQUEANTE', 'NORMAL', 'OPCIONAL'];
export const ESTADOS = ['PENDIENTE', 'COMPLETADA', 'COMPLETADA_TARDIA', 'NO_APLICA', 'VENCIDA'];

export const TZ_DEFAULT = 'Europe/Madrid';
export const INICIO_JORNADA_DEFAULT = '07:00';

// Detección de ráfaga (§8.3): N tareas en menos de M minutos.
export const RAFAGA_N = 4;
export const RAFAGA_MIN = 3;

// Fotos duplicadas: se compara el hash contra las últimas N de la misma plantilla.
export const HASH_LOOKBACK = 30;

// ── Cierre de caja (§ api/caja.js) ─────────────────────────────
// Los 15 tramos fijos de billetes y monedas en euros, en el orden en que se
// enseñan y se piden — igual que en la app de la que viene esto (cierrecaja).
export const DENOMINACIONES = [
  { clave: 'b500', valor: 500 }, { clave: 'b200', valor: 200 }, { clave: 'b100', valor: 100 },
  { clave: 'b50', valor: 50 }, { clave: 'b20', valor: 20 }, { clave: 'b10', valor: 10 }, { clave: 'b5', valor: 5 },
  { clave: 'c200', valor: 2 }, { clave: 'c100', valor: 1 }, { clave: 'c050', valor: 0.5 },
  { clave: 'c020', valor: 0.2 }, { clave: 'c010', valor: 0.1 }, { clave: 'c005', valor: 0.05 },
  { clave: 'c002', valor: 0.02 }, { clave: 'c001', valor: 0.01 },
];

export function desgloseVacio() {
  const d = {};
  for (const { clave } of DENOMINACIONES) d[clave] = 0;
  return d;
}

/** Suma el valor de un desglose {clave: cantidad}. Cantidades negativas o no numéricas cuentan como 0. */
export function totalDesglose(desglose) {
  if (!desglose) return 0;
  let total = 0;
  for (const { clave, valor } of DENOMINACIONES) {
    const n = Number(desglose[clave]);
    total += (Number.isFinite(n) && n > 0 ? n : 0) * valor;
  }
  return Math.round(total * 100) / 100;
}

/** verde: cuadra a 0 en los dos. naranja: dentro de margen. rojo: fuera de margen en cualquiera de los dos. */
export function semaforoCaja(difEfectivo, difTarjeta) {
  const absEf = Math.abs(difEfectivo);
  const absTa = Math.abs(difTarjeta);
  if (absEf === 0 && absTa === 0) return 'verde';
  if (absEf <= 10 && absTa <= 5) return 'naranja';
  return 'rojo';
}

// ── Esquema ───────────────────────────────────────────────────
// Las sentencias son idempotentes, pero ejecutarlas en cada petición añade
// latencia al fichaje. Se hacen una vez por instancia (Vercel reutiliza la
// lambda en caliente; un despliegue nuevo vuelve a ejecutarlas).
let schemaListo = false;

export async function initSchema(db) {
  if (schemaListo) return;
  await db.execute(`
    CREATE TABLE IF NOT EXISTS centros_cfg (
      centro TEXT PRIMARY KEY,
      inicio_jornada TEXT NOT NULL DEFAULT '07:00',
      zona_horaria TEXT NOT NULL DEFAULT 'Europe/Madrid'
    )
  `);

  // Redes desde las que se permite fichar (separadas por comas). Vacío = sin
  // restricción, para que un centro recién creado no deje a nadie fuera.
  try { await db.execute("ALTER TABLE centros_cfg ADD COLUMN ips_autorizadas TEXT NOT NULL DEFAULT ''"); } catch {}
  // Dispositivos exentos de leer el QR: el iPad del propio bar.
  try { await db.execute("ALTER TABLE centros_cfg ADD COLUMN dispositivos_confianza TEXT NOT NULL DEFAULT ''"); } catch {}
  // Coordenadas del local, para fichar por Telegram compartiendo ubicación.
  // Vacío ('') = esa vía no está activada para este centro — no hay valor por
  // defecto que tenga sentido, hay que ponerlo a propósito.
  try { await db.execute("ALTER TABLE centros_cfg ADD COLUMN ubicacion_lat TEXT NOT NULL DEFAULT ''"); } catch {}
  try { await db.execute("ALTER TABLE centros_cfg ADD COLUMN ubicacion_lng TEXT NOT NULL DEFAULT ''"); } catch {}
  try { await db.execute("ALTER TABLE centros_cfg ADD COLUMN radio_fichaje_m INTEGER NOT NULL DEFAULT 150"); } catch {}

  // Catálogo. Editar crea una versión nueva: nunca se modifica en caliente (§4.2).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tarea_plantillas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      familia_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      centro TEXT NOT NULL DEFAULT '',
      nombre TEXT NOT NULL,
      instrucciones TEXT NOT NULL DEFAULT '',
      bloque TEXT NOT NULL,
      rol_responsable TEXT NOT NULL,
      ventana_inicio TEXT NOT NULL,
      ventana_fin TEXT NOT NULL,
      tolerancia_min INTEGER NOT NULL DEFAULT 30,
      tipo_evidencia TEXT NOT NULL DEFAULT 'CHECK',
      evidencia_config TEXT NOT NULL DEFAULT '',
      criticidad TEXT NOT NULL DEFAULT 'NORMAL',
      recurrencia TEXT NOT NULL DEFAULT '{"tipo":"diaria"}',
      orden INTEGER NOT NULL DEFAULT 0,
      activa INTEGER NOT NULL DEFAULT 1,
      vigente_desde TEXT NOT NULL DEFAULT '',
      vigente_hasta TEXT NOT NULL DEFAULT '',
      creado_en INTEGER NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS tarea_instancias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plantilla_version_id INTEGER NOT NULL,
      familia_id TEXT NOT NULL,
      centro TEXT NOT NULL DEFAULT '',
      fecha_operativa TEXT NOT NULL,
      ventana_inicio_ts INTEGER NOT NULL,
      ventana_fin_ts INTEGER NOT NULL,
      tolerancia_min INTEGER NOT NULL DEFAULT 30,
      estado TEXT NOT NULL DEFAULT 'PENDIENTE',
      rol_responsable TEXT NOT NULL DEFAULT '',
      completada_por TEXT NOT NULL DEFAULT '',
      completada_ts_servidor INTEGER,
      completada_ts_cliente INTEGER,
      fuera_de_plazo INTEGER NOT NULL DEFAULT 0,
      flag_rafaga INTEGER NOT NULL DEFAULT 0,
      sincronizada_offline INTEGER NOT NULL DEFAULT 0,
      evidencia_id INTEGER,
      nota TEXT NOT NULL DEFAULT '',
      motivo_no_aplica TEXT NOT NULL DEFAULT '',
      origen TEXT NOT NULL DEFAULT 'RECURRENTE',
      idempotency_key TEXT NOT NULL DEFAULT '',
      creado_en INTEGER NOT NULL
    )
  `);

  // Evita duplicados si la generación corre dos veces (§4.3 / §5).
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_instancia_unica
    ON tarea_instancias (plantilla_version_id, fecha_operativa)
    WHERE origen = 'RECURRENTE'
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_instancia_centro_fecha
    ON tarea_instancias (centro, fecha_operativa)
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS evidencias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarea_instancia_id INTEGER,
      familia_id TEXT NOT NULL DEFAULT '',
      tipo TEXT NOT NULL,
      valor_numerico REAL,
      unidad TEXT NOT NULL DEFAULT '',
      texto TEXT NOT NULL DEFAULT '',
      archivo_b64 TEXT,
      mime TEXT NOT NULL DEFAULT '',
      hash_sha256 TEXT NOT NULL DEFAULT '',
      origen_captura TEXT NOT NULL DEFAULT '',
      sospechosa INTEGER NOT NULL DEFAULT 0,
      device_id TEXT NOT NULL DEFAULT '',
      ts_servidor INTEGER NOT NULL,
      metadatos TEXT NOT NULL DEFAULT ''
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_evidencia_hash ON evidencias (familia_id, hash_sha256)`);
  // Para listar las fotos de un centro sin recorrer toda la tabla (§ panel).
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_evidencia_instancia ON evidencias (tarea_instancia_id)`);

  // Append-only: sin UPDATE ni DELETE desde la aplicación (§4.7).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS evento_auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo_evento TEXT NOT NULL,
      entidad TEXT NOT NULL DEFAULT '',
      entidad_id TEXT NOT NULL DEFAULT '',
      empleado TEXT NOT NULL DEFAULT '',
      centro TEXT NOT NULL DEFAULT '',
      ts_servidor INTEGER NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      device_id TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT ''
    )
  `);

  // El tope de intentos de PIN es la primera consulta que lee esta tabla. Sin
  // índice sería un recorrido completo de algo que solo crece.
  try { await db.execute("CREATE INDEX IF NOT EXISTS idx_auditoria_ip ON evento_auditoria (tipo_evento, ip, ts_servidor)"); } catch {}
  try { await db.execute("CREATE INDEX IF NOT EXISTS idx_auditoria_dev ON evento_auditoria (tipo_evento, device_id, ts_servidor)"); } catch {}

  // PIN por empleado para autorizar acciones en tablet compartida (§7).
  try { await db.execute("ALTER TABLE empleados ADD COLUMN pin_hash TEXT NOT NULL DEFAULT ''"); } catch {}
  // Chat de Telegram vinculado (bot de empleados): un chat es de una persona,
  // así que el índice es único, pero solo entre los que sí están vinculados
  // —si fuera único sobre la columna entera, todos los que valen '' chocarían
  // entre sí—.
  try { await db.execute("ALTER TABLE empleados ADD COLUMN telegram_chat_id TEXT NOT NULL DEFAULT ''"); } catch {}
  try {
    await db.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_empleados_telegram ON empleados (telegram_chat_id) WHERE telegram_chat_id <> ''"
    );
  } catch {}

  await db.execute(`
    CREATE TABLE IF NOT EXISTS mantenimiento (
      clave TEXT PRIMARY KEY,
      ts INTEGER NOT NULL
    )
  `);
  // Pasa a guardar también un valor: hoy solo el PIN de gerencia, que no
  // pertenece a ningún centro ni a la lista de empleados.
  try { await db.execute("ALTER TABLE mantenimiento ADD COLUMN valor TEXT NOT NULL DEFAULT ''"); } catch {}

  // Cierre de caja — migrado de la app aparte "cierrecaja" (React+Supabase),
  // que queda fuera. Un turno de caja (apertura + cierre) por centro+turno+
  // fecha; el desglose de billetes/monedas viaja como JSON en TEXT (mismo
  // criterio que evidencia_config/payload en otras tablas), sin CHECK en la
  // definición (en todo este proyecto se valida en el código de la API, no
  // en el esquema — ver api/caja.js).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS caja_turnos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      centro TEXT NOT NULL DEFAULT '',
      turno TEXT NOT NULL,
      fecha TEXT NOT NULL,
      empleado TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendiente',

      apertura_fondo_heredado REAL,
      apertura_fondo_editable INTEGER NOT NULL DEFAULT 0,
      apertura_desglose TEXT,
      apertura_total_contado REAL,
      apertura_diferencia REAL,
      apertura_confirmada_en INTEGER,

      cierre_desglose TEXT,
      cierre_total_caja REAL,
      cierre_fondo_definido REAL,
      cierre_efectivo_neto REAL,
      cierre_tpv_efectivo REAL,
      cierre_tpv_tarjeta REAL,
      cierre_tpv_voids REAL,
      cierre_num_tickets INTEGER,
      cierre_dif_efectivo REAL,
      cierre_dif_tarjeta REAL,
      cierre_semaforo TEXT,
      cierre_confirmado_en INTEGER,

      creado_en INTEGER NOT NULL,
      actualizado_en INTEGER NOT NULL
    )
  `);
  try {
    await db.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_caja_turnos_unico ON caja_turnos (centro, turno, fecha)"
    );
  } catch {}
  try { await db.execute("CREATE INDEX IF NOT EXISTS idx_caja_turnos_centro_fecha ON caja_turnos (centro, fecha)"); } catch {}

  // Datáfonos de un cierre: se borran todos y se reinsertan en cada guardado
  // (igual que hacía cierrecaja), nunca un upsert fila a fila.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS caja_datafonos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turno_id INTEGER NOT NULL,
      nombre TEXT NOT NULL,
      importe REAL NOT NULL,
      orden INTEGER
    )
  `);
  try { await db.execute("CREATE INDEX IF NOT EXISTS idx_caja_datafonos_turno ON caja_datafonos (turno_id)"); } catch {}

  // Log de reaperturas. "nivel" (ADMIN/ENCARGADO) en vez de un usuario
  // concreto: aquí gerencia no tiene cuentas por persona, a diferencia de
  // cierrecaja — es una pérdida de detalle asumida a propósito.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS caja_reaperturas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turno_id INTEGER NOT NULL,
      motivo TEXT NOT NULL,
      nivel TEXT NOT NULL,
      creado_en INTEGER NOT NULL
    )
  `);
  try { await db.execute("CREATE INDEX IF NOT EXISTS idx_caja_reaperturas_turno ON caja_reaperturas (turno_id)"); } catch {}

  schemaListo = true;
}

// ── Retención (§11.5) ─────────────────────────────────────────
export const RETENCION_FOTOS_DIAS = 90;

/**
 * Purga las imágenes de más de 90 días conservando los metadatos del registro
 * (hash, hora, quién): lo que exige la normativa es el registro, no la foto.
 * Se ejecuta como mucho una vez al día, aprovechando cualquier consulta.
 */
export async function purgarFotosCaducadas(db) {
  const ahora = Date.now();
  const ultima = await db.execute({
    sql: "SELECT ts FROM mantenimiento WHERE clave = 'purga_fotos'",
    args: [],
  });
  if (ultima.rows.length && ahora - Number(ultima.rows[0].ts) < 24 * 60 * 60 * 1000) return 0;

  const limite = ahora - RETENCION_FOTOS_DIAS * 24 * 60 * 60 * 1000;
  const r = await db.execute({
    sql: `UPDATE evidencias SET archivo_b64 = NULL
          WHERE archivo_b64 IS NOT NULL AND ts_servidor < ?`,
    args: [limite],
  });

  await db.execute({
    sql: `INSERT INTO mantenimiento (clave, ts) VALUES ('purga_fotos', ?)
          ON CONFLICT(clave) DO UPDATE SET ts = excluded.ts`,
    args: [ahora],
  });
  return r.rowsAffected || 0;
}

// ── Jornada operativa (§3) ────────────────────────────────────

/** Partes de fecha/hora de un instante en una zona horaria concreta. */
export function partesEnZona(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(ts))) map[p.type] = p.value;
  return {
    year: +map.year, month: +map.month, day: +map.day,
    hour: (+map.hour) % 24, minute: +map.minute, second: +map.second,
  };
}

function offsetZonaMs(ts, tz) {
  const p = partesEnZona(ts, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ts;
}

/** Epoch ms correspondiente a una hora local (YYYY-MM-DD + HH:MM) en una zona. */
export function epochDesdeLocal(fecha, hora, tz = TZ_DEFAULT) {
  const [Y, M, D] = String(fecha).split('-').map(Number);
  const [h, m] = String(hora).split(':').map(Number);
  const guess = Date.UTC(Y, M - 1, D, h || 0, m || 0, 0);
  let ts = guess - offsetZonaMs(guess, tz);
  ts = guess - offsetZonaMs(ts, tz); // segunda pasada: resuelve cambios de hora
  return ts;
}

export function minutosDeHora(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Minutos trabajados a partir de las marcas de UNA persona, en orden
 * cronológico. Usado tanto en el resumen semanal de aviso-diario.js como en
 * el /horas del bot de empleados — es el mismo cálculo, no tiene sentido
 * tenerlo escrito dos veces.
 */
export function minutosTrabajados(eventos) {
  let entradaTs = null, descansoIni = null, restar = 0, minutos = 0;
  for (const f of eventos) {
    const ts = Number(f.timestamp);
    if (f.tipo === 'entrada') {
      entradaTs = ts; descansoIni = null; restar = 0;
    } else if (f.tipo === 'inicio_descanso') {
      if (entradaTs !== null) descansoIni = ts;
    } else if (f.tipo === 'fin_descanso') {
      if (descansoIni !== null) { restar += ts - descansoIni; descansoIni = null; }
    } else if (f.tipo === 'salida') {
      if (entradaTs !== null) {
        if (descansoIni !== null) { restar += ts - descansoIni; descansoIni = null; }
        minutos += Math.max(0, (ts - entradaTs - restar) / 60000);
      }
      entradaTs = null; restar = 0;
    }
  }
  return minutos;
}

export function sumarDias(fecha, dias) {
  const [Y, M, D] = String(fecha).split('-').map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D));
  d.setUTCDate(d.getUTCDate() + dias);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Fecha operativa de un instante: si la hora local es anterior al inicio de
 * jornada, pertenece a la jornada del día anterior (§3).
 */
export function fechaOperativaDe(ts, cfg) {
  const p = partesEnZona(ts, cfg.zona_horaria);
  const natural = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  const min = p.hour * 60 + p.minute;
  return min >= minutosDeHora(cfg.inicio_jornada) ? natural : sumarDias(natural, -1);
}

/**
 * Resuelve la ventana de una tarea a instantes absolutos dentro de una jornada
 * operativa. Una hora anterior al inicio de jornada cae en el día natural
 * siguiente, así que 23:00→03:00 se resuelve correctamente.
 */
export function resolverVentana(fechaOperativa, horaInicio, horaFin, cfg) {
  const inicioJornada = minutosDeHora(cfg.inicio_jornada);
  const fechaDe = (hhmm) => minutosDeHora(hhmm) >= inicioJornada
    ? fechaOperativa
    : sumarDias(fechaOperativa, 1);

  const inicioTs = epochDesdeLocal(fechaDe(horaInicio), horaInicio, cfg.zona_horaria);
  let finTs = epochDesdeLocal(fechaDe(horaFin), horaFin, cfg.zona_horaria);
  if (finTs <= inicioTs) finTs += 24 * 60 * 60 * 1000; // seguridad ante ventanas raras
  return { inicioTs, finTs };
}

/** Configuración del centro (crea la fila por defecto la primera vez). */
export async function getCentroCfg(db, centro) {
  const r = await db.execute({
    sql: `SELECT centro, inicio_jornada, zona_horaria, ips_autorizadas, dispositivos_confianza,
                 ubicacion_lat, ubicacion_lng, radio_fichaje_m
          FROM centros_cfg WHERE LOWER(TRIM(centro)) = LOWER(TRIM(?))`,
    args: [centro || ''],
  });
  if (r.rows.length) {
    const row = r.rows[0];
    return {
      centro: row.centro,
      inicio_jornada: row.inicio_jornada || INICIO_JORNADA_DEFAULT,
      zona_horaria: row.zona_horaria || TZ_DEFAULT,
      ips_autorizadas: row.ips_autorizadas || '',
      dispositivos_confianza: row.dispositivos_confianza || '',
      ubicacion_lat: row.ubicacion_lat || '',
      ubicacion_lng: row.ubicacion_lng || '',
      radio_fichaje_m: Number(row.radio_fichaje_m) || 150,
    };
  }
  try {
    await db.execute({
      sql: "INSERT INTO centros_cfg (centro, inicio_jornada, zona_horaria) VALUES (?, ?, ?)",
      args: [centro || '', INICIO_JORNADA_DEFAULT, TZ_DEFAULT],
    });
  } catch {}
  return {
    centro: centro || '', inicio_jornada: INICIO_JORNADA_DEFAULT,
    zona_horaria: TZ_DEFAULT, ips_autorizadas: '', dispositivos_confianza: '',
    ubicacion_lat: '', ubicacion_lng: '', radio_fichaje_m: 150,
  };
}

/** ¿Tiene este centro configurada su ubicación, para poder fichar por Telegram? */
export function hayUbicacionConfigurada(cfg) {
  return !!(cfg?.ubicacion_lat && cfg?.ubicacion_lng);
}

/**
 * Distancia en metros entre dos coordenadas (fórmula de Haversine). Suficiente
 * para comparar contra un radio de un centenar de metros: no hace falta más
 * precisión que esa para saber si alguien está en el bar o no.
 */
export function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = g => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Forma canónica del nombre de un centro: la que está dada de alta en
 * centros_cfg.
 *
 * El centro viaja como texto libre desde el cliente y llega escrito distinto
 * según de dónde salga (la dirección, el selector, lo que se guardó en el
 * móvil hace meses). Guardar cada variante tal cual es lo que ha hecho que una
 * tarea creada como "corte de manga" no aparezca al mirar "Corte de Manga".
 *
 * A diferencia de getCentroCfg, esto NO da de alta el centro si no existe:
 * solo traduce. Un centro que no está dado de alta se devuelve limpio de
 * espacios, que es lo mejor que se puede decir de él.
 */
export async function centroCanonico(db, centro) {
  const limpio = String(centro || '').trim();
  if (!limpio) return '';
  try {
    const r = await db.execute({
      sql: "SELECT centro FROM centros_cfg WHERE LOWER(TRIM(centro)) = LOWER(TRIM(?)) LIMIT 1",
      args: [limpio],
    });
    if (r.rows.length) return r.rows[0].centro;
  } catch {}
  return limpio;
}

/**
 * El centro de una acción, tomando como referencia al empleado: cada persona
 * tiene su centro asignado en la ficha, y esa es la fuente de verdad para
 * saber dónde trabaja.
 *
 * Si lo que manda el cliente es ese mismo centro escrito de otra forma, gana
 * el de la ficha. Si es OTRO centro distinto de verdad —alguien cubriendo un
 * turno en otro local—, se respeta lo que manda el cliente: forzar el suyo
 * guardaría el fichaje en el sitio equivocado sin decir nada.
 */
export async function centroDeEmpleado(db, empleado, centroSugerido = '') {
  const pedido = await centroCanonico(db, centroSugerido);

  let suyo = '';
  try {
    const r = await db.execute({
      sql: "SELECT centro FROM empleados WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?)) LIMIT 1",
      args: [String(empleado || '').trim()],
    });
    if (r.rows.length) suyo = await centroCanonico(db, r.rows[0].centro);
  } catch {}

  if (!suyo) return pedido;
  if (!pedido) return suyo;
  return pedido.trim().toLowerCase() === suyo.trim().toLowerCase() ? suyo : pedido;
}

// ── Recurrencia ───────────────────────────────────────────────
/**
 * ¿Toca esta plantilla en esta fecha operativa?
 * recurrencia: {"tipo":"diaria"} | {"tipo":"semanal","dias":[1..7]} | {"tipo":"mensual","dia":N}
 * (1 = lunes ... 7 = domingo)
 */
export function tocaEnFecha(recurrencia, fechaOperativa) {
  let r;
  try { r = JSON.parse(recurrencia || '{"tipo":"diaria"}'); } catch { r = { tipo: 'diaria' }; }

  const [Y, M, D] = fechaOperativa.split('-').map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D));
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();

  if (r.tipo === 'semanal') return Array.isArray(r.dias) && r.dias.map(Number).includes(dow);
  if (r.tipo === 'mensual') return Number(r.dia || 1) === D;
  return true; // diaria
}

// ── Red del local (§7: presencia sin geolocalización) ─────────

/** IP pública desde la que llega la petición. */
export function ipDeReq(req) {
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  return (xff.split(',')[0] || '').trim() || (req.socket?.remoteAddress || '');
}

/**
 * Huella de la red a la que pertenece una IP.
 *
 * En IPv4 todos los dispositivos del local salen con la misma IP pública, así
 * que vale la IP entera. En IPv6 cada dispositivo tiene su propia dirección
 * pero comparten el prefijo /64 de la línea, así que se compara ese prefijo:
 * de lo contrario, autorizar "la red" solo autorizaría un móvil concreto.
 */
export function huellaRed(ip) {
  const limpia = String(ip || '').trim().toLowerCase().replace(/^::ffff:/, '');
  if (!limpia) return '';
  if (limpia.includes(':')) {
    const grupos = limpia.split(':');
    return grupos.slice(0, 4).join(':') + '::/64';
  }
  return limpia;
}

/** ¿La petición llega desde alguna de las redes autorizadas del centro? */
export function esRedAutorizada(req, cfg) {
  const lista = String(cfg?.ips_autorizadas || '')
    .split(',').map(x => x.trim()).filter(Boolean);
  if (!lista.length) return { permitido: true, sinConfigurar: true };

  const actual = huellaRed(ipDeReq(req));
  return { permitido: lista.includes(actual), sinConfigurar: false, red: actual };
}

// ── Código rotatorio del local (presencia sin geolocalización) ─
//
// El iPad del bar muestra un QR que cambia cada 25 s. Quien ficha desde su
// móvil tiene que haberlo leído: eso prueba que estaba delante del iPad, que es
// lo que la red por sí sola no puede demostrar (la wifi llega a la calle).
//
// El token va firmado, no guardado: se recalcula al validarlo, así que emitirlo
// no cuesta ni una escritura en la base de datos.

export const QR_VENTANA_MS = 25000;

/** Ventana temporal a la que pertenece un instante. */
export function ventanaQr(ts = Date.now()) {
  return Math.floor(ts / QR_VENTANA_MS);
}

function firmaQr(secreto, centro, ventana) {
  return crypto.createHmac('sha256', secreto)
    .update(`${String(centro).trim().toLowerCase()}|${ventana}`)
    .digest('base64url')
    .slice(0, 10);
}

/** El secreto de firma. Sin él, el fichaje por QR no se habilita. */
export function hayQrConfigurado() {
  return !!process.env.QR_SECRET;
}

/** Token vigente para un centro, con lo que le queda de vida. */
export function emitirTokenQr(centro) {
  if (!hayQrConfigurado()) return null;
  const ahora = Date.now();
  const ventana = ventanaQr(ahora);
  return {
    token: firmaQr(process.env.QR_SECRET, centro, ventana),
    ventana,
    expira_en: (ventana + 1) * QR_VENTANA_MS - ahora,
    ventana_ms: QR_VENTANA_MS,
  };
}

/**
 * ¿Es válido este token para este centro?
 *
 * Se acepta también la ventana anterior: entre que apuntan la cámara, tocan el
 * aviso y carga la app pasan unos segundos, y no tiene sentido rechazar a
 * alguien que está delante del iPad por medio segundo. En la práctica el código
 * vale entre 25 y 50 s.
 */
export function validarTokenQr(centro, token) {
  if (!hayQrConfigurado()) return { ok: false, motivo: 'sin_configurar' };
  const limpio = String(token || '').trim();
  if (!limpio) return { ok: false, motivo: 'falta' };

  const actual = ventanaQr();
  for (const ventana of [actual, actual - 1]) {
    const esperado = firmaQr(process.env.QR_SECRET, centro, ventana);
    // Comparación en tiempo constante: la longitud ya es fija.
    if (limpio.length === esperado.length
        && crypto.timingSafeEqual(Buffer.from(limpio), Buffer.from(esperado))) {
      return { ok: true, ventana };
    }
  }
  return { ok: false, motivo: 'caducado' };
}

// ── Dispositivos de confianza ─────────────────────────────────
// El iPad del bar no debería tener que leer un QR que muestra él mismo. Se
// registra una vez desde dentro del local y queda exento.

export function idDispositivo(req) {
  return String(req.headers['x-device-id'] || req.body?.device_id || '').trim().slice(0, 64);
}

export function esDispositivoConfianza(req, cfg) {
  const id = idDispositivo(req);
  if (!id) return false;
  return String(cfg?.dispositivos_confianza || '')
    .split(',').map(x => x.trim()).filter(Boolean)
    .includes(id);
}

/**
 * ¿Hay algún aparato registrado como de confianza en este centro?
 *
 * Sirve de señal de que el iPad ya está montado, porque registrarlo solo se
 * puede hacer desde dentro del local y quitarlo exige encargado o gerencia.
 */
export function hayDispositivosDeConfianza(cfg) {
  return String(cfg?.dispositivos_confianza || '')
    .split(',').map(x => x.trim()).filter(Boolean).length > 0;
}

/**
 * ¿Hay que exigir el código del bar en esta petición?
 *
 * No basta con que exista el secreto de firma. Mientras no haya ni un aparato
 * de confianza en el centro, nadie está enseñando el código: el iPad todavía no
 * está montado, o se ha dado de baja. Exigirlo entonces no protegería nada y
 * dejaría al bar entero sin poder fichar, así que se abre.
 *
 * Es el mismo criterio que ya se sigue con la red autorizada: configurarlo es
 * una decisión, no un requisito para que la app funcione. En cuanto el iPad
 * queda registrado, el código pasa a ser obligatorio para los demás móviles.
 */
export function exigirQr(req, cfg) {
  if (!hayQrConfigurado()) return false;
  if (!hayDispositivosDeConfianza(cfg)) return false;
  return !esDispositivoConfianza(req, cfg);
}

// ── Identidad y turno ─────────────────────────────────────────
export function hashPin(nombre, pin) {
  return crypto.createHash('sha256')
    .update(`${String(nombre).trim().toLowerCase()}:${String(pin)}`)
    .digest('hex');
}

export function hashArchivo(base64) {
  const limpio = String(base64).replace(/^data:[^;]+;base64,/, '');
  return crypto.createHash('sha256').update(Buffer.from(limpio, 'base64')).digest('hex');
}

/**
 * Verifica la identidad del empleado.
 *
 * El PIN es opcional por diseño: si el empleado no tiene PIN asignado se
 * permite registrar la tarea sin él (modo simple, un toque desde la pantalla
 * de fichaje) y queda anotado en la auditoría como `sin_pin`. En cuanto se le
 * asigna un PIN pasa a modo estricto y se exige siempre.
 * Si el móvil ya tiene sesión iniciada vale el testigo en lugar del número:
 * así la pantalla de tareas deja de pedir el PIN cada minuto y medio.
 * Devuelve {ok, motivo, sinPin}.
 */
export async function verificarPin(db, nombre, pin, sesion = '') {
  if (!nombre) return { ok: false, motivo: 'Falta el empleado' };

  if (sesion) {
    const e = await validarSesionEmpleado(db, sesion);
    if (e && String(e.nombre).trim().toLowerCase() === String(nombre).trim().toLowerCase()) {
      return { ok: true, sinPin: false, porSesion: true };
    }
  }

  const r = await db.execute({
    sql: "SELECT nombre, pin_hash FROM empleados WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))",
    args: [nombre],
  });
  if (!r.rows.length) return { ok: false, motivo: 'Empleado no encontrado' };

  const hash = r.rows[0].pin_hash || '';
  if (!hash) return { ok: true, sinPin: true };

  if (!pin) return { ok: false, motivo: 'Falta el PIN' };
  if (!igualSeguro(hash, hashPin(r.rows[0].nombre, pin))) return { ok: false, motivo: 'PIN incorrecto' };
  return { ok: true, sinPin: false };
}

// ── Entrar con el PIN ─────────────────────────────────────────
//
// El PIN dice QUIÉN eres; el código del bar dice DÓNDE estás. Son dos cosas
// distintas y hacen falta las dos: con PIN pero sin código se ficharía desde
// casa, y con código pero sin PIN se ficharía por un compañero.

export const PIN_DIGITOS = 6;
const FALLOS_VENTANA_MS = 10 * 60 * 1000;
// Por aparato se es estricto. Por red hay que ser mucho más laxo: en el bar
// todos salen por la misma línea, así que un tope bajo por red convertiría los
// dedos torpes de uno en un bloqueo para toda la plantilla. Treinta fallos en
// diez minutos siguen matando un ataque por fuerza bruta —que necesita miles—
// sin dejar a nadie fuera por equivocarse.
const FALLOS_MAX_APARATO = 5;
const FALLOS_MAX_RED = 30;

/** Comparación en tiempo constante de dos cadenas hexadecimales. */
function igualSeguro(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * ¿De quién es este PIN?
 *
 * No se puede buscar el hash directamente: `hashPin` mezcla el nombre con el
 * número, así que hay que probarlo contra cada empleado. Con una decena de
 * personas es instantáneo, y a cambio el hash de cada uno es distinto aunque
 * dos compartan número.
 *
 * OJO: esto NO es `verificarPin`. Aquella devuelve "correcto" cuando el
 * empleado no tiene PIN —su modo permisivo para tareas— y como puerta de
 * entrada eso sería un agujero: bastaría el nombre de alguien sin PIN. Aquí
 * solo se miran los que SÍ tienen PIN.
 */
export async function identificarPorPin(db, pin) {
  const limpio = String(pin || '').trim();
  if (!/^\d{4,8}$/.test(limpio)) return null;

  const r = await db.execute(
    "SELECT nombre, centro, rol, pin_hash FROM empleados WHERE COALESCE(pin_hash,'') <> ''"
  );

  let encontrado = null;
  for (const e of r.rows) {
    // Se recorre la lista entera aunque ya haya coincidencia, para que el
    // tiempo de respuesta no delate en qué posición estaba el acierto.
    if (igualSeguro(e.pin_hash, hashPin(e.nombre, limpio))) encontrado = e;
  }
  return encontrado;
}

/** ¿Hay algún empleado (distinto de `salvo`) con este PIN? */
export async function pinYaEnUso(db, pin, salvo = '') {
  const e = await identificarPorPin(db, pin);
  if (!e) return false;
  return String(e.nombre).trim().toLowerCase() !== String(salvo).trim().toLowerCase();
}

// ── Bot de Telegram para empleados ─────────────────────────────
// Un bot distinto al de gerencia (§ api/_telegram.js): ahí hay un solo chat
// fijo para el dueño, aquí cada persona tiene el suyo, así que hace falta
// saber qué chat es de quién. Se vincula con el mismo PIN que ya usan para
// fichar y para las tareas — nada nuevo que dar de alta.

/** El empleado dueño de este chat de Telegram, o null si no está vinculado. */
export async function identificarPorTelegramChatId(db, chatId) {
  const limpio = String(chatId ?? '').trim();
  if (!limpio) return null;
  const r = await db.execute({
    sql: "SELECT nombre, centro, rol FROM empleados WHERE telegram_chat_id = ? LIMIT 1",
    args: [limpio],
  });
  return r.rows[0] || null;
}

/**
 * Vincula un chat de Telegram a un empleado por su nombre.
 *
 * Si ese chat ya estaba vinculado a otra ficha —aparato compartido, cuenta
 * reasignada—, se libera antes: un chat es de una sola persona, igual que
 * hace cumplir el índice único de arriba.
 */
export async function vincularTelegram(db, nombre, chatId) {
  const limpio = String(chatId ?? '').trim();
  if (!limpio || !nombre) return;
  await db.execute({
    sql: `UPDATE empleados SET telegram_chat_id = ''
          WHERE telegram_chat_id = ? AND LOWER(TRIM(nombre)) <> LOWER(TRIM(?))`,
    args: [limpio, nombre],
  });
  await db.execute({
    sql: "UPDATE empleados SET telegram_chat_id = ? WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))",
    args: [limpio, nombre],
  });
}

/**
 * El chat de Telegram vinculado a un empleado por su nombre, o '' si no tiene
 * ninguno (o no existe). Para los avisos que salen desde otras rutas —
 * horario nuevo, solicitud resuelta— que necesitan saber a quién escribir.
 */
export async function telegramChatDeEmpleado(db, nombre) {
  if (!nombre) return '';
  const r = await db.execute({
    sql: "SELECT telegram_chat_id FROM empleados WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?)) LIMIT 1",
    args: [nombre],
  });
  return r.rows[0]?.telegram_chat_id || '';
}

/** Desvincula un chat, sea de quien sea. */
export async function desvincularTelegram(db, chatId) {
  const limpio = String(chatId ?? '').trim();
  if (!limpio) return;
  await db.execute({
    sql: "UPDATE empleados SET telegram_chat_id = '' WHERE telegram_chat_id = ?",
    args: [limpio],
  });
}

// ── PIN de gerencia ───────────────────────────────────────────
// El mismo teclado que usa el equipo sirve para entrar al panel: según de
// quién sea el PIN, se acaba en la pantalla de fichaje o en la de gerencia.
// No vive en `empleados` porque el dueño no es un empleado más, y ensuciar
// esa lista rompería el cuadrante y los informes.

const CLAVE_PIN_ADMIN = 'pin_admin';

/** El nombre fijo hace de sal, igual que con los empleados. */
export function hashPinAdmin(pin) {
  return hashPin('\u0000gerencia', pin);
}

export async function guardarPinAdmin(db, pin) {
  await db.execute({
    sql: `INSERT INTO mantenimiento (clave, ts, valor) VALUES (?, ?, ?)
          ON CONFLICT(clave) DO UPDATE SET ts = excluded.ts, valor = excluded.valor`,
    args: [CLAVE_PIN_ADMIN, Date.now(), pin ? hashPinAdmin(pin) : ''],
  });
}

export async function esPinAdmin(db, pin) {
  const limpio = String(pin || '').trim();
  if (!/^\d{4,8}$/.test(limpio)) return false;
  const r = await db.execute({
    sql: "SELECT valor FROM mantenimiento WHERE clave = ?",
    args: [CLAVE_PIN_ADMIN],
  });
  const guardado = r.rows[0]?.valor || '';
  if (!guardado) return false;
  return igualSeguro(guardado, hashPinAdmin(limpio));
}

export async function hayPinAdmin(db) {
  const r = await db.execute({
    sql: "SELECT valor FROM mantenimiento WHERE clave = ?",
    args: [CLAVE_PIN_ADMIN],
  });
  return !!(r.rows[0]?.valor);
}

// ── Sesión del empleado en su móvil ───────────────────────────
// Se firma igual que el código del bar. El PIN no se queda guardado en el
// móvil: solo este testigo. Y como el hash del PIN entra en la firma,
// regenerar el PIN cierra automáticamente todas sus sesiones — que es la vía
// para cuando alguien pierde el móvil o deja el trabajo.

function firmaSesion(nombre, pinHash, emitido) {
  return crypto.createHmac('sha256', process.env.QR_SECRET || '')
    .update(`emp|${String(nombre).trim().toLowerCase()}|${pinHash}|${emitido}`)
    .digest('base64url')
    .slice(0, 24);
}

export function emitirSesionEmpleado(nombre, pinHash) {
  if (!hayQrConfigurado()) return '';
  const emitido = Date.now();
  return `${Buffer.from(String(nombre)).toString('base64url')}.${emitido}.${firmaSesion(nombre, pinHash, emitido)}`;
}

/** Devuelve el empleado del testigo, o null. */
export async function validarSesionEmpleado(db, testigo) {
  if (!hayQrConfigurado()) return null;
  const partes = String(testigo || '').split('.');
  if (partes.length !== 3) return null;

  let nombre;
  try { nombre = Buffer.from(partes[0], 'base64url').toString(); } catch { return null; }
  const emitido = Number(partes[1]);
  if (!nombre || !Number.isFinite(emitido)) return null;

  const r = await db.execute({
    sql: "SELECT nombre, centro, rol, pin_hash FROM empleados WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))",
    args: [nombre],
  });
  if (!r.rows.length) return null;

  const e = r.rows[0];
  if (!e.pin_hash) return null;   // le han quitado el PIN: fuera
  if (!igualSeguro(partes[2], firmaSesion(e.nombre, e.pin_hash, emitido))) return null;
  return e;
}

/**
 * Fallos recientes (de PIN, o del tipo de evento que se indique) desde esta
 * red o este aparato.
 *
 * Se cuenta por huella de red, no por IP exacta: en IPv6 cada móvil tiene su
 * propia dirección y limitar por IP no limitaría nada. El aparato se cuenta
 * también, pero como señal: el identificador lo genera el cliente.
 *
 * `tipoEvento` es parametrizable para reutilizar el mismo contador con el
 * login de encargado/gerencia (`LOGIN_FALLIDO`), que antes no tenía ningún
 * límite de intentos.
 */
export async function fallosDePinRecientes(db, req, tipoEvento = 'PIN_FALLIDO') {
  const desde = Date.now() - FALLOS_VENTANA_MS;
  const red = huellaRed(ipDeReq(req));
  const aparato = idDispositivo(req);

  const r = await db.execute({
    sql: `SELECT
            SUM(CASE WHEN ? <> '' AND device_id = ? THEN 1 ELSE 0 END) AS aparato,
            SUM(CASE WHEN ? <> '' AND ip = ?        THEN 1 ELSE 0 END) AS red
          FROM evento_auditoria
          WHERE tipo_evento = ? AND ts_servidor >= ?`,
    args: [aparato, aparato, red, red, tipoEvento, desde],
  });

  const nAparato = Number(r.rows[0]?.aparato || 0);
  const nRed = Number(r.rows[0]?.red || 0);
  return {
    n: nAparato,
    bloqueado: nAparato >= FALLOS_MAX_APARATO || nRed >= FALLOS_MAX_RED,
    esperaMs: FALLOS_VENTANA_MS,
  };
}

/**
 * ¿Tiene el empleado un turno abierto? (§2 / §6.6)
 * Abierto = su último fichaje no es 'salida'.
 */
export async function turnoAbierto(db, empleado, centro) {
  const r = await db.execute({
    sql: `SELECT tipo, timestamp FROM fichajes
          WHERE empleado = ?
            AND (LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?)) OR TRIM(COALESCE(centro,'')) = '')
          ORDER BY timestamp DESC LIMIT 1`,
    args: [empleado, centro || ''],
  });
  if (!r.rows.length) return false;
  const tipo = r.rows[0].tipo;
  return tipo === 'entrada' || tipo === 'inicio_descanso' || tipo === 'fin_descanso';
}

export async function estaEnDescanso(db, empleado, centro) {
  const r = await db.execute({
    sql: `SELECT tipo FROM fichajes
          WHERE empleado = ?
            AND (LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?)) OR TRIM(COALESCE(centro,'')) = '')
          ORDER BY timestamp DESC LIMIT 1`,
    args: [empleado, centro || ''],
  });
  return r.rows.length ? r.rows[0].tipo === 'inicio_descanso' : false;
}

/**
 * Quién tiene el turno abierto ahora mismo en un centro (su fichaje más
 * reciente no es una salida), con el rol de cada uno. Usado por el aviso de
 * tarea vencida y por el resumen de /hoy en Telegram, para decir no solo qué
 * falta sino quién estaba delante para hacerla.
 */
export async function quienEstaDentro(db, centro) {
  const desde = Date.now() - 24 * 60 * 60 * 1000;
  const r = await db.execute({
    sql: `SELECT f.empleado, f.tipo, f.timestamp, emp.rol
          FROM fichajes f
          LEFT JOIN empleados emp ON LOWER(TRIM(emp.nombre)) = LOWER(TRIM(f.empleado))
          WHERE (LOWER(TRIM(COALESCE(f.centro,''))) = LOWER(TRIM(?)) OR TRIM(COALESCE(f.centro,'')) = '')
            AND f.timestamp >= ?
          ORDER BY f.timestamp DESC`,
    args: [centro, desde],
  });

  const vistos = new Set();
  const dentro = [];
  for (const f of r.rows) {
    const clave = String(f.empleado).trim().toLowerCase();
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    if (f.tipo !== 'salida') dentro.push({ nombre: f.empleado, rol: String(f.rol || '').toLowerCase() });
  }
  return dentro;
}

/** Mismo criterio que ya usa el móvil (tareaEsDe): "mixto" cubre sala y cocina. */
export function esDelRol(rolResponsable, rolEmpleado) {
  if (!rolEmpleado) return false;
  if (rolEmpleado === 'mixto') return rolResponsable === 'SALA' || rolResponsable === 'COCINA';
  return rolEmpleado.toUpperCase() === rolResponsable;
}

/** Genera las instancias del día si no existen (§5, generación perezosa). */
export async function generarInstancias(db, centro, fechaOperativa, cfg) {
  const plantillas = await db.execute({
    sql: `SELECT * FROM tarea_plantillas
          WHERE vigente_hasta = '' AND activa = 1
            AND (LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?)) OR TRIM(COALESCE(centro,'')) = '')`,
    args: [centro],
  });

  let creadas = 0;
  for (const p of plantillas.rows) {
    if (!tocaEnFecha(p.recurrencia, fechaOperativa)) continue;

    const { inicioTs, finTs } = resolverVentana(fechaOperativa, p.ventana_inicio, p.ventana_fin, cfg);
    // INSERT OR IGNORE + índice único ⇒ idempotente aunque se ejecute dos veces.
    const r = await db.execute({
      sql: `INSERT OR IGNORE INTO tarea_instancias
            (plantilla_version_id, familia_id, centro, fecha_operativa,
             ventana_inicio_ts, ventana_fin_ts, tolerancia_min, estado,
             rol_responsable, origen, creado_en)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?, 'RECURRENTE', ?)`,
      args: [p.id, p.familia_id, centro, fechaOperativa, inicioTs, finTs,
             Number(p.tolerancia_min || 30), p.rol_responsable, Date.now()],
    });
    if (r.rowsAffected) creadas++;
  }
  return creadas;
}

/**
 * Marca como VENCIDA lo que pasó de ventana + tolerancia (§4.4, automático),
 * y avisa por Telegram de las que acaban de cruzar esa línea.
 *
 * El aviso sale una sola vez por tarea sin necesitar ninguna marca extra: se
 * busca ANTES de actualizar quién sigue en PENDIENTE y ya se ha pasado, se
 * cambia su estado, y solo esas se avisan. La próxima vez que se llame (esto
 * corre en cada visita a la pantalla de tareas) esas filas ya no están en
 * PENDIENTE, así que no vuelven a salir en la búsqueda ni se avisan dos veces.
 */
export async function marcarVencidas(db, centro, fechaOperativa) {
  const vencidas = await db.execute({
    sql: `SELECT i.id, p.nombre, p.criticidad, p.rol_responsable
          FROM tarea_instancias i
          JOIN tarea_plantillas p ON p.id = i.plantilla_version_id
          WHERE LOWER(TRIM(COALESCE(i.centro,''))) = LOWER(TRIM(?))
            AND i.fecha_operativa = ? AND i.estado = 'PENDIENTE'
            AND (i.ventana_fin_ts + i.tolerancia_min * 60000) < ?`,
    args: [centro, fechaOperativa, Date.now()],
  });
  if (!vencidas.rows.length) return;

  const ids = vencidas.rows.map(r => r.id);
  await db.execute({
    sql: `UPDATE tarea_instancias SET estado = 'VENCIDA' WHERE id IN (${ids.map(() => '?').join(',')})`,
    args: ids,
  });

  // Una sola consulta para todas las tareas vencidas de esta pasada, no una
  // por tarea: quién está dentro no cambia entre una y otra.
  const dentro = await quienEstaDentro(db, centro);

  for (const t of vencidas.rows) {
    const responsables = dentro.filter(p => esDelRol(t.rol_responsable, p.rol));
    const lineaDentro = !dentro.length
      ? 'Nadie fichado dentro ahora mismo.'
      : responsables.length
        ? `En el bar ahora mismo, de ${escTelegram((t.rol_responsable || '').toLowerCase())}: `
          + responsables.map(p => escTelegram(p.nombre)).join(', ')
        : `Nadie de ${escTelegram((t.rol_responsable || '').toLowerCase())} está en el bar ahora mismo `
          + `(sí: ${dentro.map(p => escTelegram(p.nombre)).join(', ')}).`;

    // Botón para resolverla sin entrar en el panel: útil para lo que de
    // verdad no aplica hoy (cerrado por vacaciones, proveedor que no vino...).
    await avisarTelegram(conEnlacePanel(
      `⏰ <b>${escTelegram(t.nombre)}</b> se ha pasado de plazo sin hacerse`
      + `${t.criticidad === 'BLOQUEANTE' ? ' — <b>bloqueante</b>' : ''} en ${escTelegram(centro)}.\n`
      + lineaDentro,
      centro
    ), {
      reply_markup: { inline_keyboard: [[{ text: '🚫 Marcar como no aplica', callback_data: `no_aplica:${t.id}` }]] },
    });
  }
}

// ── Auditoría ─────────────────────────────────────────────────
export async function auditar(db, req, datos) {
  // Normalmente se guarda la IP tal cual. Quien necesite agrupar por red —el
  // tope de intentos de PIN— pasa ya la huella, para poder contarla luego.
  const ip = datos.ip ?? (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  await db.execute({
    sql: `INSERT INTO evento_auditoria
          (tipo_evento, entidad, entidad_id, empleado, centro, ts_servidor, ip, device_id, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      datos.tipo_evento,
      datos.entidad || '',
      String(datos.entidad_id ?? ''),
      datos.empleado || '',
      datos.centro || '',
      Date.now(),
      ip,
      datos.device_id || '',
      datos.payload ? JSON.stringify(datos.payload) : '',
    ],
  });
}

// ── Permisos ──────────────────────────────────────────────────
// Antes, "el nivel de la petición" era comparar el header contra dos cadenas
// fijas ('auth-token-fichaje-admin'/'-encargado'). Cualquiera que hubiera
// visto esa cadena una vez —y estaba escrita también en el HTML público de
// más de diez pantallas— podía escribirla directamente en su sessionStorage
// y entrar como gerencia sin contraseña. Ahora es una firma HMAC de verdad:
// ver emitirSesionResponsable más abajo.

export const claveAdmin = () => process.env.ADMIN_PASSWORD || '';
export const claveEncargado = () => process.env.ENCARGADO_PASSWORD || '';
export const usuarioEncargado = () => process.env.ENCARGADO_USER || '';

// 30 días: sesión larga a propósito (equipo pequeño, móviles personales), no
// hace falta escribir la contraseña cada día. Si algún día se quiere más
// corta, es este número — el resto del mecanismo no depende de él.
const SESSION_MAX_EDAD_MS = 30 * 24 * 60 * 60 * 1000;

function hashClave(clave) {
  return crypto.createHash('sha256').update(String(clave || '')).digest('hex');
}

/**
 * ¿Coincide esta contraseña con la configurada? Se hashean las dos antes de
 * comparar (tiempo constante de verdad, no solo `timingSafeEqual` con
 * cadenas de longitud distinta —que ni siquiera llegaría a compararlas—).
 * Si `real` está vacía (esa clave no está configurada), nunca coincide: sin
 * configurar no es "cualquier cosa vale", es "nadie entra por aquí".
 */
export function claveCoincide(candidata, real) {
  if (!real) return false;
  return igualSeguro(hashClave(candidata), hashClave(real));
}

function firmaResponsable(nivel, claveHash, emitido) {
  return crypto.createHmac('sha256', process.env.AUTH_SECRET || '')
    .update(`resp|${nivel}|${claveHash}|${emitido}`)
    .digest('base64url')
    .slice(0, 24);
}

/** Sin esto configurado, gerencia y encargado no pueden entrar — nunca con una contraseña por defecto adivinable. */
export function hayAuthConfigurado() {
  return !!process.env.AUTH_SECRET;
}

/**
 * Sesión firmada para encargado/gerencia: "NIVEL.emitido.firma". La
 * contraseña actual entra en la firma (como hash, nunca en claro), así que
 * cambiarla en Vercel invalida al instante todas las sesiones de ese nivel
 * —el mismo efecto que ya tiene regenerar el PIN de un empleado— sin
 * necesitar ninguna tabla ni lista de sesiones activas.
 */
export function emitirSesionResponsable(nivel, clave) {
  if (!hayAuthConfigurado()) return '';
  const emitido = Date.now();
  return `${nivel}.${emitido}.${firmaResponsable(nivel, hashClave(clave), emitido)}`;
}

export function nivelDesdeReq(req) {
  if (!hayAuthConfigurado()) return 'EMPLEADO';
  const testigo = (req.headers['x-auth-token'] || req.body?.token || '').toString();
  const [nivel, emitidoStr, firma] = testigo.split('.');
  if (nivel !== 'ADMIN' && nivel !== 'ENCARGADO') return 'EMPLEADO';

  const emitido = Number(emitidoStr);
  if (!Number.isFinite(emitido) || Date.now() - emitido > SESSION_MAX_EDAD_MS) return 'EMPLEADO';

  const clave = nivel === 'ADMIN' ? claveAdmin() : claveEncargado();
  if (!clave) return 'EMPLEADO'; // ese nivel ni siquiera está configurado hoy
  if (!igualSeguro(firma || '', firmaResponsable(nivel, hashClave(clave), emitido))) return 'EMPLEADO';
  return nivel;
}

export function esEncargadoOSuperior(req) {
  const n = nivelDesdeReq(req);
  return n === 'ADMIN' || n === 'ENCARGADO';
}
