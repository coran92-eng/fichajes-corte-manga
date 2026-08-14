import { getDbClient } from "./db.js";
import {
  initSchema, getCentroCfg, ipDeReq, huellaRed, esRedAutorizada,
  auditar, esEncargadoOSuperior,
} from "./_tareas-lib.js";

/**
 * Redes desde las que se permite fichar en cada centro.
 *
 * La idea es que no haya que tocar configuración técnica: se abre esta pantalla
 * ESTANDO EN EL LOCAL y se pulsa "autorizar esta red". El día que el operador
 * cambie la IP, se vuelve a pulsar y listo.
 */
export default async function handler(req, res) {
  try {
    const db = getDbClient();
    await initSchema(db);

    const centro = req.query.centro || req.body?.centro || '';

    // Consulta: desde qué red se está entrando y cuáles están autorizadas.
    if (req.method === "GET") {
      res.setHeader('Cache-Control', 'no-store');
      const cfg = centro ? await getCentroCfg(db, centro) : { ips_autorizadas: '' };
      const red = esRedAutorizada(req, cfg);

      return res.status(200).json({
        centro,
        red_actual: huellaRed(ipDeReq(req)),
        autorizadas: String(cfg.ips_autorizadas || '').split(',').map(x => x.trim()).filter(Boolean),
        estas_dentro: red.permitido && !red.sinConfigurar,
        sin_configurar: !!red.sinConfigurar,
      });
    }

    if (!esEncargadoOSuperior(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }
    if (!centro) return res.status(400).json({ error: "Centro requerido" });

    const cfg = await getCentroCfg(db, centro);
    const actuales = String(cfg.ips_autorizadas || '').split(',').map(x => x.trim()).filter(Boolean);

    // Autorizar la red desde la que se está llamando
    if (req.method === "POST") {
      const red = huellaRed(ipDeReq(req));
      if (!red) return res.status(422).json({ error: "No se ha podido identificar la red" });
      if (actuales.includes(red)) {
        return res.status(200).json({ success: true, ya_estaba: true, red });
      }

      const nuevas = [...actuales, red];
      await db.execute({
        sql: "UPDATE centros_cfg SET ips_autorizadas = ? WHERE LOWER(TRIM(centro)) = LOWER(TRIM(?))",
        args: [nuevas.join(','), centro],
      });
      await auditar(db, req, {
        tipo_evento: 'RED_AUTORIZADA', entidad: 'centros_cfg', entidad_id: centro,
        centro, payload: { red, total: nuevas.length },
      });
      return res.status(201).json({ success: true, red, autorizadas: nuevas });
    }

    // Quitar una red de la lista
    if (req.method === "DELETE") {
      const red = req.query.red || req.body?.red;
      if (!red) return res.status(400).json({ error: "Red requerida" });

      const nuevas = actuales.filter(x => x !== red);
      await db.execute({
        sql: "UPDATE centros_cfg SET ips_autorizadas = ? WHERE LOWER(TRIM(centro)) = LOWER(TRIM(?))",
        args: [nuevas.join(','), centro],
      });
      await auditar(db, req, {
        tipo_evento: 'RED_RETIRADA', entidad: 'centros_cfg', entidad_id: centro,
        centro, payload: { red, quedan: nuevas.length },
      });
      return res.status(200).json({ success: true, autorizadas: nuevas });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}
