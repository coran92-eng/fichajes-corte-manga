import { getDbClient } from "./_db.js";
import {
  initSchema, getCentroCfg, ipDeReq, huellaRed, esRedAutorizada,
  auditar, esEncargadoOSuperior, idDispositivo, esDispositivoConfianza,
  exigirQr, hayDispositivosDeConfianza,
  hayQrConfigurado,
} from "./_tareas-lib.js";

const lista = txt => String(txt || '').split(',').map(x => x.trim()).filter(Boolean);

/**
 * Redes y dispositivos del local.
 *
 * La idea es que no haya que tocar configuración técnica: se abre esta pantalla
 * ESTANDO EN EL LOCAL y se pulsa el botón. El día que el operador cambie la IP,
 * se vuelve a pulsar y listo.
 *
 * Dos cosas distintas conviven aquí:
 *  · Redes autorizadas — desde dónde se puede fichar.
 *  · Dispositivos de confianza — el iPad del bar, exento de leer el código QR
 *    que muestra él mismo. Cualquier otro aparato sí tiene que leerlo.
 */
export default async function handler(req, res) {
  try {
    const db = getDbClient();
    await initSchema(db);

    const centro = req.query.centro || req.body?.centro || '';

    // Consulta: desde qué red se está entrando y cuáles están autorizadas.
    if (req.method === "GET") {
      res.setHeader('Cache-Control', 'no-store');
      const cfg = centro ? await getCentroCfg(db, centro) : { ips_autorizadas: '', dispositivos_confianza: '' };
      const red = esRedAutorizada(req, cfg);

      return res.status(200).json({
        centro,
        red_actual: huellaRed(ipDeReq(req)),
        autorizadas: lista(cfg.ips_autorizadas),
        estas_dentro: red.permitido && !red.sinConfigurar,
        sin_configurar: !!red.sinConfigurar,
        // Estado del código del bar y de este aparato en concreto.
        qr_configurado: hayQrConfigurado(),
        dispositivos: lista(cfg.dispositivos_confianza),
        este_dispositivo: idDispositivo(req),
        es_de_confianza: esDispositivoConfianza(req, cfg),
        // El código no se exige hasta que hay un aparato enseñándolo: tener el
        // secreto puesto no basta. Sin esto el panel diría que hace falta leer
        // un código que nadie está mostrando.
        qr_en_uso: hayQrConfigurado() && hayDispositivosDeConfianza(cfg),
        qr_exigible: exigirQr(req, cfg),
      });
    }

    if (!esEncargadoOSuperior(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }
    if (!centro) return res.status(400).json({ error: "Centro requerido" });

    const cfg = await getCentroCfg(db, centro);
    const actuales = lista(cfg.ips_autorizadas);
    const aparatos = lista(cfg.dispositivos_confianza);

    // ── Dispositivos de confianza ──
    // Se registra el aparato desde el que se llama, y solo desde dentro del
    // local: si se pudiera marcar de confianza un móvil desde casa, el código
    // del bar dejaría de servir para nada.
    if (req.query.recurso === 'dispositivo') {
      const id = idDispositivo(req);

      if (req.method === "POST") {
        if (!id) return res.status(422).json({ error: "Este aparato no tiene identificador" });
        if (!esRedAutorizada(req, cfg).permitido) {
          return res.status(403).json({ error: "Solo se puede marcar de confianza estando en el local" });
        }
        if (aparatos.includes(id)) {
          return res.status(200).json({ success: true, ya_estaba: true, dispositivos: aparatos });
        }
        const nuevos = [...aparatos, id];
        await db.execute({
          sql: "UPDATE centros_cfg SET dispositivos_confianza = ? WHERE LOWER(TRIM(centro)) = LOWER(TRIM(?))",
          args: [nuevos.join(','), centro],
        });
        await auditar(db, req, {
          tipo_evento: 'DISPOSITIVO_DE_CONFIANZA', entidad: 'centros_cfg', entidad_id: centro,
          centro, device_id: id, payload: { total: nuevos.length },
        });
        return res.status(201).json({ success: true, dispositivos: nuevos });
      }

      if (req.method === "DELETE") {
        const quitar = req.query.id || req.body?.id || id;
        if (!quitar) return res.status(400).json({ error: "Dispositivo requerido" });
        const nuevos = aparatos.filter(x => x !== quitar);
        await db.execute({
          sql: "UPDATE centros_cfg SET dispositivos_confianza = ? WHERE LOWER(TRIM(centro)) = LOWER(TRIM(?))",
          args: [nuevos.join(','), centro],
        });
        await auditar(db, req, {
          tipo_evento: 'DISPOSITIVO_RETIRADO', entidad: 'centros_cfg', entidad_id: centro,
          centro, device_id: quitar, payload: { quedan: nuevos.length },
        });
        return res.status(200).json({ success: true, dispositivos: nuevos });
      }
    }

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
