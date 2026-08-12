import { getDbClient } from "./db.js";
import { initSchema, esEncargadoOSuperior, auditar } from "./_tareas-lib.js";

/**
 * Devuelve la imagen de una evidencia. No es un bucket público: exige token de
 * encargado/gerencia y queda registrado quién la consulta (§4.5, §11.7).
 */
export default async function handler(req, res) {
  try {
    const db = getDbClient();
    await initSchema(db);

    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }
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
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}
