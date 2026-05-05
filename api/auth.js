export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";

  if (password === adminPassword) {
    // En una app real usaríamos JWT o cookies firmadas, pero aquí simplificamos devolviendo un token
    // que el frontend guardará en sessionStorage
    return res.status(200).json({ success: true, token: "auth-token-fichaje-admin" });
  } else {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }
}
