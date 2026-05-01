# 📱 Sistema de Fichaje con NFC

Aplicación web para gestionar entrada, salida y descansos de empleados usando integración con chips NFC.

## ✨ Características

- ✅ **Integración NFC**: Lee chips NFC automáticamente (Android Chrome)
- ✅ **Captura automática de hora**: La hora se toma del móvil del empleado
- ✅ **Lista de empleados**: Selección mediante dropdown desplegable
- ✅ **4 tipos de registro**: Entrada, Salida, Inicio Descanso, Fin Descanso
- ✅ **Reportes por empleado**: Visualización en pestañas por persona
- ✅ **Exportación a Excel**: Crea archivos .xlsx con pestañas por empleado
- ✅ **PWA Instalable**: Funciona como app nativa en móvil
- ✅ **Soporte offline**: Funciona sin conexión a internet
- ✅ **Almacenamiento local**: Los datos se guardan en el móvil

---

## 🚀 Instalación

### Opción 1: Servidor Local (Desarrollo)

```bash
# Navega al directorio
cd /Users/corandjilali/Documents/FICHAJE

# Inicia un servidor local (Python 3)
python3 -m http.server 8000

# O con Node.js (si tienes http-server instalado)
npx http-server
```

Accede a: **http://localhost:8000**

### Opción 2: Servidor en Línea

Sube los archivos a un servidor web (Vercel, Netlify, etc.). **Importante**: Usa HTTPS (obligatorio para NFC y PWA).

---

## 📲 Cómo Usar

### Página de Fichaje (`index.html`)

1. **Abre la app** en tu móvil (Chrome Android recomendado)
2. **Instala como app** (opción "Agregar a pantalla de inicio")
3. **Selecciona tu nombre** del dropdown
4. **Toca el chip NFC** con tu móvil (se detectará automáticamente)
   - O presiona el botón correspondiente (Entrada, Salida, etc.)
5. **Confirma** el registro en la notificación
6. **Tu última acción aparecerá** en la parte inferior

### Página de Reportes (`admin.html`)

1. Presiona el botón **"📊 Ver Reportes"**
2. **Selecciona pestañas** para ver datos por empleado
3. **Opciones disponibles**:
   - 📥 **Exportar a Excel**: Descarga archivo con pestañas por empleado
   - 🗑️ **Limpiar datos**: Borra todos los registros
   - ← **Volver a Fichaje**: Regresa a la página principal

---

## 🏷️ Configuración del Chip NFC

### Programación del Chip

Usa una app como **NFC Tools** (Android/iOS) o **Tagwriter by NXP**:

1. **Abre la app NFC**
2. **Nuevo registro** → **URL/URI**
3. **Escribe esta URL**:
   ```
   https://tu-dominio.com/index.html
   ```
   *(Cambia `tu-dominio.com` por tu servidor real)*

4. **Escribe el chip**
5. **Prueba**: Toca el chip, debe abrir tu app

### URL Alternativa con Parámetros

Para diferenciar chips por tipo:
```
https://tu-dominio.com/index.html?nfc=entrada
```

---

## 📊 Exportación a Excel

El archivo descargado tiene esta estructura:

**Archivos generados**: `Fichaje_YYYY-MM-DD.xlsx`

### Contenido:

- **Hoja "Resumen"**: 
  - Empleado, Total Registros, Último Registro

- **Hojas individuales** (una por empleado):
  - Fecha | Hora | Tipo
  - Ejemplo: 2026-04-26 | 09:15:32 | Entrada

---

## 💾 Almacenamiento de Datos

Los datos se guardan en **localStorage** del navegador:
- **Sin servidores backend**
- **Sin internet requerido** (después de la primera carga)
- **Privado al dispositivo**

### Ubicación de datos:
- ChromeOS: `/Users/corandjilali/AppData/Local/Google/Chrome/...`
- Android: Datos de la app (internos)

### Estructura almacenada:
```json
{
  "fichajes_data": [
    {
      "id": 1714120532123.456,
      "empleado": "Juan García",
      "tipo": "entrada",
      "fecha": "2026-04-26",
      "hora": "09:15:32",
      "timestamp": 1714120532123
    }
  ]
}
```

---

## 👥 Agregar/Modificar Empleados

### Opción 1: Desde la app

*(Característica futura - actualmente viene preconfigurada)*

### Opción 2: Editar localStorage manualmente

Abre la consola del navegador (F12):

```javascript
// Ver empleados actuales
JSON.parse(localStorage.getItem('empleados_list'))

// Agregar nuevo empleado
let empleados = JSON.parse(localStorage.getItem('empleados_list')) || [
  'Juan García',
  'María López',
  'Carlos Martínez'
];
empleados.push('Nuevo Empleado');
localStorage.setItem('empleados_list', JSON.stringify(empleados));
```

---

## 🔧 Requisitos Técnicos

### Para NFC:
- 📱 **Android 4.4+** con NFC
- 🌐 **Chrome, Edge, Opera** (Navegadores Chromium)
- 🔒 **HTTPS obligatorio** (en servidor)
- ⚠️ **iOS limitado**: Solo iOS 13.6+ con aplicación nativa

### Para PWA (instalación):
- 🌐 **Navegador moderno** (Chrome, Edge, Firefox)
- 🔒 **HTTPS** (en servidor)
- 📱 **144x144px icono mínimo** (incluido)

---

## 🚨 Solución de Problemas

### "NFC no disponible"
- ✓ Usa Android con Chrome
- ✓ Activa NFC en Ajustes del teléfono
- ✓ Usa botones como alternativa

### "No puedo instalar como app"
- ✓ Usa Chrome en Android
- ✓ Necesita HTTPS
- ✓ Espera 30 segundos, aparecerá opción

### "Los datos desaparecen"
- ✓ No limpies datos de la app
- ✓ No uses "Borrar datos del navegador"
- ✓ Exporta periódicamente a Excel

### "El chip NFC no abre la app"
- ✓ Verifica la URL en el chip (con NFC Tools)
- ✓ Usa HTTPS en la URL
- ✓ Escribe bien el dominio

---

## 📁 Estructura de Archivos

```
FICHAJE/
├── index.html          # Página de fichaje
├── admin.html          # Reportes y exportación
├── manifest.json       # Configuración PWA
├── sw.js              # Service Worker (offline)
└── README.md          # Este archivo
```

---

## 🔐 Privacidad y Seguridad

- ✅ **Sin servidor central**: Los datos quedan en el móvil
- ✅ **Sin envío de datos**: Todo local
- ✅ **HTTPS recomendado**: Protege en tránsito
- ✅ **Respaldo manual**: Exporta periódicamente a Excel

---

## 📝 Versión

**v1.0** - Abril 2026

---

## 💡 Características Futuras

- [ ] Panel de admin con login
- [ ] Sincronización en la nube (opcional)
- [ ] Estadísticas de horas trabajadas
- [ ] Alertas de ausencias
- [ ] Integración con nómina
- [ ] Visualización gráfica de asistencia
- [ ] Exportación a PDF

---

**¿Preguntas o problemas?** Revisa la consola del navegador (F12) para mensajes de error.
