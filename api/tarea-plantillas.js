import { getDbClient } from "./_db.js";
import {
  initSchema, auditar, esEncargadoOSuperior, nivelDesdeReq, centroCanonico,
  BLOQUES, ROLES, TIPOS_EVIDENCIA, CRITICIDADES,
} from "./_tareas-lib.js";

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

function validar(body) {
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

export default async function handler(req, res) {
  try {
    const db = getDbClient();
    await initSchema(db);

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
      const errores = validar(b);
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
              VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '', ?)`,
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
      const errores = validar(b);
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
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}
