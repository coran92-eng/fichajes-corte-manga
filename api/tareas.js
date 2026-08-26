import { getDbClient } from "./_db.js";
import {
  initSchema, getCentroCfg, fechaOperativaDe, resolverVentana, tocaEnFecha,
  verificarPin, turnoAbierto, estaEnDescanso, auditar, esEncargadoOSuperior,
  hashArchivo, purgarFotosCaducadas, RAFAGA_N, RAFAGA_MIN, HASH_LOOKBACK,
  validarTokenQr, esDispositivoConfianza, hayQrConfigurado,
} from "./_tareas-lib.js";

// Tope defensivo del tamaño de foto que aceptamos (el cliente reescala antes
// de enviar). Evita reventar la fila de la base de datos.
const MAX_FOTO_B64 = 700 * 1024;

/** Genera las instancias del día si no existen (§5, generación perezosa). */
async function generarInstancias(db, centro, fechaOperativa, cfg) {
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

/** Marca como VENCIDA lo que pasó de ventana + tolerancia (§4.4, automático). */
async function marcarVencidas(db, centro, fechaOperativa) {
  await db.execute({
    sql: `UPDATE tarea_instancias
          SET estado = 'VENCIDA'
          WHERE centro = ? AND fecha_operativa = ? AND estado = 'PENDIENTE'
            AND (ventana_fin_ts + tolerancia_min * 60000) < ?`,
    args: [centro, fechaOperativa, Date.now()],
  });
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
          WHERE i.centro = ? AND i.fecha_operativa = ?
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
              WHERE i.centro = ? AND i.fecha_operativa BETWEEN ? AND ?
                AND e.archivo_b64 IS NOT NULL
              ORDER BY e.ts_servidor DESC
              LIMIT 300`,
        args: [centroLista, desde, hasta || desde],
      });
      return res.status(200).json({ evidencias: r.rows });
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

    // Las tareas con foto exigen haber leído el código del bar: es lo único que
    // demuestra de verdad que la persona está allí. El navegador no puede
    // impedir que una foto salga de la galería —`capture` es una sugerencia, no
    // una obligación—, así que la prueba de presencia la da el código, no la
    // imagen. El iPad del local está exento por ser dispositivo de confianza.
    //
    // A diferencia de fichar entrada/salida (que usa `exigirQr`, más laxo
    // mientras no haya ningún aparato de confianza, para no dejar a todo el
    // bar sin poder fichar), aquí se exige en cuanto hay QR_SECRET puesto: una
    // tarea con foto sin verificar no bloquea a nadie que necesite entrar a
    // trabajar, así que no hace falta esa misma tolerancia.
    const llevaFoto = t.tipo_evidencia === 'FOTO' || t.tipo_evidencia === 'FOTO+NUMERO';
    const cfgCentro = await getCentroCfg(db, centro);
    const desdeElIpad = esDispositivoConfianza(req, cfgCentro);

    let ventanaQrTarea = null;
    if (llevaFoto && hayQrConfigurado() && !desdeElIpad) {
      const v = validarTokenQr(centro, b.qr);
      if (!v.ok) {
        return res.status(403).json({
          error: v.motivo === 'falta'
            ? "Para hacer esta tarea desde el móvil, lee antes el código de la pantalla del bar"
            : "Ese código ya ha caducado. Vuelve a leer el de la pantalla del bar",
          motivo: "qr",
        });
      }
      ventanaQrTarea = v.ventana;
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
        // que declare el móvil: `lastModified` es trivial de falsear. Lo que
        // cuenta es si la foto llegó con un código del bar recién leído.
        origen = ventanaQrTarea !== null ? 'camara_en_local'
          : desdeElIpad ? 'ipad_local'
          : 'sin_verificar';
        if (origen === 'sin_verificar') sospechosa = 1;
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
            WHERE completada_por = ? AND centro = ? AND completada_ts_servidor >= ?`,
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
              WHERE completada_por = ? AND centro = ? AND completada_ts_servidor >= ?`,
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
