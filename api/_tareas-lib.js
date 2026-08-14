import crypto from "node:crypto";

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

  // PIN por empleado para autorizar acciones en tablet compartida (§7).
  try { await db.execute("ALTER TABLE empleados ADD COLUMN pin_hash TEXT NOT NULL DEFAULT ''"); } catch {}

  await db.execute(`
    CREATE TABLE IF NOT EXISTS mantenimiento (
      clave TEXT PRIMARY KEY,
      ts INTEGER NOT NULL
    )
  `);

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
function partesEnZona(ts, tz) {
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

function sumarDias(fecha, dias) {
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
    sql: "SELECT centro, inicio_jornada, zona_horaria, ips_autorizadas FROM centros_cfg WHERE LOWER(TRIM(centro)) = LOWER(TRIM(?))",
    args: [centro || ''],
  });
  if (r.rows.length) {
    const row = r.rows[0];
    return {
      centro: row.centro,
      inicio_jornada: row.inicio_jornada || INICIO_JORNADA_DEFAULT,
      zona_horaria: row.zona_horaria || TZ_DEFAULT,
      ips_autorizadas: row.ips_autorizadas || '',
    };
  }
  try {
    await db.execute({
      sql: "INSERT INTO centros_cfg (centro, inicio_jornada, zona_horaria) VALUES (?, ?, ?)",
      args: [centro || '', INICIO_JORNADA_DEFAULT, TZ_DEFAULT],
    });
  } catch {}
  return { centro: centro || '', inicio_jornada: INICIO_JORNADA_DEFAULT, zona_horaria: TZ_DEFAULT, ips_autorizadas: '' };
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
 * Devuelve {ok, motivo, sinPin}.
 */
export async function verificarPin(db, nombre, pin) {
  if (!nombre) return { ok: false, motivo: 'Falta el empleado' };

  const r = await db.execute({
    sql: "SELECT nombre, pin_hash FROM empleados WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))",
    args: [nombre],
  });
  if (!r.rows.length) return { ok: false, motivo: 'Empleado no encontrado' };

  const hash = r.rows[0].pin_hash || '';
  if (!hash) return { ok: true, sinPin: true };

  if (!pin) return { ok: false, motivo: 'Falta el PIN' };
  if (hash !== hashPin(r.rows[0].nombre, pin)) return { ok: false, motivo: 'PIN incorrecto' };
  return { ok: true, sinPin: false };
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

// ── Auditoría ─────────────────────────────────────────────────
export async function auditar(db, req, datos) {
  const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
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
// Nota: el modelo de sesión actual de la app son tokens estáticos en
// sessionStorage. Se validan aquí para que las acciones de encargado no se
// puedan invocar desde la pantalla de empleado, pero NO es autenticación
// fuerte: un token filtrado es reutilizable. Ver "Limitaciones" en el PR.
export const TOKEN_ADMIN = 'auth-token-fichaje-admin';
export const TOKEN_ENCARGADO = 'auth-token-fichaje-encargado';

export function nivelDesdeReq(req) {
  const t = (req.headers['x-auth-token'] || req.body?.token || '').toString();
  if (t === TOKEN_ADMIN) return 'ADMIN';
  if (t === TOKEN_ENCARGADO) return 'ENCARGADO';
  return 'EMPLEADO';
}

export function esEncargadoOSuperior(req) {
  const n = nivelDesdeReq(req);
  return n === 'ADMIN' || n === 'ENCARGADO';
}
