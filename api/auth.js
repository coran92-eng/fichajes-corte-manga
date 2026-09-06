/**
 * Quién entra: gerencia y encargado en un solo sitio.
 *
 * Antes eran dos funciones que hacían lo mismo con distinta contraseña, y
 * Vercel cuenta cada archivo de api/ como una función. Juntarlas libera un
 * hueco y, sobre todo, deja la decisión de quién puede entrar en un único
 * lugar en vez de repartida en dos.
 *
 * Las sesiones de encargado/gerencia que se emiten aquí son firmas HMAC de
 * verdad (ver emitirSesionResponsable en _tareas-lib.js), no las dos cadenas
 * fijas de antes — que estaban además escritas en el HTML público de una
 * decena de pantallas, así que cualquiera podía copiarlas a su
 * sessionStorage sin pasar por aquí en absoluto.
 */

import { getDbClient } from "./_db.js";
import {
  initSchema, identificarPorPin, emitirSesionEmpleado, emitirSesionResponsable,
  fallosDePinRecientes, auditar, huellaRed, ipDeReq, idDispositivo,
  esPinAdmin, claveAdmin, claveEncargado, usuarioEncargado, claveCoincide,
} from "./_tareas-lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { usuario, password, rol, pin } = req.body || {};
  const quiere = String(rol || req.query?.rol || "").toLowerCase();

  // ── El empleado entra en su móvil con su PIN ──
  // El PIN dice quién es. Dónde está lo dice el código del bar, que se sigue
  // pidiendo al fichar: son dos controles distintos y hacen falta los dos.
  if (quiere === "empleado") {
    const db = getDbClient();
    await initSchema(db);

    // Seis dígitos son un millón de combinaciones, pero sin tope de intentos
    // eso se prueba entero en unas horas. Con tope, deja de ser un camino.
    const fallos = await fallosDePinRecientes(db, req);
    if (fallos.bloqueado) {
      return res.status(429).json({
        error: `Demasiados intentos fallidos. Espera unos minutos y vuelve a probar.`,
        motivo: "bloqueado",
      });
    }

    // El PIN de gerencia va primero: el mismo teclado sirve para las dos cosas
    // y, según de quién sea el número, se acaba en el fichaje o en el panel.
    if (await esPinAdmin(db, pin)) {
      const sesion = emitirSesionResponsable('ADMIN', claveAdmin());
      if (!sesion) {
        return res.status(503).json({ error: "Falta configurar el servidor (AUTH_SECRET)", motivo: "sin_secreto" });
      }
      await auditar(db, req, {
        tipo_evento: 'GERENCIA_ENTRO_CON_PIN', entidad: 'mantenimiento',
        device_id: idDispositivo(req),
      }).catch(() => {});
      return res.status(200).json({
        success: true, nivel: "admin", token: sesion, destino: "panel.html",
      });
    }

    const empleado = await identificarPorPin(db, pin);
    if (!empleado) {
      // No se dice de quién NO era: eso confirmaría PIN ajenos por descarte.
      await auditar(db, req, {
        tipo_evento: 'PIN_FALLIDO', entidad: 'empleados',
        device_id: idDispositivo(req),
        ip: huellaRed(ipDeReq(req)),   // por red, no por IP: en IPv6 cada móvil tiene la suya
        payload: { intentos_previos: fallos.n },
      }).catch(() => {});
      return res.status(401).json({ error: "PIN incorrecto", motivo: "pin" });
    }

    const sesion = emitirSesionEmpleado(empleado.nombre, empleado.pin_hash);
    if (!sesion) {
      return res.status(503).json({
        error: "Falta configurar el servidor para poder entrar con PIN",
        motivo: "sin_secreto",
      });
    }

    await auditar(db, req, {
      tipo_evento: 'EMPLEADO_ENTRO', entidad: 'empleados',
      empleado: empleado.nombre, centro: empleado.centro || '',
      device_id: idDispositivo(req),
    }).catch(() => {});

    return res.status(200).json({
      success: true, nivel: "empleado", sesion,
      nombre: empleado.nombre,
      centro: empleado.centro || '',
      rol: empleado.rol || '',
    });
  }

  // ── Encargado y gerencia: contraseña con límite de intentos ──
  // Antes esto no tenía ningún tope — un PIN de empleado sí lo tenía, pero la
  // contraseña que abre el panel entero, no. Mismo contador que el del PIN,
  // con su propio tipo de evento para no mezclar las dos cosas en el conteo.
  const db = getDbClient();
  await initSchema(db);
  const fallos = await fallosDePinRecientes(db, req, 'LOGIN_FALLIDO');
  if (fallos.bloqueado) {
    return res.status(429).json({
      error: "Demasiados intentos fallidos. Espera unos minutos y vuelve a probar.",
      motivo: "bloqueado",
    });
  }

  const registrarFallo = () => auditar(db, req, {
    tipo_evento: 'LOGIN_FALLIDO', entidad: 'auth',
    device_id: idDispositivo(req),
    ip: huellaRed(ipDeReq(req)),
  }).catch(() => {});

  if (quiere === "encargado") {
    if (!usuarioEncargado() || !claveEncargado()) {
      return res.status(503).json({ error: "El acceso de encargado no está configurado", motivo: "sin_configurar" });
    }
    if (usuario === usuarioEncargado() && claveCoincide(password, claveEncargado())) {
      const sesion = emitirSesionResponsable('ENCARGADO', claveEncargado());
      if (!sesion) return res.status(503).json({ error: "Falta configurar el servidor (AUTH_SECRET)", motivo: "sin_secreto" });
      return res.status(200).json({ success: true, token: sesion, nombre: usuario, nivel: "encargado" });
    }
    await registrarFallo();
    return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  }

  // "Un responsable autoriza": vale la clave de gerencia o la del encargado.
  // Es una sola pregunta, así que va en una sola llamada.
  if (quiere === "responsable") {
    if (claveCoincide(password, claveAdmin())) {
      const sesion = emitirSesionResponsable('ADMIN', claveAdmin());
      if (!sesion) return res.status(503).json({ error: "Falta configurar el servidor (AUTH_SECRET)", motivo: "sin_secreto" });
      return res.status(200).json({ success: true, token: sesion, nivel: "admin" });
    }
    if (claveCoincide(password, claveEncargado())) {
      const sesion = emitirSesionResponsable('ENCARGADO', claveEncargado());
      if (!sesion) return res.status(503).json({ error: "Falta configurar el servidor (AUTH_SECRET)", motivo: "sin_secreto" });
      return res.status(200).json({ success: true, token: sesion, nivel: "encargado" });
    }
    await registrarFallo();
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }

  // Sin rol: login de gerencia (panel.html vía login.html).
  if (!claveAdmin()) {
    return res.status(503).json({ error: "El acceso de gerencia no está configurado", motivo: "sin_configurar" });
  }
  if (claveCoincide(password, claveAdmin())) {
    const sesion = emitirSesionResponsable('ADMIN', claveAdmin());
    if (!sesion) return res.status(503).json({ error: "Falta configurar el servidor (AUTH_SECRET)", motivo: "sin_secreto" });
    return res.status(200).json({ success: true, token: sesion, nivel: "admin" });
  }
  await registrarFallo();
  return res.status(401).json({ error: "Contraseña incorrecta" });
}
