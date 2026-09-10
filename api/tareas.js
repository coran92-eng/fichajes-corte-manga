import { getDbClient } from "./_db.js";
import {
  initSchema, getCentroCfg, fechaOperativaDe,
  verificarPin, turnoAbierto, estaEnDescanso, auditar, esEncargadoOSuperior,
  hashArchivo, purgarFotosCaducadas, RAFAGA_N, RAFAGA_MIN, HASH_LOOKBACK,
  validarTokenQr, esDispositivoConfianza, hayQrConfigurado,
  quienEstaDentro, esDelRol, generarInstancias, marcarVencidas,
  nivelDesdeReq, centroCanonico, BLOQUES, ROLES, TIPOS_EVIDENCIA, CRITICIDADES,
} from "./_tareas-lib.js";
import { avisarTelegram, avisarTelegramConFoto, escTelegram, conEnlacePanel } from "./_telegram.js";

// ── Plantillas de tareas (antes era api/tarea-plantillas.js; fusionado
// aquí para no gastar una función de Vercel más — llega por
// ?modulo=plantillas, mismo criterio que "red" en fichajes.js). ──────

// Catálogo inicial de Corte de Manga (§15) — se carga con ?accion=seed
const CATALOGO_INICIAL = [
  { nombre: 'Montaje de terraza',              bloque: 'APERTURA',         rol: 'SALA',     ini: '08:30', fin: '09:30', ev: 'FOTO',   crit: 'BLOQUEANTE', rec: '{"tipo":"diaria"}' },
  { nombre: 'Comprobar zumo elaborado y stock', bloque: 'APERTURA',        rol: 'BARRA',    ini: '08:30', fin: '09:30', ev: 'TEXTO',  crit: 'BLOQUEANTE', rec: '{"tipo":"diaria"}' },
  { nombre: 'Temperaturas de cámaras',          bloque: 'APERTURA',        rol: 'COCINA',   ini: '09:00', fin: '10:00', ev: 'NUMERO', crit: 'BLOQUEANTE', rec: '{"tipo":"diaria"}', cfg: '{"unidad":"ºC","min":-22,"max":-18}' },
  { nombre: 'Riego de plantas',                 bloque: 'DURANTE_SERVICIO',rol: 'SALA',     ini: '10:00', fin: '12:00', ev: 'FOTO',   crit: 'NORMAL',     rec: '{"tipo":"diaria"}' },
  { nombre: 'Reposición de barra',              bloque: 'CAMBIO_TURNO',    rol: 'BARRA',    ini: '16:00', fin: '17:00', ev: 'CHECK',  crit: 'NORMAL',     rec: '{"tipo":"diaria"}' },
  { nombre: 'Recogida de terraza',              bloque: 'CIERRE',          rol: 'SALA',     ini: '23:00', fin: '00:30', ev: 'FOTO',   crit: 'BLOQUEANTE', rec: '{"tipo":"diaria"}' },
  { nombre: 'Limpieza de local',                bloque: 'CIERRE',          rol: 'LIMPIEZA', ini: '23:30', fin: '01:30', ev: 'FOTO',   crit: 'BLOQUEANTE', rec: '{"tipo":"diaria"}' },
  { nombre: 'Limpieza de cafetera',             bloque: 'CIERRE',          rol: 'BARRA',    ini: '23:30', fin: '01:00', ev: 'FOTO',   crit: 'BLOQUEANTE', rec: '{"tipo":"diaria"}' },
  { nombre: 'Reposición para el día siguiente', bloque: 'CIERRE',          rol: 'BARRA',    ini: '23:00', fin: '01:00', ev: 'CHECK',  crit: 'BLOQUEANTE', rec: '{"tipo":"diaria"}' },
  { nombre: 'Sacar basura y orgánico',          bloque: 'CIERRE',          rol: 'LIMPIEZA', ini: '00:00', fin: '01:30', ev: 'FOTO',   crit: 'NORMAL',     rec: '{"tipo":"diaria"}' },
  { nombre: 'Limpieza a fondo de cámaras',      bloque: 'SEMANAL',         rol: 'COCINA',   ini: '09:00', fin: '13:00', ev: 'FOTO',   crit: 'NORMAL',     rec: '{"tipo":"semanal","dias":[1]}' },
];

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

function nuevaFamiliaId() {
  return `fam_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function validarPlantilla(body) {
  const errores = [];
  if (!body.nombre || !String(body.nombre).trim()) errores.push('nombre requerido');
  if (!BLOQUES.includes(body.bloque)) errores.push(`bloque debe ser uno de ${BLOQUES.join('|')}`);
  if (!ROLES.includes(body.rol_responsable)) errores.push(`rol_responsable debe ser uno de ${ROLES.join('|')}`);
  // §1: una tarea sin ventana, sin rol y sin evidencia no es una tarea.
  if (!/^\d{1,2}:\d{2}$/.test(body.ventana_inicio || '')) errores.push('ventana_inicio requerida (HH:MM)');
  if (!/^\d{1,2}:\d{2}$/.test(body.ventana_fin || '')) errores.push('ventana_fin requerida (HH:MM)');
  if (!TIPOS_EVIDENCIA.includes(body.tipo_evidencia)) errores.push(`tipo_evidencia debe ser uno de ${TIPOS_EVIDENCIA.join('|')}`);
  if (body.criticidad && !CRITICIDADES.includes(body.criticidad)) errores.push('criticidad inválida');
  return errores;
}

async function handlerPlantillas(req, res, db) {
  if (req.method === "GET") {
    res.setHeader('Cache-Control', 'no-store');
    const { centro, incluir_bajas } = req.query;

    let sql = `SELECT * FROM tarea_plantillas WHERE vigente_hasta = ''`;
    const args = [];
    if (!incluir_bajas) sql += ` AND activa = 1`;
    if (centro) {
      sql += ` AND (LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?)) OR TRIM(COALESCE(centro,'')) = '')`;
      args.push(centro);
    }
    sql += ` ORDER BY bloque ASC, orden ASC, nombre ASC`;

    const r = await db.execute({ sql, args });
    return res.status(200).json(r.rows);
  }

  // Crear/editar plantillas es solo de gerencia (§9).
  if (!esEncargadoOSuperior(req)) {
    return res.status(403).json({ error: "No autorizado" });
  }
  const nivel = nivelDesdeReq(req);

  if (req.method === "POST") {
    const { accion } = req.query;

    // Carga del catálogo inicial (§15) para poder probar de inmediato.
    if (accion === 'seed') {
      if (nivel !== 'ADMIN') return res.status(403).json({ error: "Solo gerencia puede cargar el catálogo" });
      if (!req.body?.centro) return res.status(400).json({ error: "Centro requerido" });
      // Sin normalizar, el "ya tiene plantillas" no encontraba las que se
      // cargaron con el centro escrito de otra forma, y el catálogo entero
      // se duplicaba en vez de avisar.
      const centro = await centroCanonico(db, req.body.centro);

      const ya = await db.execute({
        sql: `SELECT COUNT(*) AS n FROM tarea_plantillas
              WHERE LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?)) AND vigente_hasta = ''`,
        args: [centro],
      });
      if (Number(ya.rows[0].n) > 0) {
        return res.status(409).json({ error: "Este centro ya tiene plantillas. Bórralas antes de recargar el catálogo." });
      }

      let orden = 0;
      for (const t of CATALOGO_INICIAL) {
        await db.execute({
          sql: `INSERT INTO tarea_plantillas
                (familia_id, version, centro, nombre, instrucciones, bloque, rol_responsable,
                 ventana_inicio, ventana_fin, tolerancia_min, tipo_evidencia, evidencia_config,
                 criticidad, recurrencia, orden, activa, vigente_desde, vigente_hasta, creado_en)
                VALUES (?, 1, ?, ?, '', ?, ?, ?, ?, 30, ?, ?, ?, ?, ?, 1, ?, '', ?)`,
          args: [nuevaFamiliaId(), centro, t.nombre, t.bloque, t.rol, t.ini, t.fin,
                 t.ev, t.cfg || '', t.crit, t.rec, orden++, hoyISO(), Date.now()],
        });
      }
      await auditar(db, req, {
        tipo_evento: 'PLANTILLAS_SEED', entidad: 'tarea_plantillas', centro,
        payload: { total: CATALOGO_INICIAL.length },
      });
      return res.status(201).json({ success: true, creadas: CATALOGO_INICIAL.length });
    }

    const b = req.body || {};
    const errores = validarPlantilla(b);
    if (errores.length) return res.status(422).json({ error: errores.join('; ') });

    const familia_id = nuevaFamiliaId();
    // Una plantilla guardada con el centro escrito de otra forma no genera
    // tareas para ese centro: se queda de adorno en el catálogo.
    const centroPlantilla = await centroCanonico(db, b.centro || '');
    const r = await db.execute({
      sql: `INSERT INTO tarea_plantillas
            (familia_id, version, centro, nombre, instrucciones, bloque, rol_responsable,
             ventana_inicio, ventana_fin, tolerancia_min, tipo_evidencia, evidencia_config,
             criticidad, recurrencia, orden, activa, vigente_desde, vigente_hasta, creado_en)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '', ?)`,
      args: [familia_id, centroPlantilla, String(b.nombre).trim(), b.instrucciones || '',
             b.bloque, b.rol_responsable, b.ventana_inicio, b.ventana_fin,
             Number(b.tolerancia_min ?? 30), b.tipo_evidencia, b.evidencia_config || '',
             b.criticidad || 'NORMAL', b.recurrencia || '{"tipo":"diaria"}',
             Number(b.orden || 0), hoyISO(), Date.now()],
    });

    await auditar(db, req, {
      tipo_evento: 'PLANTILLA_CREADA', entidad: 'tarea_plantillas',
      entidad_id: r.lastInsertRowid?.toString(), centro: centroPlantilla,
      payload: { nombre: b.nombre, familia_id },
    });
    return res.status(201).json({ success: true, id: r.lastInsertRowid?.toString(), familia_id });
  }

  // PUT: editar = crear versión nueva (§4.2). La anterior se cierra con
  // vigente_hasta, de modo que las instancias ya generadas conservan su texto.
  if (req.method === "PUT") {
    const b = req.body || {};
    if (!b.familia_id) return res.status(400).json({ error: "familia_id requerido" });
    const errores = validarPlantilla(b);
    if (errores.length) return res.status(422).json({ error: errores.join('; ') });

    const actual = await db.execute({
      sql: `SELECT * FROM tarea_plantillas WHERE familia_id = ? AND vigente_hasta = '' LIMIT 1`,
      args: [b.familia_id],
    });
    if (!actual.rows.length) return res.status(404).json({ error: "Plantilla no encontrada" });
    const prev = actual.rows[0];

    await db.execute({
      sql: `UPDATE tarea_plantillas SET vigente_hasta = ? WHERE id = ?`,
      args: [hoyISO(), prev.id],
    });

    const centroVersion = await centroCanonico(db, b.centro ?? prev.centro);
    const r = await db.execute({
      sql: `INSERT INTO tarea_plantillas
            (familia_id, version, centro, nombre, instrucciones, bloque, rol_responsable,
             ventana_inicio, ventana_fin, tolerancia_min, tipo_evidencia, evidencia_config,
             criticidad, recurrencia, orden, activa, vigente_desde, vigente_hasta, creado_en)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
      args: [b.familia_id, Number(prev.version) + 1, centroVersion,
             String(b.nombre).trim(), b.instrucciones || '', b.bloque, b.rol_responsable,
             b.ventana_inicio, b.ventana_fin, Number(b.tolerancia_min ?? 30),
             b.tipo_evidencia, b.evidencia_config || '', b.criticidad || 'NORMAL',
             b.recurrencia || '{"tipo":"diaria"}', Number(b.orden || 0),
             b.activa === false ? 0 : 1, hoyISO(), Date.now()],
    });

    await auditar(db, req, {
      tipo_evento: 'PLANTILLA_NUEVA_VERSION', entidad: 'tarea_plantillas',
      entidad_id: r.lastInsertRowid?.toString(), centro: centroVersion,
      payload: { familia_id: b.familia_id, version: Number(prev.version) + 1 },
    });
    return res.status(200).json({ success: true, id: r.lastInsertRowid?.toString() });
  }

  // DELETE: baja lógica. Nunca se borra una fila (§4.1).
  if (req.method === "DELETE") {
    const familia_id = req.query.familia_id || req.body?.familia_id;
    if (!familia_id) return res.status(400).json({ error: "familia_id requerido" });

    await db.execute({
      sql: `UPDATE tarea_plantillas SET activa = 0 WHERE familia_id = ? AND vigente_hasta = ''`,
      args: [familia_id],
    });
    await auditar(db, req, {
      tipo_evento: 'PLANTILLA_BAJA', entidad: 'tarea_plantillas',
      entidad_id: familia_id, payload: { familia_id },
    });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}

// Tope defensivo del tamaño de foto que aceptamos (el cliente reescala antes
// de enviar). Evita reventar la fila de la base de datos.
const MAX_FOTO_B64 = 700 * 1024;

// Tope de tareas que se listan al decir qué queda. El texto viaja como pie de
// foto cuando la tarea lleva evidencia, y Telegram corta el pie a 1024.
const MAX_RESTANTES = 6;

/**
 * Cómo va la jornada: cuántas van y qué queda por hacer. Se cuelga del aviso
 * de cada tarea completada porque una tarea suelta no dice si el turno va
 * sobrado o va justo — que es lo que de verdad se quiere saber al leerlo.
 */
async function comoVaElDia(db, centro, fechaOperativa) {
  const r = await db.execute({
    sql: `SELECT i.estado, p.nombre, p.criticidad
          FROM tarea_instancias i
          JOIN tarea_plantillas p ON p.id = i.plantilla_version_id
          WHERE LOWER(TRIM(COALESCE(i.centro,''))) = LOWER(TRIM(?))
            AND i.fecha_operativa = ?
          ORDER BY i.ventana_fin_ts ASC`,
    args: [centro, fechaOperativa],
  });
  if (!r.rows.length) return '';

  const total = r.rows.length;
  const hechas = r.rows.filter(x => x.estado === 'COMPLETADA' || x.estado === 'COMPLETADA_TARDIA').length;
  const restantes = r.rows.filter(x => x.estado === 'PENDIENTE' || x.estado === 'VENCIDA');
  if (!restantes.length) return `\n🎉 Van ${hechas}/${total} — no queda ninguna.`;

  // Las bloqueantes y las ya vencidas primero: si hay que cortar la lista, que
  // lo que se pierda sea lo que menos corre prisa.
  const orden = t => (t.estado === 'VENCIDA' ? 0 : 1) + (t.criticidad === 'BLOQUEANTE' ? 0 : 2);
  const lineas = [...restantes].sort((a, b) => orden(a) - orden(b))
    .slice(0, MAX_RESTANTES)
    .map(x => `${x.estado === 'VENCIDA' ? '⏰' : '⏳'} ${escTelegram(x.nombre)}`
      + (x.criticidad === 'BLOQUEANTE' ? ' (bloqueante)' : '')
      + (x.estado === 'VENCIDA' ? ' — vencida' : ''));
  const resto = restantes.length - lineas.length;
  if (resto > 0) lineas.push(`…y ${resto} más`);

  return `\nVan ${hechas}/${total} — quedan ${restantes.length}:\n${lineas.join('\n')}`;
}

async function listar(db, centro, fechaOperativa) {
  const r = await db.execute({
    sql: `SELECT i.id, i.plantilla_version_id, i.familia_id, i.centro, i.fecha_operativa,
                 i.ventana_inicio_ts, i.ventana_fin_ts, i.tolerancia_min, i.estado,
                 i.rol_responsable, i.completada_por, i.completada_ts_servidor,
                 i.fuera_de_plazo, i.flag_rafaga, i.sincronizada_offline,
                 i.evidencia_id, i.nota, i.motivo_no_aplica, i.origen,
                 p.nombre, p.instrucciones, p.bloque, p.criticidad,
                 p.tipo_evidencia, p.evidencia_config, p.orden,
                 p.ventana_inicio, p.ventana_fin, p.version
          FROM tarea_instancias i
          JOIN tarea_plantillas p ON p.id = i.plantilla_version_id
          WHERE LOWER(TRIM(COALESCE(i.centro,''))) = LOWER(TRIM(?))
            AND i.fecha_operativa = ?
          ORDER BY p.bloque ASC, p.orden ASC, i.ventana_inicio_ts ASC`,
    args: [centro, fechaOperativa],
  });
  return r.rows;
}

function validarEvidencia(tipo, cfgRaw, body) {
  const necesitaFoto = tipo === 'FOTO' || tipo === 'FOTO+NUMERO';
  const necesitaNumero = tipo === 'NUMERO' || tipo === 'FOTO+NUMERO';

  if (necesitaFoto && !body.foto_b64) return { error: 'Esta tarea requiere una foto' };
  if (necesitaNumero && (body.valor_numerico === undefined || body.valor_numerico === null || body.valor_numerico === '')) {
    return { error: 'Esta tarea requiere un valor numérico' };
  }
  if (tipo === 'TEXTO' && !String(body.texto || '').trim()) {
    return { error: 'Esta tarea requiere una anotación' };
  }
  if (body.foto_b64 && String(body.foto_b64).length > MAX_FOTO_B64) {
    return { error: 'La foto es demasiado grande' };
  }

  let fueraRango = false;
  let cfg = {};
  if (necesitaNumero) {
    try { cfg = JSON.parse(cfgRaw || '{}'); } catch { cfg = {}; }
    const v = Number(body.valor_numerico);
    if (Number.isNaN(v)) return { error: 'El valor numérico no es válido' };
    if (cfg.min !== undefined && v < Number(cfg.min)) fueraRango = true;
    if (cfg.max !== undefined && v > Number(cfg.max)) fueraRango = true;
  }
  return { fueraRango, cfg };
}

export default async function handler(req, res) {
  try {
    const db = getDbClient();
    await initSchema(db);

    if (req.query.modulo === 'plantillas') {
      return await handlerPlantillas(req, res, db);
    }

    // ── Imagen de una evidencia ───────────────────────────────
    // No es un bucket público: exige token de encargado/gerencia y queda
    // registrado quién la consulta (§4.5, §11.7).
    if (req.method === "GET" && req.query.recurso === 'evidencia') {
      if (!esEncargadoOSuperior(req)) {
        return res.status(403).json({ error: "No autorizado" });
      }

      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "id requerido" });

      const r = await db.execute({
        sql: `SELECT id, tarea_instancia_id, tipo, archivo_b64, mime, hash_sha256, sospechosa, ts_servidor
              FROM evidencias WHERE id = ?`,
        args: [id],
      });
      if (!r.rows.length) return res.status(404).json({ error: "Evidencia no encontrada" });

      const ev = r.rows[0];
      if (!ev.archivo_b64) return res.status(404).json({ error: "Esta evidencia no tiene imagen" });

      await auditar(db, req, {
        tipo_evento: 'EVIDENCIA_CONSULTADA', entidad: 'evidencias', entidad_id: ev.id,
        payload: { tarea_instancia_id: ev.tarea_instancia_id },
      });

      const limpio = String(ev.archivo_b64).replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(limpio, 'base64');

      res.setHeader('Content-Type', ev.mime || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.status(200).send(buf);
    }

    // ── Lista de evidencias con foto, para revisarlas desde el panel ──
    // Solo metadatos: la imagen se pide aparte, una a una, con el mismo
    // recurso de arriba. Bajar todas las fotos en una lista sería repetir el
    // error que ya nos costó caro con los fichajes.
    if (req.method === "GET" && req.query.recurso === 'evidencias') {
      if (!esEncargadoOSuperior(req)) {
        return res.status(403).json({ error: "No autorizado" });
      }
      const { centro: centroLista, desde, hasta } = req.query;
      if (!centroLista || !desde) {
        return res.status(400).json({ error: "Centro y fecha desde son requeridos" });
      }

      const r = await db.execute({
        sql: `SELECT e.id, e.origen_captura, e.sospechosa, e.ts_servidor,
                     i.fecha_operativa, i.completada_por AS empleado,
                     p.nombre AS tarea
              FROM evidencias e
              JOIN tarea_instancias i ON i.id = e.tarea_instancia_id
              JOIN tarea_plantillas p ON p.id = i.plantilla_version_id
              WHERE LOWER(TRIM(COALESCE(i.centro,''))) = LOWER(TRIM(?))
                AND i.fecha_operativa BETWEEN ? AND ?
                AND e.archivo_b64 IS NOT NULL
              ORDER BY e.ts_servidor DESC
              LIMIT 300`,
        args: [centroLista, desde, hasta || desde],
      });
      return res.status(200).json({ evidencias: r.rows });
    }

    // ── Resumen de varios días, para el panel ──────────────────
    // Solo lectura: no genera instancias ni marca vencidas (eso ya lo hace la
    // visita normal del día). Un día sin instancias generadas simplemente sale
    // sin tareas — no vale la pena escribir en la base para "revisar" un día
    // que ya pasó y que, si el bar estuvo abierto, ya se visitó por su cuenta.
    if (req.method === "GET" && req.query.resumen === 'semana') {
      const centro = req.query.centro;
      const desde = req.query.desde;
      const hasta = req.query.hasta || desde;
      if (!centro || !desde) {
        return res.status(400).json({ error: "Centro y fecha desde son requeridos" });
      }

      const r = await db.execute({
        sql: `SELECT i.fecha_operativa, i.estado, i.completada_por, i.completada_ts_servidor,
                     i.fuera_de_plazo, p.nombre, p.criticidad, p.bloque, p.rol_responsable
              FROM tarea_instancias i
              JOIN tarea_plantillas p ON p.id = i.plantilla_version_id
              WHERE LOWER(TRIM(COALESCE(i.centro,''))) = LOWER(TRIM(?))
                AND i.fecha_operativa BETWEEN ? AND ?
              ORDER BY i.fecha_operativa ASC, p.bloque ASC, p.orden ASC`,
        args: [centro, desde, hasta],
      });

      const porDia = {};
      for (const t of r.rows) {
        const dia = (porDia[t.fecha_operativa] ||= {
          fecha: t.fecha_operativa, total: 0, completadas: 0, tardias: 0,
          bloqueantes_pendientes: 0, tareas: [],
        });
        dia.total++;
        if (t.estado === 'COMPLETADA' || t.estado === 'COMPLETADA_TARDIA') dia.completadas++;
        if (t.estado === 'COMPLETADA_TARDIA') dia.tardias++;
        if (t.criticidad === 'BLOQUEANTE' && (t.estado === 'PENDIENTE' || t.estado === 'VENCIDA')) {
          dia.bloqueantes_pendientes++;
        }
        dia.tareas.push({
          nombre: t.nombre, bloque: t.bloque, criticidad: t.criticidad,
          rol_responsable: t.rol_responsable, estado: t.estado,
          completada_por: t.completada_por, completada_ts: t.completada_ts_servidor,
          fuera_de_plazo: !!t.fuera_de_plazo,
        });
      }

      return res.status(200).json({ dias: Object.values(porDia) });
    }

    // ── Lista de tareas del día ───────────────────────────────
    if (req.method === "GET") {
      res.setHeader('Cache-Control', 'no-store');
      const centro = req.query.centro;
      if (!centro) return res.status(400).json({ error: "Centro requerido" });

      const cfg = await getCentroCfg(db, centro);
      const fechaOperativa = req.query.fecha_operativa || fechaOperativaDe(Date.now(), cfg);

      await generarInstancias(db, centro, fechaOperativa, cfg);
      await marcarVencidas(db, centro, fechaOperativa);
      await purgarFotosCaducadas(db); // retención de 90 días (§11.5)
      const tareas = await listar(db, centro, fechaOperativa);

      const total = tareas.length;
      const hechas = tareas.filter(t => t.estado === 'COMPLETADA' || t.estado === 'COMPLETADA_TARDIA').length;
      const bloqueantesPendientes = tareas.filter(t =>
        t.criticidad === 'BLOQUEANTE' && (t.estado === 'PENDIENTE' || t.estado === 'VENCIDA')).length;

      return res.status(200).json({
        centro,
        fecha_operativa: fechaOperativa,
        inicio_jornada: cfg.inicio_jornada,
        ahora: Date.now(),
        resumen: { total, completadas: hechas, bloqueantes_pendientes: bloqueantesPendientes },
        tareas,
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const accion = req.query.accion || 'completar';
    const b = req.body || {};

    // Registro de la salida con tareas pendientes (§6.3). La salida NUNCA se
    // bloquea: se deja constancia y se avisa al encargado.
    if (accion === 'evento-salida') {
      await auditar(db, req, {
        tipo_evento: 'SALIDA_CON_TAREAS_PENDIENTES', entidad: 'fichajes',
        empleado: b.empleado || '', centro: b.centro || '', device_id: b.device_id,
        payload: { pendientes: b.pendientes || [], total: (b.pendientes || []).length },
      });
      return res.status(200).json({ success: true });
    }

    const instanciaId = b.instancia_id;
    if (!instanciaId) return res.status(400).json({ error: "instancia_id requerido" });

    const insR = await db.execute({
      sql: `SELECT i.*, p.nombre, p.tipo_evidencia, p.evidencia_config, p.criticidad, p.familia_id AS fam
            FROM tarea_instancias i
            JOIN tarea_plantillas p ON p.id = i.plantilla_version_id
            WHERE i.id = ?`,
      args: [instanciaId],
    });
    if (!insR.rows.length) return res.status(404).json({ error: "Tarea no encontrada" });
    const t = insR.rows[0];
    const centro = t.centro;

    // ── NO APLICA (encargado+) ────────────────────────────────
    if (accion === 'no-aplica') {
      if (!esEncargadoOSuperior(req)) return res.status(403).json({ error: "Solo el encargado puede marcar No aplica" });
      const motivo = String(b.motivo || '').trim();
      if (!motivo) return res.status(422).json({ error: "El motivo es obligatorio" });

      await db.execute({
        sql: `UPDATE tarea_instancias SET estado = 'NO_APLICA', motivo_no_aplica = ?, completada_por = ?, completada_ts_servidor = ? WHERE id = ?`,
        args: [motivo, b.empleado || '', Date.now(), instanciaId],
      });
      await auditar(db, req, {
        tipo_evento: 'TAREA_NO_APLICA', entidad: 'tarea_instancias', entidad_id: instanciaId,
        empleado: b.empleado || '', centro, device_id: b.device_id,
        payload: { motivo, estado_anterior: t.estado },
      });
      return res.status(200).json({ success: true, estado: 'NO_APLICA' });
    }

    // ── REABRIR (encargado+) ──────────────────────────────────
    if (accion === 'reabrir') {
      if (!esEncargadoOSuperior(req)) return res.status(403).json({ error: "Solo el encargado puede reabrir una tarea" });
      const motivo = String(b.motivo || '').trim();
      if (!motivo) return res.status(422).json({ error: "El motivo es obligatorio" });
      if (!['COMPLETADA', 'COMPLETADA_TARDIA', 'NO_APLICA'].includes(t.estado)) {
        return res.status(409).json({ error: "Solo se puede reabrir una tarea cerrada" });
      }

      await db.execute({
        sql: `UPDATE tarea_instancias
              SET estado = 'PENDIENTE', completada_por = '', completada_ts_servidor = NULL,
                  completada_ts_cliente = NULL, fuera_de_plazo = 0, evidencia_id = NULL,
                  motivo_no_aplica = '', idempotency_key = ''
              WHERE id = ?`,
        args: [instanciaId],
      });
      await auditar(db, req, {
        tipo_evento: 'TAREA_REABIERTA', entidad: 'tarea_instancias', entidad_id: instanciaId,
        empleado: b.empleado || '', centro, device_id: b.device_id,
        payload: { motivo, estado_anterior: t.estado, completada_por_anterior: t.completada_por },
      });
      return res.status(200).json({ success: true, estado: 'PENDIENTE' });
    }

    // ── COMPLETAR ─────────────────────────────────────────────
    if (accion !== 'completar') return res.status(400).json({ error: "Acción no soportada" });

    const empleado = String(b.empleado || '').trim();
    const idem = String(b.idempotency_key || '').trim();

    // Reintento del mismo envío: no duplica ni vuelve a auditar (§12).
    if (idem && t.idempotency_key === idem) {
      return res.status(200).json({ success: true, estado: t.estado, repetido: true });
    }

    // Con sesión iniciada en el móvil no hace falta teclear el PIN otra vez:
    // el testigo ya dice quién es, y lo firmó el servidor.
    const pin = await verificarPin(db, empleado, b.pin, b.sesion || req.headers['x-sesion'] || '');
    if (!pin.ok) return res.status(403).json({ error: pin.motivo });

    // §6.6 — con PIN asignado (modo estricto) hay que tener turno abierto: es lo
    // que impide marcar desde casa. Sin PIN (modo simple) no se bloquea, pero
    // queda anotado en la auditoría para que el encargado lo vea.
    const conTurno = await turnoAbierto(db, empleado, centro);
    if (!conTurno && !pin.sinPin) {
      return res.status(403).json({ error: "Debes fichar tu entrada para registrar tareas" });
    }

    if (t.estado === 'COMPLETADA' || t.estado === 'COMPLETADA_TARDIA') {
      return res.status(409).json({ error: "Esta tarea ya está completada", estado: t.estado });
    }
    if (t.estado === 'NO_APLICA') {
      return res.status(409).json({ error: "Esta tarea está marcada como No aplica" });
    }

    const ahora = Date.now();
    const inicioTs = Number(t.ventana_inicio_ts);
    const finTs = Number(t.ventana_fin_ts);
    const limite = finTs + Number(t.tolerancia_min || 30) * 60000;

    // Una tarea se puede registrar a cualquier hora: en un local no siempre da
    // tiempo a marcarla dentro de su franja y bloquearlo solo consigue que se
    // quede sin registrar. Lo que sí se conserva es CUÁNDO se hizo respecto a
    // su ventana, que es la información que sirve para revisar después.
    let estadoFinal = 'COMPLETADA';
    let momento = 'en_ventana';
    if (ahora < inicioTs) {
      momento = 'antes_de_tiempo';
    } else if (ahora > limite) {
      momento = 'vencida';
      estadoFinal = 'COMPLETADA_TARDIA';
    } else if (ahora > finTs) {
      momento = 'en_tolerancia';
    }
    const fueraDePlazo = momento !== 'en_ventana';

    // Evidencia
    const val = validarEvidencia(t.tipo_evidencia, t.evidencia_config, b);
    if (val.error) return res.status(422).json({ error: val.error });

    // El código del bar ya no es obligatorio para completar una tarea con
    // foto (a diferencia de fichar entrada/salida, que sí lo exige): la
    // prueba de presencia que de verdad importa aquí es el turno abierto
    // (arriba), no forzar a leer un código para cada foto. Si de todas
    // formas llega uno válido —por ejemplo, quien lo hace justo después de
    // fichar y todavía lo tiene guardado— se registra igual, es información
    // extra y no cuesta nada guardarla.
    const llevaFoto = t.tipo_evidencia === 'FOTO' || t.tipo_evidencia === 'FOTO+NUMERO';
    const cfgCentro = await getCentroCfg(db, centro);
    const desdeElIpad = esDispositivoConfianza(req, cfgCentro);

    let ventanaQrTarea = null;
    if (llevaFoto && hayQrConfigurado() && !desdeElIpad && b.qr) {
      const v = validarTokenQr(centro, b.qr);
      if (v.ok) ventanaQrTarea = v.ventana;
    }

    let evidenciaId = null;
    if (t.tipo_evidencia !== 'CHECK') {
      let hash = '';
      let sospechosa = 0;
      let origen = '';

      if (b.foto_b64) {
        hash = hashArchivo(b.foto_b64);

        // Foto reutilizada: mismo hash en la misma familia de tarea (§8.4).
        const dup = await db.execute({
          sql: `SELECT id FROM evidencias
                WHERE familia_id = ? AND hash_sha256 = ?
                ORDER BY id DESC LIMIT ?`,
          args: [t.fam, hash, HASH_LOOKBACK],
        });
        if (dup.rows.length) {
          await auditar(db, req, {
            tipo_evento: 'FOTO_DUPLICADA_RECHAZADA', entidad: 'tarea_instancias',
            entidad_id: instanciaId, empleado, centro, device_id: b.device_id,
            payload: { hash },
          });
          return res.status(409).json({ error: "Esa foto ya se había subido antes para esta tarea. Haz una nueva." });
        }

        // El origen lo fija el servidor con lo que puede comprobar, no con lo
        // que declare el móvil: `lastModified` es trivial de falsear. Ya no
        // es obligatorio traer un código para que cuente como normal —eso
        // se quitó arriba—, así que "sin código" ya no se marca como
        // sospechoso: es el camino esperado ahora, no una señal de nada raro.
        origen = ventanaQrTarea !== null ? 'camara_en_local'
          : desdeElIpad ? 'ipad_local'
          : 'movil';
      }

      const ev = await db.execute({
        sql: `INSERT INTO evidencias
              (tarea_instancia_id, familia_id, tipo, valor_numerico, unidad, texto,
               archivo_b64, mime, hash_sha256, origen_captura, sospechosa, device_id, ts_servidor, metadatos)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [instanciaId, t.fam, t.tipo_evidencia,
               b.valor_numerico !== undefined && b.valor_numerico !== '' ? Number(b.valor_numerico) : null,
               (val.cfg && val.cfg.unidad) || '', String(b.texto || ''),
               b.foto_b64 || null, b.mime || 'image/jpeg', hash,
               origen, sospechosa, b.device_id || '', ahora,
               JSON.stringify({ fuera_rango: !!val.fueraRango, qr_ventana: ventanaQrTarea })],
      });
      evidenciaId = ev.lastInsertRowid ? Number(ev.lastInsertRowid) : null;
    }

    // Ráfaga: muchas tareas seguidas en pocos minutos (§8.3). Se señala, no se bloquea.
    const desdeRafaga = ahora - RAFAGA_MIN * 60000;
    const recientes = await db.execute({
      sql: `SELECT id FROM tarea_instancias
            WHERE LOWER(TRIM(COALESCE(completada_por,''))) = LOWER(TRIM(?))
              AND LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?))
              AND completada_ts_servidor >= ?`,
      args: [empleado, centro, desdeRafaga],
    });
    const esRafaga = recientes.rows.length + 1 > RAFAGA_N;

    await db.execute({
      sql: `UPDATE tarea_instancias
            SET estado = ?, completada_por = ?, completada_ts_servidor = ?, completada_ts_cliente = ?,
                fuera_de_plazo = ?, evidencia_id = ?, nota = ?, flag_rafaga = ?,
                sincronizada_offline = ?, idempotency_key = ?
            WHERE id = ?`,
      args: [estadoFinal, empleado, ahora, b.ts_cliente ? Number(b.ts_cliente) : null,
             fueraDePlazo ? 1 : 0, evidenciaId, String(b.nota || ''), esRafaga ? 1 : 0,
             b.offline ? 1 : 0, idem, instanciaId],
    });

    if (esRafaga) {
      // Marca también las de la misma ráfaga para que el encargado las vea juntas.
      await db.execute({
        sql: `UPDATE tarea_instancias SET flag_rafaga = 1
              WHERE LOWER(TRIM(COALESCE(completada_por,''))) = LOWER(TRIM(?))
                AND LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?))
                AND completada_ts_servidor >= ?`,
        args: [empleado, centro, desdeRafaga],
      });
      await auditar(db, req, {
        tipo_evento: 'RAFAGA_DETECTADA', entidad: 'tarea_instancias', entidad_id: instanciaId,
        empleado, centro, device_id: b.device_id,
        payload: { tareas_en_ventana: recientes.rows.length + 1, minutos: RAFAGA_MIN },
      });
    }

    if (val.fueraRango) {
      await auditar(db, req, {
        tipo_evento: 'VALOR_FUERA_DE_RANGO', entidad: 'tarea_instancias', entidad_id: instanciaId,
        empleado, centro, device_id: b.device_id,
        payload: { valor: b.valor_numerico, config: t.evidencia_config, tarea: t.nombre },
      });
    }

    const enDescanso = await estaEnDescanso(db, empleado, centro);
    await auditar(db, req, {
      tipo_evento: 'TAREA_COMPLETADA', entidad: 'tarea_instancias', entidad_id: instanciaId,
      empleado, centro, device_id: b.device_id,
      payload: {
        estado: estadoFinal, tarea: t.nombre, fuera_de_plazo: fueraDePlazo,
        rol_tarea: t.rol_responsable, en_descanso: enDescanso,
        offline: !!b.offline, ts_cliente: b.ts_cliente || null,
        sin_pin: !!pin.sinPin, turno_abierto: conTurno,
        origen_ui: b.origen_ui || 'tareas', momento,
        ventana: `${t.ventana_inicio || ''}-${t.ventana_fin || ''}`,
      },
    });

    // El aviso de "se ha pasado de plazo" ya existía (marcarVencidas); este es
    // el complemento — que se sepa también cuando SÍ se hace, para poder
    // comparar una cosa con la otra sin tener que entrar a mirar el panel.
    try {
      const horaTexto = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }).format(ahora);
      const texto = conEnlacePanel(
        `✅ <b>${escTelegram(t.nombre)}</b> completada por ${escTelegram(empleado)} a las ${horaTexto}`
        + (fueraDePlazo ? ' — fuera de plazo ⚠️' : '')
        + await comoVaElDia(db, centro, t.fecha_operativa),
        centro
      );

      // Con foto, se manda la propia imagen en vez de solo decir que la hay:
      // así se ve de un vistazo si de verdad está hecha, sin entrar al panel.
      if (b.foto_b64) {
        await avisarTelegramConFoto(texto, b.foto_b64, b.mime || 'image/jpeg');
      } else {
        await avisarTelegram(texto);
      }
    } catch {}

    return res.status(200).json({
      success: true,
      estado: estadoFinal,
      momento,
      fuera_de_plazo: fueraDePlazo,
      flag_rafaga: esRafaga,
      aviso: val.fueraRango ? 'El valor está fuera del rango esperado: avisa al encargado' : undefined,
    });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}
