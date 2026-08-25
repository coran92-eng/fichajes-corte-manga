/**
 * Quién entra: gerencia y encargado en un solo sitio.
 *
 * Antes eran dos funciones que hacían lo mismo con distinta contraseña, y
 * Vercel cuenta cada archivo de api/ como una función. Juntarlas libera un
 * hueco y, sobre todo, deja la decisión de quién puede entrar en un único
 * lugar en vez de repartida en dos.
 *
 * Nota sobre el modelo: los tokens son cadenas fijas guardadas en
 * sessionStorage. Sirven para separar pantallas de empleado, encargado y
 * gerencia, pero NO son autenticación fuerte: un token filtrado es
 * reutilizable. Está anotado también en _tareas-lib.js.
 */

import { getDbClient } from "./_db.js";
import {
  initSchema, identificarPorPin, emitirSesionEmpleado,
  fallosDePinRecientes, auditar, huellaRed, ipDeReq, idDispositivo,
} from "./_tareas-lib.js";

const TOKEN_ADMIN = "auth-token-fichaje-admin";
const TOKEN_ENCARGADO = "auth-token-fichaje-encargado";

const claveAdmin = () => process.env.ADMIN_PASSWORD || "123456";
const claveEncargado = () => process.env.ENCARGADO_PASSWORD || "123456";
const usuarioEncargado = () => process.env.ENCARGADO_USER || "Albert";

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

  if (quiere === "encargado") {
    if (usuario === usuarioEncargado() && password === claveEncargado()) {
      return res.status(200).json({
        success: true, token: TOKEN_ENCARGADO, nombre: usuario, nivel: "encargado",
      });
    }
    return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  }

  // "Un responsable autoriza": vale la clave de gerencia o la del encargado.
  // Es una sola pregunta, así que va en una sola llamada.
  if (quiere === "responsable") {
    if (password === claveAdmin()) {
      return res.status(200).json({ success: true, token: TOKEN_ADMIN, nivel: "admin" });
    }
    if (password === claveEncargado()) {
      return res.status(200).json({ success: true, token: TOKEN_ENCARGADO, nivel: "encargado" });
    }
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }

  if (password === claveAdmin()) {
    return res.status(200).json({ success: true, token: TOKEN_ADMIN, nivel: "admin" });
  }
  return res.status(401).json({ error: "Contraseña incorrecta" });
}
