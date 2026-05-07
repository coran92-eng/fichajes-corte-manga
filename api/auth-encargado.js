export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { usuario, password } = req.body;

  const usuarioValido = process.env.ENCARGADO_USER || "Albert";
  const passwordValida = process.env.ENCARGADO_PASSWORD || "123456";

  if (usuario === usuarioValido && password === passwordValida) {
    return res.status(200).json({
      success: true,
      token: "auth-token-fichaje-encargado",
      nombre: usuario,
    });
  }

  return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
}
