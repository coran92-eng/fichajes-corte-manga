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

const TOKEN_ADMIN = "auth-token-fichaje-admin";
const TOKEN_ENCARGADO = "auth-token-fichaje-encargado";

const claveAdmin = () => process.env.ADMIN_PASSWORD || "123456";
const claveEncargado = () => process.env.ENCARGADO_PASSWORD || "123456";
const usuarioEncargado = () => process.env.ENCARGADO_USER || "Albert";

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { usuario, password, rol } = req.body || {};
  const quiere = String(rol || req.query?.rol || "").toLowerCase();

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
