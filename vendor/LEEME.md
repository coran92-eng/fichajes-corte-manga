# vendor/

Código de terceros que se guarda dentro del repositorio a propósito.

## `qr.mjs`

Generador de códigos QR. **QR Code Generator for JavaScript**, de Kazuhiko Arase
(<http://www.d-project.com/>), publicado como `qrcode-generator@2.0.4` bajo
licencia **MIT**. El aviso de copyright y de licencia va en la cabecera del
propio archivo; no se ha modificado ni una línea.

Está aquí y no en un CDN por un motivo concreto: lo usa `qr.html`, la pantalla
que muestra el código en el iPad del bar y que tiene que estar encendida todo el
servicio. Si dependiera de que unpkg responda, una caída suya dejaría al equipo
sin poder fichar desde el móvil. El service worker lo cachea.
