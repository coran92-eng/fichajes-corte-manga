import { getDbClient } from "./_db.js";
import {
  initSchema, getCentroCfg, fechaOperativaDe, auditar, hashArchivo,
  esEncargadoOSuperior,
} from "./_tareas-lib.js";

const MAX_FOTO_B64 = 700 * 1024;
const PRIORIDADES = ['baja', 'normal', 'alta'];
const ESTADOS_INC = ['abierta', 'en_curso', 'resuelta'];
// nota      → información para el turno siguiente
// incidencia→ algo roto o averiado, hasta que se arregla
// falta     → producto agotado, hasta que se repone (alimenta el pedido)
const TIPOS = ['nota', 'incidencia', 'falta'];

async function initNotas(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS turno_notas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      centro TEXT NOT NULL DEFAULT '',
      fecha_operativa TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'nota',
      texto TEXT NOT NULL,
      autor TEXT NOT NULL DEFAULT '',
      prioridad TEXT NOT NULL DEFAULT 'normal',
      estado TEXT NOT NULL DEFAULT '',
      resuelto_por TEXT NOT NULL DEFAULT '',
      resuelto_en INTEGER,
      resolucion TEXT NOT NULL DEFAULT '',
      foto_b64 TEXT,
      hash_sha256 TEXT NOT NULL DEFAULT '',
      device_id TEXT NOT NULL DEFAULT '',
      creado_en INTEGER NOT NULL
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_notas_centro_fecha ON turno_notas (centro, fecha_operativa)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_notas_estado ON turno_notas (centro, tipo, estado)`);

  // A quién va dirigida la nota. El parte del turno es para el relevo —"se ha
  // acabado el vermut", "la nevera hace ruido"—, no para que toda la plantilla
  // lea a qué hora entró o salió cada compañero.
  try { await db.execute("ALTER TABLE turno_notas ADD COLUMN visibilidad TEXT NOT NULL DEFAULT 'equipo'"); } catch {}

  // Las que ya se publicaron por error dejan de verse en el iPad. No se
  // borran: el dato sigue estando, solo cambia quién lo ve.
  try {
    await db.execute(`
      UPDATE turno_notas SET visibilidad = 'gerencia'
      WHERE visibilidad <> 'gerencia' AND TRIM(autor) = 'Sistema' AND (
            texto LIKE 'Salida anticipada autorizada%'
         OR texto LIKE 'Entrada anticipada autorizada%'
         OR texto LIKE 'Salida más tarde de la hora%'
         OR texto LIKE 'Fichaje autorizado fuera del local%')
    `);
  } catch {}

  // Acuse de lectura: quién del turno siguiente lo ha visto.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS turno_notas_vistos (
      nota_id INTEGER NOT NULL,
      empleado TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (nota_id, empleado)
    )
  `);
}

export default async function handler(req, res) {
  try {
    const db = getDbClient();
    await initSchema(db);
    await initNotas(db);

    // ── Lectura ───────────────────────────────────────────────
    if (req.method === "GET") {
      res.setHeader('Cache-Control', 'no-store');

      // Foto de una nota o incidencia concreta
      if (req.query.foto) {
        const f = await db.execute({
          sql: "SELECT foto_b64 FROM turno_notas WHERE id = ?",
          args: [req.query.foto],
        });
        if (!f.rows.length || !f.rows[0].foto_b64) return res.status(404).json({ error: "Sin foto" });
        const buf = Buffer.from(String(f.rows[0].foto_b64).replace(/^data:[^;]+;base64,/, ''), 'base64');
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=300');
        return res.status(200).send(buf);
      }

      const centro = req.query.centro;
      if (!centro) return res.status(400).json({ error: "Centro requerido" });

      const cfg = await getCentroCfg(db, centro);
      const fechaOperativa = req.query.fecha_operativa || fechaOperativaDe(Date.now(), cfg);
      const dias = Math.min(Number(req.query.dias || 2), 14);

      // La pantalla de fichaje del local no lleva token: ve solo lo del
      // equipo. Las de encargado y gerencia ven además lo suyo.
      const verTodo = esEncargadoOSuperior(req) ? 1 : 0;

      // Notas: las de la jornada pedida y las de los días anteriores que se
      // indiquen, para que el turno entrante vea lo que dejó el saliente.
      const notas = await db.execute({
        sql: `SELECT id, centro, fecha_operativa, tipo, texto, autor, prioridad, estado,
                     resuelto_por, resuelto_en, resolucion, hash_sha256, creado_en,
                     CASE WHEN foto_b64 IS NULL THEN 0 ELSE 1 END AS tiene_foto
              FROM turno_notas
              WHERE centro = ? AND tipo = 'nota' AND fecha_operativa >= date(?, ?)
                AND (COALESCE(visibilidad,'equipo') = 'equipo' OR ? = 1)
              ORDER BY creado_en DESC LIMIT 40`,
        args: [centro, fechaOperativa, `-${dias} day`, verTodo],
      });

      // Averías y faltas: las abiertas siguen visibles aunque sean de días
      // anteriores; una nevera rota o un producto agotado no dejan de existir
      // porque cambie la jornada.
      const pendientes = await db.execute({
        sql: `SELECT id, centro, fecha_operativa, tipo, texto, autor, prioridad, estado,
                     resuelto_por, resuelto_en, resolucion, hash_sha256, creado_en,
                     CASE WHEN foto_b64 IS NULL THEN 0 ELSE 1 END AS tiene_foto
              FROM turno_notas
              WHERE centro = ? AND tipo IN ('incidencia','falta')
                AND (estado IN ('abierta','en_curso') OR fecha_operativa = ?)
                AND (COALESCE(visibilidad,'equipo') = 'equipo' OR ? = 1)
              ORDER BY CASE prioridad WHEN 'alta' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                       creado_en DESC
              LIMIT 60`,
        args: [centro, fechaOperativa, verTodo],
      });
      const incidencias = pendientes.rows.filter(r => r.tipo === 'incidencia');
      const faltas = pendientes.rows.filter(r => r.tipo === 'falta');

      // Acuses de lectura de las notas mostradas
      const ids = notas.rows.map(n => n.id);
      let vistos = {};
      if (ids.length) {
        const v = await db.execute({
          sql: `SELECT nota_id, empleado FROM turno_notas_vistos WHERE nota_id IN (${ids.map(() => '?').join(',')})`,
          args: ids,
        });
        v.rows.forEach(r => {
          (vistos[r.nota_id] = vistos[r.nota_id] || []).push(r.empleado);
        });
      }

      return res.status(200).json({
        centro,
        fecha_operativa: fechaOperativa,
        notas: notas.rows.map(n => ({ ...n, vistos: vistos[n.id] || [] })),
        incidencias,
        faltas,
        abiertas: incidencias.filter(i => i.estado !== 'resuelta').length,
        faltan: faltas.filter(f => f.estado !== 'resuelta').length,
      });
    }

    // ── Crear nota o incidencia ───────────────────────────────
    if (req.method === "POST") {
      const b = req.body || {};
      const centro = b.centro;
      const texto = String(b.texto || '').trim();
      const tipo = TIPOS.includes(b.tipo) ? b.tipo : 'nota';

      if (!centro) return res.status(400).json({ error: "Centro requerido" });
      if (!texto) return res.status(422).json({ error: "Escribe el aviso" });
      if (texto.length > 1000) return res.status(422).json({ error: "El texto es demasiado largo" });
      if (b.foto_b64 && String(b.foto_b64).length > MAX_FOTO_B64) {
        return res.status(422).json({ error: "La foto es demasiado grande" });
      }

      const cfg = await getCentroCfg(db, centro);
      const fechaOperativa = fechaOperativaDe(Date.now(), cfg);
      const prioridad = PRIORIDADES.includes(b.prioridad) ? b.prioridad : 'normal';

      const r = await db.execute({
        sql: `INSERT INTO turno_notas
              (centro, fecha_operativa, tipo, texto, autor, prioridad, estado,
               foto_b64, hash_sha256, device_id, creado_en)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [centro, fechaOperativa, tipo, texto, b.autor || '', prioridad,
               tipo === 'nota' ? '' : 'abierta',
               b.foto_b64 || null, b.foto_b64 ? hashArchivo(b.foto_b64) : '',
               b.device_id || '', Date.now()],
      });

      await auditar(db, req, {
        tipo_evento: tipo === 'incidencia' ? 'INCIDENCIA_ABIERTA'
                   : tipo === 'falta' ? 'FALTA_PRODUCTO' : 'NOTA_TURNO',
        entidad: 'turno_notas', entidad_id: r.lastInsertRowid?.toString(),
        empleado: b.autor || '', centro, device_id: b.device_id,
        payload: { texto: texto.slice(0, 200), prioridad },
      });

      return res.status(201).json({ success: true, id: r.lastInsertRowid?.toString() });
    }

    // ── Cambiar estado de incidencia / marcar como vista ───────
    if (req.method === "PUT") {
      const b = req.body || {};
      const id = b.id;
      if (!id) return res.status(400).json({ error: "id requerido" });

      // Acuse de lectura de una nota
      if (b.accion === 'visto') {
        const empleado = String(b.empleado || '').trim();
        if (!empleado) return res.status(422).json({ error: "Indica quién la ha leído" });
        await db.execute({
          sql: `INSERT OR IGNORE INTO turno_notas_vistos (nota_id, empleado, ts) VALUES (?, ?, ?)`,
          args: [id, empleado, Date.now()],
        });
        return res.status(200).json({ success: true });
      }

      const estado = b.estado;
      if (!ESTADOS_INC.includes(estado)) {
        return res.status(422).json({ error: "Estado no válido" });
      }

      await db.execute({
        sql: `UPDATE turno_notas
              SET estado = ?, resolucion = ?,
                  resuelto_por = CASE WHEN ? = 'resuelta' THEN ? ELSE resuelto_por END,
                  resuelto_en = CASE WHEN ? = 'resuelta' THEN ? ELSE resuelto_en END
              WHERE id = ? AND tipo IN ('incidencia','falta')`,
        args: [estado, String(b.resolucion || ''), estado, b.empleado || '',
               estado, Date.now(), id],
      });

      await auditar(db, req, {
        tipo_evento: 'INCIDENCIA_ESTADO', entidad: 'turno_notas', entidad_id: id,
        empleado: b.empleado || '', centro: b.centro || '', device_id: b.device_id,
        payload: { estado, resolucion: String(b.resolucion || '').slice(0, 200) },
      });

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}
