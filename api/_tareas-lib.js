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
  // Dispositivos exentos de leer el QR: el iPad del propio bar.
  try { await db.execute("ALTER TABLE centros_cfg ADD COLUMN dispositivos_confianza TEXT NOT NULL DEFAULT ''"); } catch {}

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

  // El tope de intentos de PIN es la primera consulta que lee esta tabla. Sin
  // índice sería un recorrido completo de algo que solo crece.
  try { await db.execute("CREATE INDEX IF NOT EXISTS idx_auditoria_ip ON evento_auditoria (tipo_evento, ip, ts_servidor)"); } catch {}
  try { await db.execute("CREATE INDEX IF NOT EXISTS idx_auditoria_dev ON evento_auditoria (tipo_evento, device_id, ts_servidor)"); } catch {}

  // PIN por empleado para autorizar acciones en tablet compartida (§7).
  try { await db.execute("ALTER TABLE empleados ADD COLUMN pin_hash TEXT NOT NULL DEFAULT ''"); } catch {}

  await db.execute(`
    CREATE TABLE IF NOT EXISTS mantenimiento (
      clave TEXT PRIMARY KEY,
      ts INTEGER NOT NULL
    )
  `);
  // Pasa a guardar también un valor: hoy solo el PIN de gerencia, que no
  // pertenece a ningún centro ni a la lista de empleados.
  try { await db.execute("ALTER TABLE mantenimiento ADD COLUMN valor TEXT NOT NULL DEFAULT ''"); } catch {}

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
    sql: "SELECT centro, inicio_jornada, zona_horaria, ips_autorizadas, dispositivos_confianza FROM centros_cfg WHERE LOWER(TRIM(centro)) = LOWER(TRIM(?))",
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
  };
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
 * Fallos de PIN recientes desde esta red o este aparato.
 *
 * Se cuenta por huella de red, no por IP exacta: en IPv6 cada móvil tiene su
 * propia dirección y limitar por IP no limitaría nada. El aparato se cuenta
 * también, pero como señal: el identificador lo genera el cliente.
 */
export async function fallosDePinRecientes(db, req) {
  const desde = Date.now() - FALLOS_VENTANA_MS;
  const red = huellaRed(ipDeReq(req));
  const aparato = idDispositivo(req);

  const r = await db.execute({
    sql: `SELECT
            SUM(CASE WHEN ? <> '' AND device_id = ? THEN 1 ELSE 0 END) AS aparato,
            SUM(CASE WHEN ? <> '' AND ip = ?        THEN 1 ELSE 0 END) AS red
          FROM evento_auditoria
          WHERE tipo_evento = 'PIN_FALLIDO' AND ts_servidor >= ?`,
    args: [aparato, aparato, red, red, desde],
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
