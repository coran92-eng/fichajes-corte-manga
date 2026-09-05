import { getDbClient } from "./_db.js";
import { initSchema, getCentroCfg, fechaOperativaDe } from "./_tareas-lib.js";
import { avisarTelegram, escTelegram, hayTelegramConfigurado, conEnlacePanel } from "./_telegram.js";

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Resumen de ayer, una vez al día. Lo dispara el cron de Vercel (vercel.json);
 * nadie más debería poder llamarlo, así que exige el secreto que Vercel
 * manda solo. Sin él configurado, se acepta igualmente para no romper el cron
 * en el primer despliegue —hay un aviso en los logs, no un 401 a ciegas.
 */
export default async function handler(req, res) {
  const secreto = process.env.CRON_SECRET;
  if (secreto && req.headers.authorization !== `Bearer ${secreto}`) {
    return res.status(401).json({ error: "No autorizado" });
  }

  if (!hayTelegramConfigurado()) {
    return res.status(200).json({ ok: true, aviso: "Telegram no configurado: nada que mandar" });
  }

  try {
    const db = getDbClient();
    await initSchema(db);

    // Un resumen por centro: cada uno tiene su propia jornada operativa.
    const centros = await db.execute("SELECT centro FROM centros_cfg");

    for (const { centro } of centros.rows) {
      const cfg = await getCentroCfg(db, centro);
      const ayer = fechaOperativaDe(Date.now() - DIA_MS, cfg);

      const r = await db.execute({
        sql: `SELECT i.estado, p.nombre, p.criticidad
              FROM tarea_instancias i
              JOIN tarea_plantillas p ON p.id = i.plantilla_version_id
              WHERE LOWER(TRIM(COALESCE(i.centro,''))) = LOWER(TRIM(?))
                AND i.fecha_operativa = ?`,
        args: [centro, ayer],
      });
      // Nada configurado ese día: no hay nada que resumir, y no vale la pena
      // avisar de un centro que ni siquiera tiene tareas dadas de alta.
      if (!r.rows.length) continue;

      const total = r.rows.length;
      const completadas = r.rows.filter(t => t.estado === 'COMPLETADA' || t.estado === 'COMPLETADA_TARDIA').length;
      const tardias = r.rows.filter(t => t.estado === 'COMPLETADA_TARDIA').length;
      const sinHacer = r.rows.filter(t => t.estado === 'PENDIENTE' || t.estado === 'VENCIDA');
      const bloqueantesSinHacer = sinHacer.filter(t => t.criticidad === 'BLOQUEANTE');
      const normalesSinHacer = sinHacer.filter(t => t.criticidad !== 'BLOQUEANTE');

      const lineas = [
        `📋 <b>Resumen de ayer</b> (${ayer}) — ${escTelegram(centro)}`,
        `${completadas}/${total} tareas hechas${tardias ? `, ${tardias} tarde` : ''}`,
      ];
      if (bloqueantesSinHacer.length) {
        lineas.push(`🔴 Sin hacer, bloqueante: ${bloqueantesSinHacer.map(t => escTelegram(t.nombre)).join(', ')}`);
      }
      if (normalesSinHacer.length) {
        lineas.push(`⚠️ Sin hacer: ${normalesSinHacer.map(t => escTelegram(t.nombre)).join(', ')}`);
      }
      if (!sinHacer.length && !tardias) lineas.push('✅ Todo en orden.');

      await avisarTelegram(conEnlacePanel(lineas.join('\n'), centro));
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}
