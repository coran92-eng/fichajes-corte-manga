import { getDbClient } from "./_db.js";
import { initSchema, auditar, nivelDesdeReq, esEncargadoOSuperior } from "./_tareas-lib.js";

/**
 * Pedidos a proveedores por WhatsApp.
 *
 * El mensaje y el enlace wa.me se construyen SIEMPRE en el servidor y se
 * guardan con el envío: el histórico tiene que decir exactamente qué texto se
 * mandó, no una reconstrucción posterior que podría no coincidir.
 *
 * El aislamiento por local no puede hacerse con RLS (esto es SQLite, no
 * Postgres), así que se aplica aquí: toda consulta lleva el centro y los
 * productos se validan contra el proveedor y el centro antes de guardar nada.
 */

const UNIDADES = ['kg', 'g', 'uds', 'cajas', 'litros', 'l'];
const E164 = /^\+[1-9]\d{7,14}$/;
const TZ = 'Europe/Madrid';

let listo = false;

async function initPedidos(db) {
  if (listo) return;

  await db.execute(`
    CREATE TABLE IF NOT EXISTS proveedores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      centro TEXT NOT NULL DEFAULT '',
      nombre TEXT NOT NULL,
      telefono_whatsapp TEXT NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      orden INTEGER NOT NULL DEFAULT 0,
      creado_en INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS productos_proveedor (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proveedor_id INTEGER NOT NULL,
      nombre TEXT NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      orden INTEGER NOT NULL DEFAULT 0,
      creado_en INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      centro TEXT NOT NULL DEFAULT '',
      empleado TEXT NOT NULL DEFAULT '',
      fecha_hora INTEGER NOT NULL,
      estado TEXT NOT NULL DEFAULT 'borrador'
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS pedido_envios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      proveedor_id INTEGER NOT NULL,
      mensaje_generado TEXT NOT NULL,
      enlace_wa TEXT NOT NULL,
      enviado INTEGER NOT NULL DEFAULT 0,
      enviado_at INTEGER
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS pedido_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_envio_id INTEGER NOT NULL,
      producto_id INTEGER NOT NULL,
      cantidad REAL NOT NULL,
      unidad TEXT NOT NULL
    )
  `);

  await db.execute("CREATE INDEX IF NOT EXISTS idx_prov_centro ON proveedores (centro, activo, orden)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_prod_prov ON productos_proveedor (proveedor_id, activo, orden)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_pedidos_centro ON pedidos (centro, fecha_hora)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_envios_pedido ON pedido_envios (pedido_id)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_items_envio ON pedido_items (pedido_envio_id)");

  listo = true;
}

/** "1,5" en vez de "1.5"; y sin decimales cuando es entero. */
function formatoCantidad(n) {
  const v = Number(n);
  const txt = Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  return txt.replace('.', ',');
}

/** DD/MM en hora de Madrid. Se arma por partes: es-ES colapsa el mes a un
 *  dígito aunque se pida '2-digit', y el mensaje debe salir siempre igual. */
function fechaCorta(ts) {
  const partes = new Intl.DateTimeFormat('es-ES', {
    timeZone: TZ, day: '2-digit', month: '2-digit',
  }).formatToParts(new Date(ts));
  const de = tipo => (partes.find(p => p.type === tipo)?.value || '').padStart(2, '0');
  return `${de('day')}/${de('month')}`;
}

/** El texto que va a WhatsApp y el enlace, tal cual quedarán guardados. */
function construirMensaje({ centro, lineas, ts }) {
  const cuerpo = lineas
    .map(l => `- ${l.nombre}: ${formatoCantidad(l.cantidad)} ${l.unidad}`)
    .join('\n');
  return `📋 Pedido ${centro} — ${fechaCorta(ts)}\n${cuerpo}\nGracias!`;
}

function enlaceWa(telefono, mensaje) {
  const numero = String(telefono).replace(/[^\d]/g, '');
  return `https://wa.me/${numero}?text=${encodeURIComponent(mensaje)}`;
}

const filtroCentro = "(LOWER(TRIM(COALESCE(centro,''))) = LOWER(TRIM(?)) OR TRIM(COALESCE(centro,'')) = '')";

/** Proveedores del local con sus productos anidados. */
async function listarProveedores(db, centro, incluirInactivos) {
  const condProv = [filtroCentro];
  const args = [centro || ''];
  if (!incluirInactivos) condProv.push("activo = 1");

  const provs = await db.execute({
    sql: `SELECT * FROM proveedores WHERE ${condProv.join(' AND ')} ORDER BY orden ASC, nombre ASC`,
    args,
  });
  if (!provs.rows.length) return [];

  const ids = provs.rows.map(p => p.id);
  const marcas = ids.map(() => '?').join(',');
  const cond = [`proveedor_id IN (${marcas})`];
  if (!incluirInactivos) cond.push("activo = 1");

  const prods = await db.execute({
    sql: `SELECT * FROM productos_proveedor WHERE ${cond.join(' AND ')} ORDER BY orden ASC, nombre ASC`,
    args: ids,
  });

  const porProveedor = {};
  for (const p of prods.rows) (porProveedor[p.proveedor_id] ||= []).push(p);

  return provs.rows.map(p => ({ ...p, productos: porProveedor[p.id] || [] }));
}

/**
 * Confirma un pedido: valida, genera un envío por proveedor y lo guarda todo.
 * El histórico se escribe aquí, no al abrir WhatsApp: si el encargado nunca
 * llega a pulsar enviar, el pedido igualmente quedó registrado.
 */
async function confirmarPedido(db, req, { centro, empleado, envios }) {
  if (!Array.isArray(envios) || !envios.length) {
    return { error: "No has seleccionado nada para pedir" };
  }

  // Se cargan los proveedores del centro y se validan contra ellos: así un
  // proveedor de otro local no puede colarse aunque llegue en el cuerpo.
  const catalogo = await listarProveedores(db, centro, false);
  const porId = new Map(catalogo.map(p => [Number(p.id), p]));

  const preparados = [];
  const ts = Date.now();

  for (const envio of envios) {
    const prov = porId.get(Number(envio.proveedor_id));
    if (!prov) return { error: "Hay un proveedor que ya no está disponible. Vuelve a cargar la pantalla." };
    if (!E164.test(String(prov.telefono_whatsapp || ''))) {
      return { error: `${prov.nombre} no tiene un teléfono de WhatsApp válido. Avisa a administración.` };
    }

    const productos = new Map(prov.productos.map(p => [Number(p.id), p]));
    const acumulado = new Map();   // producto_id|unidad → cantidad

    for (const item of (envio.items || [])) {
      const prod = productos.get(Number(item.producto_id));
      if (!prod) return { error: `Hay un producto que ya no está disponible en ${prov.nombre}.` };

      const cantidad = Number(item.cantidad);
      if (!Number.isFinite(cantidad) || cantidad <= 0) {
        return { error: `Indica una cantidad válida para ${prod.nombre}.` };
      }
      const unidad = String(item.unidad || '').trim();
      if (!UNIDADES.includes(unidad)) {
        return { error: `Unidad no válida para ${prod.nombre}.` };
      }

      // Mismo producto repetido en la sesión: se suma, no se duplica la línea.
      const clave = `${prod.id}|${unidad}`;
      const previo = acumulado.get(clave);
      if (previo) previo.cantidad += cantidad;
      else acumulado.set(clave, { producto_id: Number(prod.id), nombre: prod.nombre, cantidad, unidad });
    }

    const lineas = [...acumulado.values()];
    if (!lineas.length) continue;   // proveedor abierto pero sin marcar nada

    preparados.push({
      proveedor: prov,
      lineas,
      mensaje: construirMensaje({ centro, lineas, ts }),
    });
  }

  if (!preparados.length) {
    return { error: "No has seleccionado nada para pedir" };
  }

  const pedido = await db.execute({
    sql: "INSERT INTO pedidos (centro, empleado, fecha_hora, estado) VALUES (?, ?, ?, 'confirmado')",
    args: [centro || '', empleado || '', ts],
  });
  const pedidoId = Number(pedido.lastInsertRowid);

  const resultado = [];
  for (const p of preparados) {
    const enlace = enlaceWa(p.proveedor.telefono_whatsapp, p.mensaje);
    const envio = await db.execute({
      sql: `INSERT INTO pedido_envios (pedido_id, proveedor_id, mensaje_generado, enlace_wa, enviado)
            VALUES (?, ?, ?, ?, 0)`,
      args: [pedidoId, p.proveedor.id, p.mensaje, enlace],
    });
    const envioId = Number(envio.lastInsertRowid);

    for (const l of p.lineas) {
      await db.execute({
        sql: "INSERT INTO pedido_items (pedido_envio_id, producto_id, cantidad, unidad) VALUES (?, ?, ?, ?)",
        args: [envioId, l.producto_id, l.cantidad, l.unidad],
      });
    }

    resultado.push({
      envio_id: envioId,
      proveedor_id: Number(p.proveedor.id),
      proveedor: p.proveedor.nombre,
      mensaje: p.mensaje,
      enlace_wa: enlace,
      lineas: p.lineas,
    });
  }

  await auditar(db, req, {
    tipo_evento: 'PEDIDO_CONFIRMADO', entidad: 'pedidos', entidad_id: String(pedidoId),
    empleado, centro,
    payload: { proveedores: resultado.map(r => r.proveedor), envios: resultado.length },
  }).catch(() => {});

  return { pedido_id: pedidoId, envios: resultado };
}

/** Pedidos del local con su detalle, para la pantalla de histórico. */
async function historico(db, { centro, desde, hasta, proveedor_id, limite }) {
  const cond = [filtroCentro];
  const args = [centro || ''];
  if (desde) { cond.push("fecha_hora >= ?"); args.push(Number(desde)); }
  if (hasta) { cond.push("fecha_hora < ?"); args.push(Number(hasta)); }

  const peds = await db.execute({
    sql: `SELECT * FROM pedidos WHERE ${cond.join(' AND ')}
          ORDER BY fecha_hora DESC LIMIT ?`,
    args: [...args, Math.min(200, Number(limite) || 60)],
  });
  if (!peds.rows.length) return [];

  const ids = peds.rows.map(p => p.id);
  const marcas = ids.map(() => '?').join(',');

  const condEnv = [`e.pedido_id IN (${marcas})`];
  const argsEnv = [...ids];
  if (proveedor_id) { condEnv.push("e.proveedor_id = ?"); argsEnv.push(Number(proveedor_id)); }

  const envs = await db.execute({
    sql: `SELECT e.*, p.nombre AS proveedor_nombre
          FROM pedido_envios e LEFT JOIN proveedores p ON p.id = e.proveedor_id
          WHERE ${condEnv.join(' AND ')} ORDER BY e.id ASC`,
    args: argsEnv,
  });
  if (!envs.rows.length) return [];

  const envIds = envs.rows.map(e => e.id);
  const items = await db.execute({
    sql: `SELECT i.*, pr.nombre AS producto_nombre
          FROM pedido_items i LEFT JOIN productos_proveedor pr ON pr.id = i.producto_id
          WHERE i.pedido_envio_id IN (${envIds.map(() => '?').join(',')}) ORDER BY i.id ASC`,
    args: envIds,
  });

  const porEnvio = {};
  for (const i of items.rows) (porEnvio[i.pedido_envio_id] ||= []).push(i);

  const porPedido = {};
  for (const e of envs.rows) {
    (porPedido[e.pedido_id] ||= []).push({ ...e, items: porEnvio[e.id] || [] });
  }

  // Con filtro de proveedor, los pedidos que no le incluyen no se listan.
  return peds.rows
    .filter(p => porPedido[p.id])
    .map(p => ({ ...p, envios: porPedido[p.id] }));
}

export default async function handler(req, res) {
  try {
    const db = getDbClient();
    await initSchema(db);
    await initPedidos(db);

    const recurso = req.query?.recurso || req.body?.recurso || '';
    const centro = req.query?.centro ?? req.body?.centro ?? '';
    const esAdmin = nivelDesdeReq(req) === 'ADMIN';

    // Todo el módulo es de encargado para arriba; el mantenimiento del
    // catálogo, solo de gerencia.
    if (!esEncargadoOSuperior(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }
    const soloAdmin = () => {
      if (esAdmin) return null;
      return res.status(403).json({ error: "Solo administración puede cambiar el catálogo" });
    };

    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');

      if (recurso === 'proveedores') {
        const incluirInactivos = req.query.incluir_inactivos === '1' && esAdmin;
        return res.status(200).json(await listarProveedores(db, centro, incluirInactivos));
      }

      if (recurso === 'historico') {
        const { desde, hasta, proveedor_id, limite } = req.query;
        return res.status(200).json(await historico(db, { centro, desde, hasta, proveedor_id, limite }));
      }

      return res.status(400).json({ error: "Recurso no reconocido" });
    }

    if (req.method === 'POST') {
      if (recurso === 'proveedor') {
        const bloqueo = soloAdmin(); if (bloqueo) return bloqueo;

        const { id, nombre, telefono_whatsapp, activo = 1, orden = 0 } = req.body || {};
        const tel = String(telefono_whatsapp || '').replace(/\s/g, '');
        if (!String(nombre || '').trim()) {
          return res.status(400).json({ error: "El proveedor necesita un nombre" });
        }
        // Sin teléfono válido no se puede dar de alta ni reactivar: un
        // proveedor sin WhatsApp no sirve para nada en este módulo.
        if (!E164.test(tel)) {
          return res.status(400).json({
            error: "El teléfono debe ir en formato internacional, por ejemplo +34600000000",
          });
        }

        if (id) {
          await db.execute({
            sql: `UPDATE proveedores SET nombre = ?, telefono_whatsapp = ?, activo = ?, orden = ?
                  WHERE id = ? AND ${filtroCentro}`,
            args: [String(nombre).trim(), tel, activo ? 1 : 0, Number(orden) || 0, Number(id), centro || ''],
          });
          return res.status(200).json({ success: true, id: Number(id) });
        }

        const r = await db.execute({
          sql: `INSERT INTO proveedores (centro, nombre, telefono_whatsapp, activo, orden, creado_en)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [centro || '', String(nombre).trim(), tel, activo ? 1 : 0, Number(orden) || 0, Date.now()],
        });
        return res.status(201).json({ success: true, id: Number(r.lastInsertRowid) });
      }

      if (recurso === 'producto') {
        const bloqueo = soloAdmin(); if (bloqueo) return bloqueo;

        const { id, proveedor_id, nombre, activo = 1, orden = 0 } = req.body || {};
        if (!String(nombre || '').trim()) {
          return res.status(400).json({ error: "El producto necesita un nombre" });
        }

        if (id) {
          await db.execute({
            sql: "UPDATE productos_proveedor SET nombre = ?, activo = ?, orden = ? WHERE id = ?",
            args: [String(nombre).trim(), activo ? 1 : 0, Number(orden) || 0, Number(id)],
          });
          return res.status(200).json({ success: true, id: Number(id) });
        }

        // El proveedor tiene que ser del centro que pide el alta.
        const prov = await db.execute({
          sql: `SELECT id FROM proveedores WHERE id = ? AND ${filtroCentro}`,
          args: [Number(proveedor_id), centro || ''],
        });
        if (!prov.rows.length) {
          return res.status(400).json({ error: "Ese proveedor no existe en este local" });
        }

        const r = await db.execute({
          sql: `INSERT INTO productos_proveedor (proveedor_id, nombre, activo, orden, creado_en)
                VALUES (?, ?, ?, ?, ?)`,
          args: [Number(proveedor_id), String(nombre).trim(), activo ? 1 : 0, Number(orden) || 0, Date.now()],
        });
        return res.status(201).json({ success: true, id: Number(r.lastInsertRowid) });
      }

      if (recurso === 'pedido') {
        const { empleado, envios } = req.body || {};
        const salida = await confirmarPedido(db, req, { centro, empleado, envios });
        if (salida.error) return res.status(400).json({ error: salida.error });
        return res.status(201).json(salida);
      }

      if (recurso === 'envio-enviado') {
        const { envio_id } = req.body || {};
        if (!envio_id) return res.status(400).json({ error: "Falta envio_id" });
        await db.execute({
          sql: "UPDATE pedido_envios SET enviado = 1, enviado_at = ? WHERE id = ? AND enviado = 0",
          args: [Date.now(), Number(envio_id)],
        });
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: "Recurso no reconocido" });
    }

    if (req.method === 'DELETE') {
      const bloqueo = soloAdmin(); if (bloqueo) return bloqueo;
      const id = Number(req.query.id);
      if (!id) return res.status(400).json({ error: "Falta id" });

      if (recurso === 'proveedor') {
        // Los pedidos ya hechos no se tocan: guardan el nombre y el texto que
        // se mandó, así que el histórico sigue leyéndose igual.
        const prods = await db.execute({
          sql: "SELECT id FROM productos_proveedor WHERE proveedor_id = ?",
          args: [id],
        });
        if (prods.rows.length) {
          await db.execute({
            sql: `DELETE FROM productos_proveedor WHERE proveedor_id = ?`,
            args: [id],
          });
        }
        await db.execute({
          sql: `DELETE FROM proveedores WHERE id = ? AND ${filtroCentro}`,
          args: [id, centro || ''],
        });
        return res.status(200).json({ success: true });
      }

      if (recurso === 'producto') {
        await db.execute({ sql: "DELETE FROM productos_proveedor WHERE id = ?", args: [id] });
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: "Recurso no reconocido" });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}
