# ⚙️ Guía Rápida de Setup

## 1️⃣ Configurar Empleados

Edita `config.json` y agrega los nombres de tus camareros:

```json
{
  "empleados": [
    "Juan García",
    "María López",
    "Carlos Martínez"
  ]
}
```

## 2️⃣ Iniciar Servidor Local

### Con Python:
```bash
cd /Users/corandjilali/Documents/FICHAJE
python3 -m http.server 8000
```

### Con Node (si tienes http-server):
```bash
npx http-server
```

Accede a: **http://localhost:8000**

## 3️⃣ Instalar como App en Móvil

1. Abre en **Chrome Android**
2. Presiona el menú (⋮)
3. Selecciona **"Instalar app"** o **"Agregar a pantalla de inicio"**
4. Verás el icono en tu pantalla de inicio

## 4️⃣ Configurar Chip NFC

Usa una app como **NFC Tools** (Android):

1. Escribe esta URL en el chip:
   ```
   http://localhost:8000/index.html
   ```
   *(Para producción: `https://tu-dominio.com/index.html`)*

2. Guarda el chip
3. Toca el chip con tu móvil → debe abrir la app

## 5️⃣ Empezar a Usar

- **Fichaje**: Abre la app, selecciona tu nombre, toca el chip o presiona botones
- **Reportes**: Presiona "📊 Ver Reportes" para ver datos
- **Exportar**: Descarga Excel con "📥 Exportar a Excel"

---

## 🌐 Desplegar en Producción

Para usar en la vida real, necesitas un servidor HTTPS.

### Opciones recomendadas:

#### **Vercel** (Gratis, muy fácil)
```bash
npm install -g vercel
cd /Users/corandjilali/Documents/FICHAJE
vercel
```

#### **Netlify** (Drag & drop)
1. Ve a netlify.com
2. Arrastra la carpeta FICHAJE
3. Listo, tendrás tu URL HTTPS

#### **GitHub Pages** (Gratis)
1. Crea repositorio en GitHub
2. Sube los archivos
3. Activa Pages en Settings
4. Usa la URL generada

---

## ⚠️ Importante para NFC

- ✅ **HTTPS obligatorio** en producción
- ✅ **Android Chrome** es lo mejor soportado
- ✅ Los datos se guardan localmente (no subirán a servidor)

---

## 🆘 Troubleshooting

| Problema | Solución |
|----------|----------|
| No veo la app en móvil | Abre en Chrome Android, espera 30 seg |
| NFC no se detecta | Asegúrate que está activado en Ajustes |
| Los datos desaparecen | No limpies datos de la app, exporta a Excel |
| Chip NFC no abre app | Usa HTTPS en la URL del chip |

---

¿Todo listo? **¡Comienza a fichar! 📱**
