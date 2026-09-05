/**
 * Aviso de versión nueva.
 *
 * Sin esto, una pestaña dejada abierta (el móvil de alguien, el iPad del
 * bar, el panel del dueño) se queda para siempre con el código con el que
 * cargó. El service worker de fondo sí se entera de las versiones nuevas
 * —`sw.js` ya usa skipWaiting + clients.claim—, pero eso solo cambia quién
 * responde a las peticiones de red; no recarga la página que ya está en
 * memoria. Hace falta decírselo explícitamente.
 *
 * Por defecto se avisa con una barra y hay que tocarla: recargar solo no,
 * porque podría perderse algo a medio escribir (una nota, una foto a medio
 * hacer). Para pantallas sin nadie delante para tocar nada —el iPad
 * mostrando el código— se pone `window.SW_ACTUALIZA_SOLO = true` antes de
 * cargar este script, y se recarga sin preguntar.
 */
(function () {
    if (!('serviceWorker' in navigator)) return;
    const soloActualizar = window.SW_ACTUALIZA_SOLO === true;

    function avisarONuevaVersion() {
        if (soloActualizar) {
            window.location.reload();
            return;
        }
        if (document.getElementById('swAvisoActualizar')) return;
        const barra = document.createElement('button');
        barra.id = 'swAvisoActualizar';
        barra.type = 'button';
        barra.textContent = '↻ Hay una versión nueva. Toca para actualizar.';
        barra.style.cssText = [
            'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:99999',
            'background:#2563eb', 'color:#fff', 'border:none', 'padding:13px 16px',
            'text-align:center', 'font:600 14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
            'text-transform:none', 'letter-spacing:normal',
            'cursor:pointer', 'box-shadow:0 -2px 12px rgba(0,0,0,.25)',
        ].join(';');
        barra.addEventListener('click', () => window.location.reload());
        document.body.appendChild(barra);
    }

    // updateViaCache:'none' evita que el navegador cachee sw.js hasta 24h
    // por defecto, que dejaba dispositivos servidos con una versión antigua
    // sin poder ni empezar a actualizarse.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
        .then(reg => {
            reg.update();
            setInterval(() => reg.update(), 60 * 60 * 1000);

            // Puede que ya haya una versión nueva esperando de una comprobación
            // anterior (por ejemplo, si la pestaña llevaba rato abierta).
            if (reg.waiting && navigator.serviceWorker.controller) avisarONuevaVersion();

            reg.addEventListener('updatefound', () => {
                const nuevo = reg.installing;
                if (!nuevo) return;
                nuevo.addEventListener('statechange', () => {
                    // "installed" con un controller ya activo = había una versión
                    // anterior sirviendo esta pestaña: esto es una actualización,
                    // no la primera instalación del service worker.
                    if (nuevo.state === 'installed' && navigator.serviceWorker.controller) {
                        avisarONuevaVersion();
                    }
                });
            });
        })
        .catch(err => console.log('Error registrando SW:', err));
})();
