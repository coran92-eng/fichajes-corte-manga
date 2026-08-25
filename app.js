const EMPLEADOS_DEFAULT = [
    'Albert', 'Maikel', 'Carlos', 'Jecko',
    'Pol', 'Sonia', 'Nacho', 'Claudia'
];

const params = new URLSearchParams(window.location.search);
// Deja de ser fijo: con sesión iniciada, el centro lo trae el propio empleado.
let centroActual = params.get('centro');

// ── Código del bar y dispositivo ──────────────────────────────
// Quien ficha desde su móvil tiene que haber leído el QR del iPad: es lo que
// demuestra que estaba allí. El código llega en la propia dirección al abrir la
// app desde la cámara, dura unos segundos y no se guarda más allá de la sesión.
// El servidor acepta la ventana actual y la anterior, así que un código vale
// como mucho 50 s. Pero eso solo se cumple si se leyó recién generado: si ya
// estaba a punto de cambiar, la validez real es la mitad. Se garantizan 25 s y
// a partir de ahí se avisa, en vez de prometer un tiempo que puede no existir.
const QR_VIDA_MS = 50000;
const QR_SEGURO_MS = 25000;

// ── Sesión del empleado ───────────────────────────────────────
// En su móvil entra una vez con su PIN y ya. El PIN no se guarda aquí: solo un
// testigo firmado por el servidor, que además caduca solo si se le regenera el
// PIN. En el iPad del bar no hay sesión: es una pantalla compartida.

function sesionEmpleado() {
    if (esIpadDelLocal()) return null;
    try {
        const s = JSON.parse(localStorage.getItem('sesionEmpleado') || 'null');
        return s && s.sesion && s.nombre ? s : null;
    } catch { return null; }
}

function guardarSesionEmpleado(datos) {
    try { localStorage.setItem('sesionEmpleado', JSON.stringify(datos)); } catch {}
}

function cerrarSesionEmpleado() {
    try {
        localStorage.removeItem('sesionEmpleado');
        localStorage.removeItem('empleadoHabitual');
    } catch {}
    window.location.href = '/';
}

/** El testigo, para mandarlo con cada petición que necesite saber quién es. */
function testigoSesion() {
    return sesionEmpleado()?.sesion || '';
}

function guardarCodigoDeLaUrl() {
    const qr = params.get('qr');
    if (!qr) return;
    try {
        sessionStorage.setItem('qrCodigo', qr);
        sessionStorage.setItem('qrLeidoEn', String(Date.now()));
    } catch {}
    // Se limpia de la barra de direcciones: si se queda ahí, recargar la página
    // pasadas horas reintentaría con un código muerto y confundiría el aviso.
    try {
        const limpia = new URL(window.location.href);
        limpia.searchParams.delete('qr');
        window.history.replaceState({}, '', limpia);
    } catch {}
}

/** El código vigente, o cadena vacía si no hay o ya ha caducado. */
function codigoDelBar() {
    try {
        const qr = sessionStorage.getItem('qrCodigo') || '';
        const leidoEn = Number(sessionStorage.getItem('qrLeidoEn') || 0);
        if (!qr || Date.now() - leidoEn > QR_VIDA_MS) return '';
        return qr;
    } catch { return ''; }
}

/** Se descarta el código: o ya se usó, o el servidor lo ha rechazado. */
function olvidarCodigo() {
    try {
        sessionStorage.removeItem('qrCodigo');
        sessionStorage.removeItem('qrLeidoEn');
    } catch {}
    pintarAvisoCodigo();
}

function msDeCodigo() {
    try {
        const leidoEn = Number(sessionStorage.getItem('qrLeidoEn') || 0);
        return Math.max(0, QR_VIDA_MS - (Date.now() - leidoEn));
    } catch { return 0; }
}

/** Identificador del aparato. Sirve para reconocer al iPad del local. */
function idDispositivo() {
    try {
        let id = localStorage.getItem('device_id');
        if (!id) {
            id = 'dev_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
            localStorage.setItem('device_id', id);
        }
        return id;
    } catch { return ''; }
}

guardarCodigoDeLaUrl();

document.addEventListener('DOMContentLoaded', async () => {
    // El iPad del bar es una pantalla compartida: sigue con centro y lista de
    // nombres, sin PIN. En un móvil personal, la primera pantalla es el teclado.
    if (!esIpadDelLocal()) {
        const sesion = sesionEmpleado();
        if (!sesion) { mostrarTecladoPin(); return; }
        centroActual = sesion.centro || centroActual;
    }

    if (!centroActual) {
        await mostrarSelectorCentro();
        return;
    }
    arrancar();
});

function arrancar() {
    document.getElementById('centroBadge').textContent = centroActual;
    document.getElementById('centroBadge').style.display = 'inline-block';

    inicializar();
    actualizarReloj();
    setInterval(actualizarReloj, 1000);
}

// ── Teclado del PIN ───────────────────────────────────────────
function mostrarTecladoPin() {
    const pantalla = document.getElementById('pantallaPin');
    const puntos = document.getElementById('pinPuntos');
    const errorEl = document.getElementById('pinError');
    if (!pantalla) { mostrarSelectorCentro(); return; }

    const LARGO = 6;
    let marcado = '';
    let enviando = false;
    pantalla.classList.add('visible');

    const pintar = () => {
        puntos.innerHTML = Array.from({ length: LARGO }, (_, i) =>
            `<span class="pin-punto${i < marcado.length ? ' lleno' : ''}"></span>`).join('');
    };

    const fallar = texto => {
        errorEl.textContent = texto;
        marcado = '';
        pintar();
        const caja = pantalla.querySelector('.pin-caja');
        caja.classList.add('temblor');
        setTimeout(() => caja.classList.remove('temblor'), 320);
        if (navigator.vibrate) navigator.vibrate(180);
    };

    const entrar = async () => {
        enviando = true;
        errorEl.textContent = '';
        document.getElementById('pinAyuda').textContent = 'Comprobando…';
        try {
            const r = await fetch('/api/auth?rol=empleado', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Device-Id': idDispositivo() },
                body: JSON.stringify({ pin: marcado, device_id: idDispositivo() }),
            });
            const d = await r.json().catch(() => ({}));

            // El PIN de gerencia lleva al panel; el de un empleado, a su pantalla
            // de fichaje. Mismo teclado, dos destinos.
            if (r.ok && d.nivel === 'admin' && d.token) {
                try { sessionStorage.setItem('adminToken', d.token); } catch {}
                window.location.href = d.destino || 'panel.html';
                return;
            }

            if (r.ok && d.sesion) {
                guardarSesionEmpleado({ sesion: d.sesion, nombre: d.nombre, centro: d.centro, rol: d.rol });
                try { localStorage.setItem('empleadoHabitual', d.nombre); } catch {}
                centroActual = d.centro || centroActual;
                pantalla.classList.remove('visible');
                if (!centroActual) { await mostrarSelectorCentro(); return; }
                arrancar();
                return;
            }
            // No se dice de quién no era: eso confirmaría PIN ajenos por descarte.
            fallar(d.error || 'PIN incorrecto');
        } catch {
            fallar('Sin conexión. Inténtalo otra vez.');
        } finally {
            enviando = false;
            document.getElementById('pinAyuda').textContent = 'Teclea tu PIN para entrar';
        }
    };

    pantalla.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => {
        if (enviando || marcado.length >= LARGO) return;
        marcado += b.dataset.d;
        errorEl.textContent = '';
        pintar();
        if (marcado.length === LARGO) entrar();
    }));

    document.getElementById('pinBorrar').addEventListener('click', () => {
        if (enviando) return;
        marcado = marcado.slice(0, -1);
        pintar();
    });

    // La entrada del dueño: con su correo y su contraseña, como siempre. El PIN
    // de gerencia es un atajo, no un reemplazo, y esta puerta sigue abierta.
    document.getElementById('pinCoran').addEventListener('click', () => {
        window.location.href = 'login.html';
    });

    // Salida para montar el iPad la primera vez, y para que un PIN que falle no
    // deje a nadie sin fichar. Va detrás de contraseña a propósito: si fuera un
    // enlace suelto, el PIN sería decorativo.
    document.getElementById('pinEsElIpad').addEventListener('click', async () => {
        const clave = prompt('Contraseña de encargado o gerencia:');
        if (!clave) return;
        if (!(await validarResponsable(clave))) {
            fallar('Contraseña incorrecta');
            return;
        }
        try { localStorage.setItem('dispositivoDeConfianza', '1'); } catch {}
        pantalla.classList.remove('visible');
        if (centroActual) arrancar(); else mostrarSelectorCentro();
    });

    pintar();
}

async function mostrarSelectorCentro() {
    let centros = ['Centro 1', 'Centro 2', 'Centro 3'];
    try {
        const res = await fetch('/config.json');
        if (res.ok) {
            const cfg = await res.json();
            if (Array.isArray(cfg.centros)) centros = cfg.centros;
        }
    } catch {}

    const overlay = document.getElementById('selectorCentro');
    const lista = document.getElementById('listaCentros');
    lista.innerHTML = centros.map(c =>
        `<button class="btn-centro" onclick="elegirCentro('${encodeURIComponent(c)}')">${c}</button>`
    ).join('');
    overlay.classList.add('visible');
}

window.elegirCentro = function(centro) {
    window.location.href = `/?centro=${centro}`;
};

function inicializar() {
    cargarEmpleados();
    configurarNFC();
    configurarBotones();

    actualizarEstadoBotones(null);
    pintarAvisoCodigo();
    setInterval(pintarAvisoCodigo, 1000);
    if (centroActual) { iniciarPanelTurno(); configurarNotas(); }
}

/**
 * Dice si hay código del bar vigente y cuánto le queda. En el iPad del local no
 * se enseña nada: allí no hace falta leer ningún código.
 */
function pintarAvisoCodigo() {
    const caja = document.getElementById('qrAviso');
    const txt = document.getElementById('qrAvisoTxt');
    const barra = document.getElementById('qrBarra');
    if (!caja || !txt) return;

    if (esIpadDelLocal()) { caja.style.display = 'none'; return; }

    const queda = msDeCodigo();
    if (codigoDelBar()) {
        const seguro = Math.max(0, queda - (QR_VIDA_MS - QR_SEGURO_MS));
        caja.style.display = 'block';
        if (seguro > 0) {
            caja.className = 'qr-aviso ok';
            txt.innerHTML = `<strong>✓ Código del bar leído</strong>Puedes fichar. Te quedan ${Math.ceil(seguro / 1000)} s.`;
            barra.style.display = 'block';
            barra.firstElementChild.style.width = `${Math.round(seguro / QR_SEGURO_MS * 100)}%`;
        } else {
            caja.className = 'qr-aviso falta';
            txt.innerHTML = '<strong>El código está a punto de caducar</strong>'
                + 'Prueba a fichar; si te lo rechaza, vuelve a leerlo en la pantalla del bar.';
            barra.style.display = 'none';
        }
    } else {
        caja.style.display = 'block';
        caja.className = 'qr-aviso falta';
        txt.innerHTML = '<strong>Para fichar, lee el código del bar</strong>'
            + 'Abre la cámara del móvil y apunta a la pantalla del iPad.';
        barra.style.display = 'none';
    }
}

async function cargarEmpleados() {
    let empleados = EMPLEADOS_DEFAULT.map(n => ({ nombre: n, centro: '' }));
    try {
        const url = centroActual ? `/api/empleados?centro=${encodeURIComponent(centroActual)}` : '/api/empleados';
        const response = await fetch(url);
        if (response.ok) {
            const raw = await response.json();
            if (raw.length > 0) {
                empleados = raw.map(e => typeof e === 'string' ? { nombre: e, centro: '' } : e);
            }
        }
    } catch (e) {
        console.error('Error cargando empleados:', e);
    }

    const cont = document.getElementById('empleadosBotones');
    if (!cont) return;

    if (empleados.length === 0) {
        cont.innerHTML = '<span style="color:#9ca3af;font-size:13px;grid-column:1/-1">Sin empleados en este centro</span>';
        return;
    }

    listaEmpleados = empleados.map(e => e.nombre);
    cont.innerHTML = '';
    empleados.forEach(({ nombre, rol, horario_habitual }) => {
        rolPorEmpleado[nombre] = (rol || '').toLowerCase();
        habitualPorEmpleado[nombre] = horario_habitual || '';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-emp';
        btn.textContent = nombre;
        btn.addEventListener('click', () => seleccionarEmpleado(nombre, btn));
        cont.appendChild(btn);
        if (nombre === duenoDelMovil()) btn.dataset.dueno = '1';
    });

    // Con sesión iniciada la lista sobra: la app ya sabe de quién es el móvil.
    // En el iPad del bar se deja entera, que es una pantalla compartida.
    const sesion = sesionEmpleado();
    if (sesion) {
        const suyo = [...cont.querySelectorAll('.btn-emp')]
            .find(b => b.textContent === sesion.nombre);
        if (suyo) {
            cont.innerHTML = '';
            cont.appendChild(suyo);
            seleccionarEmpleado(sesion.nombre, suyo);
            const salir = document.createElement('button');
            salir.type = 'button';
            salir.className = 'btn-nosoyyo';
            salir.textContent = 'No soy yo';
            salir.addEventListener('click', () => {
                if (confirm('Se cerrará la sesión en este móvil. ¿Seguro?')) cerrarSesionEmpleado();
            });
            cont.parentElement.appendChild(salir);
        }
    } else {
        const suyo = cont.querySelector('[data-dueno="1"]');
        if (suyo) seleccionarEmpleado(suyo.textContent, suyo);
    }
    pintarAvisoCodigo();
}

/** A quién pertenece este móvil, si ya lo ha dicho alguna vez. */
function duenoDelMovil() {
    const s = sesionEmpleado();
    if (s) return s.nombre;
    if (esIpadDelLocal()) return '';
    try { return localStorage.getItem('empleadoHabitual') || ''; } catch { return ''; }
}

/** El iPad del bar se marca desde el panel; ahí no se recuerda a nadie. */
function esIpadDelLocal() {
    try { return localStorage.getItem('dispositivoDeConfianza') === '1'; } catch { return false; }
}

function seleccionarEmpleado(nombre, btn) {
    const cont = document.getElementById('empleadosBotones');
    if (cont) cont.querySelectorAll('.btn-emp').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    document.getElementById('empleado').value = nombre;
    if (!esIpadDelLocal()) {
        try { localStorage.setItem('empleadoHabitual', nombre); } catch {}
    }
    actualizarUltimaAccion();
    actualizarBadgeTareas();
}

function actualizarReloj() {
    const now = new Date();
    const horas = String(now.getHours()).padStart(2, '0');
    const minutos = String(now.getMinutes()).padStart(2, '0');
    const segundos = String(now.getSeconds()).padStart(2, '0');
    document.getElementById('timeDisplay').textContent = `${horas}:${minutos}:${segundos}`;
}

function configurarNFC() {
    const statusEl = document.getElementById('nfcStatus');
    if ('NDEFReader' in window) {
        statusEl.textContent = '✓ NFC disponible (toca el chip para fichar)';
        statusEl.className = 'nfc-status supported';
        iniciarLectorNFC();
    } else {
        statusEl.style.display = 'none';
    }
}

async function iniciarLectorNFC() {
    try {
        const ndef = new NDEFReader();
        await ndef.scan();
        ndef.onreadingerror = () => mostrarMensaje('Error al leer NFC', 'error');
        ndef.onreading = () => {
            mostrarMensaje('✓ NFC detectado', 'info');
            const empleado = document.getElementById('empleado').value;
            if (!empleado) mostrarMensaje('Por favor selecciona tu nombre', 'error');
            else document.getElementById('btnEntrada').focus();
        };
    } catch (error) {
        console.log('NFC no disponible:', error);
    }
}

function configurarBotones() {
    // La entrada comprueba antes que no se está fichando antes de hora (§ control
    // de entradas anticipadas).
    document.getElementById('btnEntrada').addEventListener('click', () => confirmarEntrada());
    // La salida avisa de tareas pendientes pero nunca se bloquea (§6.3).
    document.getElementById('btnSalida').addEventListener('click', () => confirmarSalida());
    document.getElementById('btnMostrarQr')?.addEventListener('click', () => {
        window.location.href = `qr.html?centro=${encodeURIComponent(centroActual || '')}`;
    });
    document.getElementById('btnDescansoIni').addEventListener('click', () => registrarFichaje('inicio_descanso'));
    document.getElementById('btnDescansoFin').addEventListener('click', () => registrarFichaje('fin_descanso'));
    document.getElementById('btnAdmin').addEventListener('click', () => {
        window.location.href = 'login.html';
    });
    document.getElementById('btnEncargado')?.addEventListener('click', () => {
        window.location.href = 'login-encargado.html';
    });

    document.getElementById('btnSolicitarCorreccion')?.addEventListener('click', abrirModalSolicitud);
    document.getElementById('btnVerHorario')?.addEventListener('click', () => {
        const url = centroActual
            ? `/horario-empleado.html?centro=${encodeURIComponent(centroActual)}`
            : '/horario-empleado.html';
        window.location.href = url;
    });

    document.getElementById('btnVerTareas')?.addEventListener('click', () => irATareas());

    // "Antes que tú" arranca plegado y se despliega al tocarlo.
    document.getElementById('ayerToggle')?.addEventListener('click', () => {
        const boton = document.getElementById('ayerToggle');
        const cuerpo = document.getElementById('ayerCuerpo');
        if (!boton || !cuerpo) return;
        const abierto = boton.getAttribute('aria-expanded') === 'true';
        boton.setAttribute('aria-expanded', abierto ? 'false' : 'true');
        cuerpo.hidden = abierto;
    });
    document.getElementById('btnSolCancelar')?.addEventListener('click', cerrarModalSolicitud);
    document.getElementById('btnSolEnviar')?.addEventListener('click', enviarSolicitud);
    document.getElementById('solCaso')?.addEventListener('change', actualizarVisibilidadHora);
    document.getElementById('solModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'solModal') cerrarModalSolicitud();
    });

    const btnUndo = document.getElementById('btnUndo');
    if (btnUndo) {
        btnUndo.addEventListener('click', async () => {
            const toast = document.getElementById('undoToast');
            toast.classList.remove('visible');
            if (undoTimer) clearTimeout(undoTimer);
            if (!ultimoFichaje) return;
            try {
                const res = await fetch(
                    `/api/fichajes?id=${ultimoFichaje.timestamp}&empleado=${encodeURIComponent(ultimoFichaje.empleado)}`,
                    { method: 'DELETE' }
                );
                if (res.ok) {
                    mostrarMensaje('Registro deshecho', 'info');
                    actualizarUltimaAccion();
                } else {
                    mostrarMensaje('No se pudo deshacer. Inténtalo de nuevo.', 'error');
                }
            } catch {
                mostrarMensaje('Error al deshacer', 'error');
            }
            ultimoFichaje = null;
        });
    }
}

async function registrarFichaje(tipo, horaPrevista = '', passwordResponsable = '', motivo = '') {
    const empleado = document.getElementById('empleado').value;
    const btnElements = document.querySelectorAll('button');

    if (!empleado) {
        mostrarMensaje('Por favor selecciona tu nombre', 'error');
        return;
    }

    try {
        btnElements.forEach(btn => btn.disabled = true);

        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const fichaje = {
            empleado,
            tipo,
            fecha: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
            hora: now.toTimeString().split(' ')[0],
            timestamp: now.getTime(),
            centro: centroActual || '',
            hora_prevista: horaPrevista || '',
            password_responsable: passwordResponsable || '',
            motivo: motivo || '',
            qr: codigoDelBar(),
            device_id: idDispositivo()
        };

        const response = await fetch('/api/fichajes', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Device-Id': idDispositivo(),
                'X-Sesion': testigoSesion(),
            },
            body: JSON.stringify(fichaje)
        });

        // Fichaje fuera de la red del local (§7): se ofrece la excepción con
        // contraseña de responsable, para que un trabajo real nunca se quede
        // sin registrar por un problema de conexión.
        if (response.status === 409) {
            const data = await response.json().catch(() => ({}));
            mostrarMensaje(data.error || 'No se ha podido fichar', 'error');
            if (data.motivo === 'qr_repetido') olvidarCodigo();
            return;
        }
        if (response.status === 403) {
            const data = await response.json().catch(() => ({}));

            // Falta el código del bar, o ya ha caducado. No se ofrece salida
            // por contraseña: la gracia del código es justamente que haya que
            // estar delante del iPad.
            if (data.motivo === 'qr') {
                olvidarCodigo();
                mostrarMensaje(data.error || 'Lee el código de la pantalla del bar', 'error');
                return;
            }

            if (data.motivo === 'red') {
                btnElements.forEach(btn => btn.disabled = false);
                const seguir = confirm(
                    'Solo se puede fichar desde el local.\n\n' +
                    'Si tienes que fichar desde fuera, un responsable puede autorizarlo.\n\n' +
                    'Aceptar = pedir autorización\nCancelar = volver'
                );
                if (!seguir) return;
                const clave = prompt('Contraseña del responsable:');
                if (!clave) return;
                return registrarFichaje(tipo, horaPrevista, clave, motivo);
            }
            mostrarMensaje(data.error || 'No se ha podido fichar', 'error');
            return;
        }
        if (!response.ok) throw new Error('Error en la respuesta del servidor');

        await response.json().catch(() => ({}));

        reproducirSonidoConfirmacion();
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

        const mensajes = {
            'entrada': '✓ Entrada registrada',
            'salida': '✓ Salida registrada',
            'inicio_descanso': '✓ Descanso iniciado',
            'fin_descanso': '✓ Descanso finalizado'
        };
        mostrarMensaje(mensajes[tipo], 'success');

        const refEntrada = horarioHoy?.hora_entrada || horaPrevista;
        if (tipo === 'entrada' && refEntrada) {
            const ahoraMin = now.getHours() * 60 + now.getMinutes();
            const diff = diferenciaMinutos(ahoraMin, minutosDeHHMM(refEntrada));
            if (diff !== null && diff > MARGEN_ENTRADA_MIN) {
                setTimeout(() => mostrarMensaje(`⚠ ${diff} min tarde (entrada: ${String(refEntrada).slice(0, 5)})`, 'error'), 3100);
            } else if (diff !== null && diff >= -60) {
                setTimeout(() => mostrarMensaje(`✓ A tiempo (entrada: ${String(refEntrada).slice(0, 5)})`, 'success'), 3100);
            }
        }

        if (tipo === 'salida' && horaPrevista) {
            const ahoraMin = now.getHours() * 60 + now.getMinutes();
            const diff = diferenciaMinutos(ahoraMin, minutosDeHHMM(horaPrevista));
            if (diff !== null && diff > MARGEN_SALIDA_TARDE_MIN) {
                setTimeout(() => mostrarMensaje(`⚠ ${formatoEspera(diff)} de más (salida: ${String(horaPrevista).slice(0, 5)})`, 'error'), 3100);
            } else if (diff !== null) {
                setTimeout(() => mostrarMensaje(`✓ A tu hora (salida: ${String(horaPrevista).slice(0, 5)})`, 'success'), 3100);
            }
        }

        // Antes esto se publicaba en el parte del turno, que ve todo el equipo
        // en el iPad. A qué hora entra o sale cada uno, y desde dónde, no es
        // información de relevo: queda con el fichaje y sale en tu panel.

        actualizarEstadoBotones(tipo);
        mostrarUndoToast(tipo, fichaje);
        if (centroActual) { cargarTurnoActual(); cargarResumenPrevios(); renderTareasPanel(true); }

    } catch (error) {
        console.error('Error al registrar:', error);
        mostrarMensaje('✗ Error al guardar. Intenta de nuevo.', 'error');
    } finally {
        btnElements.forEach(btn => btn.disabled = false);
    }
}

// ── Solicitud de corrección ───────────────────────────────────
function actualizarVisibilidadHora() {
    const caso = document.getElementById('solCaso').value;
    const wrap = document.getElementById('solHoraWrap');
    if (wrap) wrap.style.display = caso === 'eliminar' ? 'none' : 'block';
}

function abrirModalSolicitud() {
    const empleado = document.getElementById('empleado').value;
    if (!empleado) {
        mostrarMensaje('Selecciona tu nombre primero', 'error');
        return;
    }
    const modal = document.getElementById('solModal');
    if (!modal) return;

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    document.getElementById('solFecha').value =
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    document.getElementById('solHora').value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    document.getElementById('solMotivo').value = '';
    document.getElementById('solCaso').value = 'crear';
    document.getElementById('solTipoFichaje').value = 'entrada';
    actualizarVisibilidadHora();
    modal.classList.add('visible');
}

function cerrarModalSolicitud() {
    document.getElementById('solModal')?.classList.remove('visible');
}

async function enviarSolicitud() {
    const empleado = document.getElementById('empleado').value;
    const tipo_solicitud = document.getElementById('solCaso').value;
    const tipo_fichaje = document.getElementById('solTipoFichaje').value;
    const fecha = document.getElementById('solFecha').value;
    const horaInput = document.getElementById('solHora').value;
    const motivo = document.getElementById('solMotivo').value.trim();
    const btnEnviar = document.getElementById('btnSolEnviar');

    if (!empleado || !fecha || !motivo) {
        mostrarMensaje('Completa el día y el motivo', 'error');
        return;
    }
    if (tipo_solicitud !== 'eliminar' && !horaInput) {
        mostrarMensaje('Indica la hora correcta', 'error');
        return;
    }

    const hora_propuesta = tipo_solicitud === 'eliminar'
        ? ''
        : (horaInput.length === 5 ? `${horaInput}:00` : horaInput);

    let fichaje_id = null;
    let hora_original = '';

    if (tipo_solicitud === 'modificar' || tipo_solicitud === 'eliminar') {
        try {
            const res = await fetch(`/api/fichajes?empleado=${encodeURIComponent(empleado)}`);
            if (res.ok) {
                const fichajes = await res.json();
                const match = fichajes.find(f => f.fecha === fecha && f.tipo === tipo_fichaje);
                if (match) {
                    fichaje_id = match.id;
                    hora_original = match.hora;
                }
            }
        } catch {}
    }

    try {
        btnEnviar.disabled = true;
        const response = await fetch('/api/solicitudes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                empleado,
                centro: centroActual || '',
                tipo_solicitud,
                fichaje_id,
                tipo_fichaje,
                fecha,
                hora_original,
                hora_propuesta,
                motivo,
            })
        });
        if (!response.ok) throw new Error();
        cerrarModalSolicitud();
        mostrarMensaje('✓ Solicitud enviada, pendiente de aprobación', 'success');
    } catch {
        mostrarMensaje('✗ Error al enviar la solicitud', 'error');
    } finally {
        btnEnviar.disabled = false;
    }
}

let pollingInterval = null;
let horarioHoy = null;       // turno del cuadrante que corresponde a este momento
let horariosCerca = [];      // ayer / hoy / mañana, con inicio y fin absolutos

function actualizarUltimaAccion() {
    const empleado = document.getElementById('empleado').value;
    const lastActionEl = document.getElementById('lastAction');

    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }

    if (!empleado) {
        lastActionEl.innerHTML = 'Selecciona tu nombre para ver tu historial';
        lastActionEl.className = 'last-action';
        actualizarEstadoBotones(null);
        cargarHorarioHoy('');
        return;
    }

    lastActionEl.innerHTML = 'Cargando último registro...';

    const fetchUltimaAccion = async () => {
        try {
            const response = await fetch(`/api/fichajes?empleado=${encodeURIComponent(empleado)}&limit=1`);
            if (!response.ok) throw new Error();
            const data = await response.json();

            if (data.length > 0) {
                const tipos = {
                    'entrada': 'Entrada',
                    'salida': 'Salida',
                    'inicio_descanso': 'Inicio de Descanso',
                    'fin_descanso': 'Fin de Descanso'
                };
                lastActionEl.innerHTML = `<strong>Último registro:</strong><br>${tipos[data[0].tipo]}<br>${data[0].hora}`;
                lastActionEl.className = 'last-action has-data';
                actualizarEstadoBotones(data[0].tipo);
                cargarHorarioHoy(empleado);
            } else {
                lastActionEl.innerHTML = 'No tienes registros aún';
                lastActionEl.className = 'last-action';
                actualizarEstadoBotones(null);
                cargarHorarioHoy(empleado);
            }
        } catch {
            lastActionEl.innerHTML = 'Error al cargar historial';
        }
    };

    fetchUltimaAccion();
    pollingInterval = setInterval(fetchUltimaAccion, 10000);
}

function fechaISO(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Convierte una fila del cuadrante en un tramo con inicio y fin absolutos.
 * Si la hora de salida no es posterior a la de entrada, el turno termina de
 * madrugada: el fin cae en el día siguiente.
 */
function tramoDeHorario(fila) {
    const ini = minutosDeHHMM(fila.hora_entrada);
    const fin = minutosDeHHMM(fila.hora_salida);
    if (ini === null || fin === null) return null;
    const base = new Date(`${fila.fecha}T00:00:00`);
    if (isNaN(base.getTime())) return null;
    const inicioMs = base.getTime() + ini * 60000;
    let finMs = base.getTime() + fin * 60000;
    if (fin <= ini) finMs += 24 * 60 * 60 * 1000;
    return { ...fila, inicioMs, finMs };
}

/** El turno más próximo a un instante dado; null si no hay ninguno razonable. */
function turnoCercaDe(ms, maxHoras = 8) {
    let mejor = null, mejorDist = Infinity;
    for (const t of horariosCerca) {
        const dist = ms < t.inicioMs ? t.inicioMs - ms
            : ms > t.finMs ? ms - t.finMs : 0;
        if (dist < mejorDist) { mejor = t; mejorDist = dist; }
    }
    if (!mejor || mejorDist > maxHoras * 3600000) return null;
    return mejor;
}

/**
 * Carga el cuadrante de ayer, hoy y mañana. Se cogen tres días porque un turno
 * de noche sigue en marcha después de medianoche y su fila es la del día
 * anterior. Se aceptan los horarios pendientes de validar: el cuadrante que
 * sube el encargado es ya la referencia real del equipo.
 */
let horarioCargadoDe = '';   // empleado y momento del último cuadrante cargado
let horarioCargadoEn = 0;

async function cargarHorarioHoy(empleado, forzar = false) {
    // El historial se refresca cada 10 s; el cuadrante no cambia tan deprisa.
    if (!forzar && empleado && empleado === horarioCargadoDe
        && Date.now() - horarioCargadoEn < 5 * 60 * 1000) return;

    horarioHoy = null;
    horariosCerca = [];
    const badge = document.getElementById('horarioBadge');
    if (badge) badge.style.display = 'none';
    horarioCargadoDe = empleado || '';
    horarioCargadoEn = Date.now();
    if (!empleado) return;

    const hoy = new Date();
    const desde = fechaISO(new Date(hoy.getTime() - 24 * 3600000));
    const hasta = fechaISO(new Date(hoy.getTime() + 24 * 3600000));

    try {
        const res = await fetch(
            `/api/horarios?empleado=${encodeURIComponent(empleado)}` +
            `&fecha_desde=${desde}&fecha_hasta=${hasta}`
        );
        if (!res.ok) return;
        const data = await res.json();

        horariosCerca = data
            .filter(h => (h.estado || '').toLowerCase() !== 'rechazado')
            .map(tramoDeHorario)
            .filter(Boolean);

        horarioHoy = turnoCercaDe(Date.now());
        if (horarioHoy && badge) {
            badge.textContent = `Horario: ${String(horarioHoy.hora_entrada).slice(0, 5)} – ${String(horarioHoy.hora_salida).slice(0, 5)}`;
            badge.style.display = 'inline-block';
        }
    } catch {
        horarioCargadoEn = 0;   // si falló, que el siguiente intento lo reintente
    }
}

function reproducirSonidoConfirmacion() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.frequency.value = 800;
        oscillator.type = 'sine';
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.1);
    } catch {}
}

function mostrarMensaje(texto, tipo) {
    const msgEl = document.getElementById('message');
    msgEl.textContent = texto;
    msgEl.className = `message ${tipo}`;
    setTimeout(() => { msgEl.className = 'message'; }, 3000);
}

let undoTimer = null;
let ultimoFichaje = null;

function mostrarUndoToast(tipo, fichaje) {
    ultimoFichaje = fichaje;
    const toast = document.getElementById('undoToast');
    const msg = document.getElementById('undoMsg');
    if (!toast || !msg) return;
    const etiquetas = {
        'entrada': 'Entrada registrada',
        'salida': 'Salida registrada',
        'inicio_descanso': 'Descanso iniciado',
        'fin_descanso': 'Descanso finalizado'
    };
    msg.textContent = etiquetas[tipo] || 'Registro guardado';
    toast.classList.add('visible');
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(() => toast.classList.remove('visible'), 8000);
}

// ── Panel turno activo ────────────────────────────────────────
let turnoRefreshInterval = null;
let ayerRefreshInterval = null;

function iniciarPanelTurno() {
    cargarTurnoActual();
    if (turnoRefreshInterval) clearInterval(turnoRefreshInterval);
    turnoRefreshInterval = setInterval(cargarTurnoActual, 30000);

    cargarResumenPrevios();
    if (ayerRefreshInterval) clearInterval(ayerRefreshInterval);
    ayerRefreshInterval = setInterval(cargarResumenPrevios, 10 * 60 * 1000);

    renderTareasPanel();
    if (tareasRefreshInterval) clearInterval(tareasRefreshInterval);
    tareasRefreshInterval = setInterval(renderTareasPanel, 60000);
}

/** Fecha de la jornada operativa en curso (corte a las 07:00). */
function fechaOperativa() {
    const now = new Date();
    const d = new Date(now);
    if (now.getHours() < 7) d.setDate(d.getDate() - 1);
    return fechaISO(d);
}

/**
 * El cuadrante del centro para la jornada de hoy.
 * Devuelve también si la consulta falló: no es lo mismo "hoy no hay nadie
 * puesto en el cuadrante" que "no he podido preguntarlo", y el panel tiene que
 * poder decir cuál de las dos es.
 */
async function fetchCuadranteDelDia() {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch(
            `/api/horarios?centro=${encodeURIComponent(centroActual)}&fecha=${fechaOperativa()}`,
            { signal: ctrl.signal, cache: 'no-store' }
        );
        clearTimeout(to);
        if (!res.ok) return { filas: [], fallo: `HTTP ${res.status}` };
        const data = await res.json();
        const filas = Array.isArray(data)
            ? data.filter(h => (h.estado || '').toLowerCase() !== 'rechazado')
            : [];
        return { filas, fallo: '' };
    } catch (e) {
        clearTimeout(to);
        return { filas: [], fallo: e?.name === 'AbortError' ? 'tardó demasiado' : 'sin conexión' };
    }
}

const claveNombre = n => String(n || '').trim().toUpperCase();

/**
 * Une el cuadrante del día con lo que se ha fichado de verdad: quién viene hoy,
 * a qué hora le toca entrar y salir, y a qué hora lo ha hecho.
 */
function construirEquipoDelDia(fichajes, cuadrante, inicioJornada) {
    const gente = new Map();

    // 1) Quién viene hoy según el cuadrante, con sus horas teóricas.
    cuadrante.forEach(h => {
        gente.set(claveNombre(h.empleado), {
            nombre: h.empleado,
            prevEntrada: String(h.hora_entrada || '').slice(0, 5),
            prevSalida: String(h.hora_salida || '').slice(0, 5),
            estado: 'pendiente',
            entradaHora: null, salidaHora: null,
            descansos: [], descansoActivo: null,
        });
    });

    // 2) Lo que ha fichado cada uno (la API devuelve el más reciente primero).
    const porEmpleado = {};
    fichajes.forEach(f => {
        if (!porEmpleado[f.empleado]) porEmpleado[f.empleado] = [];
        porEmpleado[f.empleado].push(f);
    });

    Object.entries(porEmpleado).forEach(([nombre, registros]) => {
        const idxEntrada = registros.findIndex(f => f.tipo === 'entrada');
        if (idxEntrada === -1) return;

        const entrada = registros[idxEntrada];
        const cerrado = registros[0].tipo === 'salida';
        // Un turno ya cerrado solo cuenta si empezó dentro de esta jornada; si
        // sigue abierto se muestra aunque venga de la noche anterior.
        if (cerrado && Number(entrada.timestamp) < inicioJornada) return;

        const turno = registros.slice(0, idxEntrada + 1).reverse();
        const descansos = [];
        let descansoActivo = null;
        let salidaHora = null;

        for (const r of turno) {
            if (r.tipo === 'inicio_descanso') {
                descansoActivo = { hora: r.hora, timestamp: Number(r.timestamp) };
            } else if (r.tipo === 'fin_descanso' && descansoActivo) {
                const durMin = Math.round((Number(r.timestamp) - descansoActivo.timestamp) / 60000);
                descansos.push({ inicio: descansoActivo.hora, fin: r.hora, durMin });
                descansoActivo = null;
            } else if (r.tipo === 'salida') {
                salidaHora = r.hora;
            }
        }

        const estado = cerrado ? 'terminado'
            : registros[0].tipo === 'inicio_descanso' ? 'descanso' : 'activo';

        const clave = claveNombre(nombre);
        const previo = gente.get(clave);
        gente.set(clave, {
            nombre: previo?.nombre || nombre,
            prevEntrada: previo?.prevEntrada || '',
            prevSalida: previo?.prevSalida || '',
            estado,
            entradaHora: entrada.hora,
            salidaHora,
            descansos,
            descansoActivo,
        });
    });

    // Orden de la jornada: por la hora a la que le toca entrar (o a la que
    // entró), para que se lea como el guion del día.
    const orden = p => minutosDeHHMM(p.prevEntrada) ?? minutosDeHHMM(p.entradaHora) ?? 9999;
    return [...gente.values()].sort((a, b) => orden(a) - orden(b) || a.nombre.localeCompare(b.nombre));
}

async function cargarTurnoActual() {
    const fecha = fechaOperativa();
    try {
        const inicioJornada = ventanaDiaAnterior().hasta;
        const [fichajes, cuadrante] = await Promise.all([
            fetchFichajes(Date.now() - 36 * 60 * 60 * 1000, Date.now() + 60000),
            fetchCuadranteDelDia(),
        ]);
        renderizarTurnoPanel(
            construirEquipoDelDia(fichajes, cuadrante.filas, inicioJornada),
            { fecha, sinCuadrante: cuadrante.filas.length === 0, fallo: cuadrante.fallo }
        );
    } catch (e) {
        // Un fallo aquí dejaba el panel en blanco sin decir nada, y desde fuera
        // parecía que la función se había perdido.
        renderizarTurnoPanel([], { fecha, sinCuadrante: true, fallo: e?.message || 'error inesperado' });
    }
}

/**
 * Una línea "Entrada / Salida" con la hora prevista y la real.
 * El desfase se marca en rojo solo cuando pasa de la tolerancia.
 */
function lineaFichaje(label, prev, real, tolerancia) {
    if (!prev && !real) return '';

    const diff = diferenciaMinutos(minutosDeHHMM(real), minutosDeHHMM(prev));
    const fuera = diff !== null && Math.abs(diff) > tolerancia;

    const valor = prev && real ? `${prev} <span class="turno-flecha">→</span> ${real.slice(0, 5)}`
        : real ? real.slice(0, 5)
            : `${prev} <span class="turno-pendiente-val">→ —</span>`;

    const desfase = diff === null ? ''
        : diff === 0 ? 'en punto'
            : `${diff > 0 ? '+' : '−'}${Math.abs(diff)} min`;

    return `
        <div class="turno-linea">
            <span class="turno-linea-label">${label}</span>
            <span class="turno-linea-val">${valor}</span>
            <span class="turno-linea-dur${fuera ? ' turno-linea-dur--warning' : ''}">${desfase}</span>
        </div>`;
}

function renderizarTurnoPanel(equipo, ctx = {}) {
    const panel = document.getElementById('turnoPanel');
    const lista = document.getElementById('turnoLista');
    const countEl = document.getElementById('turnoCount');
    if (!panel || !lista) return;

    panel.style.display = 'block';

    // Cuando falta el cuadrante hay que decirlo: si no, el panel enseña solo a
    // quien ha fichado y parece que la comparación con el horario ha
    // desaparecido, cuando lo que pasa es que hoy no hay horario que comparar.
    const nota = !ctx.sinCuadrante ? '' : ctx.fallo
        ? `<div class="turno-nota-cuadrante">No se ha podido consultar el horario (${ctx.fallo}).
           Se muestra solo quien ha fichado.</div>`
        : `<div class="turno-nota-cuadrante">No hay horario cargado para hoy (${ctx.fecha || ''}) en ${centroActual || 'este centro'}.
           En cuanto el encargado suba el cuadrante saldrá aquí quién entra y a qué hora.</div>`;

    if (equipo.length === 0) {
        countEl.textContent = 'Sin datos';
        lista.innerHTML = nota
            || '<div class="turno-vacio">Nadie en el local y ningún horario cargado para hoy</div>';
        return;
    }

    const dentro = equipo.filter(p => p.estado === 'activo' || p.estado === 'descanso').length;
    countEl.textContent = dentro
        ? `${dentro} en el local · ${equipo.length} hoy`
        : `${equipo.length} hoy`;

    lista.innerHTML = nota + equipo.map(p => {
        const { nombre, estado, prevEntrada, prevSalida, entradaHora, salidaHora, descansos, descansoActivo } = p;

        const minDescanso = descansoActivo
            ? Math.round((Date.now() - descansoActivo.timestamp) / 60000)
            : 0;
        const warning = minDescanso > 20;
        const variant = warning ? 'warning' : estado;

        const badgeText = {
            activo: 'En el local',
            terminado: 'Ha terminado',
            pendiente: prevEntrada ? `Entra ${prevEntrada}` : 'Prevista',
        }[estado] || (warning ? `⚠ Descanso ${minDescanso} min` : `Descanso ${minDescanso} min`);

        const descansosHtml = descansos.map(d => `
            <div class="turno-linea">
                <span class="turno-linea-label">Descanso</span>
                <span class="turno-linea-val">${d.inicio.slice(0,5)} – ${d.fin.slice(0,5)}</span>
                <span class="turno-linea-dur">${d.durMin} min</span>
            </div>`).join('');

        const descansoActivoHtml = descansoActivo ? `
            <div class="turno-linea turno-linea--${warning ? 'warning' : ''}">
                <span class="turno-linea-label">Descanso desde</span>
                <span class="turno-linea-val">${descansoActivo.hora.slice(0,5)}</span>
                <span class="turno-linea-dur${warning ? ' turno-linea-dur--warning' : ''}">${minDescanso} min${warning ? ' ⚠' : ''}</span>
            </div>` : '';

        // Quien todavía no ha llegado enseña su tramo de un vistazo; en cuanto
        // ficha, cada hora se pone al lado de la que marcaba el cuadrante.
        const detalle = estado === 'pendiente' && prevEntrada && prevSalida
            ? `<div class="turno-linea">
                   <span class="turno-linea-label">Horario</span>
                   <span class="turno-linea-val">${prevEntrada} – ${prevSalida}</span>
               </div>`
            : lineaFichaje('Entrada', prevEntrada, entradaHora, MARGEN_ENTRADA_MIN)
              + descansosHtml + descansoActivoHtml
              + lineaFichaje('Salida', prevSalida, salidaHora, MARGEN_SALIDA_TARDE_MIN);

        return `
            <div class="turno-card turno-card--${variant}">
                <div class="turno-card-header">
                    <span class="turno-dot turno-dot--${variant}"></span>
                    <span class="turno-nombre">${nombre}</span>
                    <span class="turno-badge turno-badge--${variant}">${badgeText}</span>
                </div>
                <div class="turno-detalle">${detalle}</div>
            </div>`;
    }).join('');
}

// ── Resumen: hoy (ya se fueron) + turno anterior (07:00 → 07:00) ──
function ventanaDiaAnterior() {
    const CORTE = 7;
    const now = new Date();
    const ini = new Date(now);
    ini.setHours(CORTE, 0, 0, 0);
    if (now.getHours() < CORTE) ini.setDate(ini.getDate() - 1);
    const hasta = ini.getTime();
    const desde = hasta - 24 * 60 * 60 * 1000;
    return { desde, hasta };
}

function ventanaHoy() {
    return { desde: ventanaDiaAnterior().hasta, hasta: Date.now() };
}

async function fetchFichajes(desde, hasta) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch(
            `/api/fichajes?centro=${encodeURIComponent(centroActual)}&desde=${desde}&hasta=${hasta}`,
            { signal: ctrl.signal, cache: 'no-store' }
        );
        clearTimeout(to);
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch {
        clearTimeout(to);
        return [];
    }
}

function construirResumen(fichajes) {
    // Agrupar por empleado (API devuelve ORDER BY timestamp DESC)
    const porEmpleado = {};
    fichajes.forEach(f => {
        if (!porEmpleado[f.empleado]) porEmpleado[f.empleado] = [];
        porEmpleado[f.empleado].push(f);
    });

    const resumen = [];
    Object.entries(porEmpleado).forEach(([nombre, registros]) => {
        const cron = registros.slice().reverse(); // cronológico ascendente
        const entrada = cron.find(r => r.tipo === 'entrada');
        let salidaHora = null;
        for (const r of cron) if (r.tipo === 'salida') salidaHora = r.hora;

        const descansos = [];
        let ini = null;
        for (const r of cron) {
            if (r.tipo === 'inicio_descanso') {
                ini = { hora: r.hora, timestamp: Number(r.timestamp) };
            } else if (r.tipo === 'fin_descanso' && ini) {
                const durMin = Math.round((Number(r.timestamp) - ini.timestamp) / 60000);
                descansos.push({ inicio: ini.hora, fin: r.hora, durMin });
                ini = null;
            }
        }
        const descansoSinCerrar = ini ? { hora: ini.hora } : null;

        resumen.push({
            nombre,
            entradaHora: entrada ? entrada.hora : null,
            salidaHora,
            descansos,
            descansoSinCerrar,
            ultimoTipo: registros[0] ? registros[0].tipo : null
        });
    });

    resumen.sort((a, b) => a.nombre.localeCompare(b.nombre));
    return resumen;
}

async function cargarResumenPrevios() {
    const hoyW = ventanaHoy();
    const ayerW = ventanaDiaAnterior();
    const [fHoy, fAyer] = await Promise.all([
        fetchFichajes(hoyW.desde, hoyW.hasta),
        fetchFichajes(ayerW.desde, ayerW.hasta)
    ]);

    const panel = document.getElementById('ayerPanel');
    if (panel) panel.style.display = 'block';

    // Hoy: solo quien ya se fue (último movimiento = salida). Los que
    // siguen activos ya aparecen en el panel verde "En local ahora".
    const hoy = construirResumen(fHoy).filter(p => p.ultimoTipo === 'salida');
    const ayer = construirResumen(fAyer);
    renderizarResumen(document.getElementById('hoyLista'), hoy, 'Nadie se ha ido aún hoy');
    renderizarResumen(document.getElementById('ayerLista'), ayer, 'Sin registros del día anterior');

    // El panel va plegado: el resumen de la cabecera es lo único que se ve
    // hasta que alguien lo despliega, para no alargar la pantalla.
    const resumenEl = document.getElementById('ayerResumen');
    if (resumenEl) {
        const partes = [];
        if (hoy.length) partes.push(`${hoy.length} hoy`);
        if (ayer.length) partes.push(`${ayer.length} ayer`);
        resumenEl.textContent = partes.length ? partes.join(' · ') : 'sin registros';
    }
}

function renderizarResumen(lista, items, vacioMsg) {
    if (!lista) return;

    if (items.length === 0) {
        lista.innerHTML = `<div class="turno-vacio">${vacioMsg}</div>`;
        return;
    }

    lista.innerHTML = items.map(({ nombre, entradaHora, salidaHora, descansos, descansoSinCerrar }) => {
        const completo = !!salidaHora;
        const variant = completo ? 'activo' : 'warning';
        const badgeText = completo ? 'Completo' : 'Sin salida';

        const descansosHtml = descansos.map(d => `
            <div class="turno-linea">
                <span class="turno-linea-label">Descanso</span>
                <span class="turno-linea-val">${d.inicio.slice(0,5)} – ${d.fin.slice(0,5)}</span>
                <span class="turno-linea-dur">${d.durMin} min</span>
            </div>`).join('');

        const descansoSinCerrarHtml = descansoSinCerrar ? `
            <div class="turno-linea turno-linea--warning">
                <span class="turno-linea-label">Descanso desde</span>
                <span class="turno-linea-val">${descansoSinCerrar.hora.slice(0,5)}</span>
                <span class="turno-linea-dur turno-linea-dur--warning">sin cerrar</span>
            </div>` : '';

        return `
            <div class="turno-card turno-card--${variant}">
                <div class="turno-card-header">
                    <span class="turno-dot turno-dot--${variant}"></span>
                    <span class="turno-nombre">${nombre}</span>
                    <span class="turno-badge turno-badge--${variant}">${badgeText}</span>
                </div>
                <div class="turno-detalle">
                    <div class="turno-linea">
                        <span class="turno-linea-label">Entrada</span>
                        <span class="turno-linea-val">${entradaHora ? entradaHora.slice(0,5) : '—'}</span>
                    </div>
                    ${descansosHtml}${descansoSinCerrarHtml}
                    <div class="turno-linea">
                        <span class="turno-linea-label">Salida</span>
                        <span class="turno-linea-val">${salidaHora ? salidaHora.slice(0,5) : 'Sin salida'}</span>
                    </div>
                </div>
            </div>`;
    }).join('');
}

function actualizarEstadoBotones(tipo) {
    const btnEntrada = document.getElementById('btnEntrada');
    const btnSalida = document.getElementById('btnSalida');
    const btnDescansoIni = document.getElementById('btnDescansoIni');
    const btnDescansoFin = document.getElementById('btnDescansoFin');
    const badge = document.getElementById('estadoBadge');

    if (!btnEntrada) return;

    switch (tipo) {
        case 'entrada':
        case 'fin_descanso':
            btnEntrada.disabled = true;
            btnSalida.disabled = false;
            btnDescansoIni.disabled = false;
            btnDescansoFin.disabled = true;
            if (badge) {
                badge.className = 'estado-badge en-turno';
                badge.textContent = '● En turno';
                badge.style.display = 'inline-block';
            }
            break;
        case 'inicio_descanso':
            btnEntrada.disabled = true;
            btnSalida.disabled = true;
            btnDescansoIni.disabled = true;
            btnDescansoFin.disabled = false;
            if (badge) {
                badge.className = 'estado-badge en-descanso';
                badge.textContent = '● En descanso';
                badge.style.display = 'inline-block';
            }
            break;
        case 'salida':
            btnEntrada.disabled = false;
            btnSalida.disabled = true;
            btnDescansoIni.disabled = true;
            btnDescansoFin.disabled = true;
            if (badge) {
                badge.className = 'estado-badge fuera';
                badge.textContent = '● Fuera de turno';
                badge.style.display = 'inline-block';
            }
            break;
        default:
            btnEntrada.disabled = false;
            btnSalida.disabled = true;
            btnDescansoIni.disabled = true;
            btnDescansoFin.disabled = true;
            if (badge) badge.style.display = 'none';
    }
}

// ── Tareas operativas ─────────────────────────────────────────
const rolPorEmpleado = {};
let tareasCache = null;
let tareasCacheTs = 0;

function irATareas() {
    if (!centroActual) return;
    const empleado = document.getElementById('empleado')?.value || '';
    let url = `/tareas.html?centro=${encodeURIComponent(centroActual)}`;
    if (empleado) url += `&empleado=${encodeURIComponent(empleado)}`;
    window.location.href = url;
}

async function cargarTareasCentro(forzar = false, timeoutMs = 8000) {
    if (!centroActual) return null;
    if (!forzar && tareasCache && (Date.now() - tareasCacheTs) < 30000) return tareasCache;
    try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetch(`/api/tareas?centro=${encodeURIComponent(centroActual)}`, {
            signal: ctrl.signal, cache: 'no-store'
        });
        clearTimeout(to);
        if (!res.ok) return null;
        tareasCache = await res.json();
        tareasCacheTs = Date.now();
        return tareasCache;
    } catch {
        return null;
    }
}

// El rol "mixto" cubre sala y cocina.
function tareaEsDe(tarea, rol) {
    if (!rol) return false;
    if (rol === 'mixto') return tarea.rol_responsable === 'SALA' || tarea.rol_responsable === 'COCINA';
    return rol.toUpperCase() === tarea.rol_responsable;
}

function pendientesDe(datos, empleado) {
    if (!datos || !Array.isArray(datos.tareas)) return [];
    const rol = rolPorEmpleado[empleado] || '';
    return datos.tareas.filter(t =>
        (t.estado === 'PENDIENTE' || t.estado === 'VENCIDA') && tareaEsDe(t, rol));
}

async function actualizarBadgeTareas() {
    const badge = document.getElementById('tareasBadge');
    if (!badge) return;
    const empleado = document.getElementById('empleado')?.value || '';
    if (!empleado) { badge.style.display = 'none'; return; }

    const datos = await cargarTareasCentro();
    const pend = pendientesDe(datos, empleado);
    if (pend.length) {
        badge.textContent = pend.length;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }
}

// §6.1 — al fichar entrada se informa de las tareas del turno (no bloquea).
async function avisarTareasTrasEntrada(empleado) {
    const datos = await cargarTareasCentro(true);
    const pend = pendientesDe(datos, empleado);
    if (!pend.length) return;

    const porBloque = {};
    pend.forEach(t => { porBloque[t.bloque] = (porBloque[t.bloque] || 0) + 1; });
    const etiquetas = { APERTURA: 'apertura', DURANTE_SERVICIO: 'servicio', CAMBIO_TURNO: 'cambio de turno', CIERRE: 'cierre', SEMANAL: 'semanales', MENSUAL: 'mensuales' };
    const detalle = Object.entries(porBloque)
        .map(([b, n]) => `${n} de ${etiquetas[b] || b.toLowerCase()}`)
        .join(' · ');

    setTimeout(() => {
        if (confirm(`Hola, ${empleado}. Tienes ${pend.length} tarea${pend.length !== 1 ? 's' : ''} en tu turno.\n${detalle}\n\n¿Quieres verlas ahora?`)) {
            irATareas();
        }
    }, 3200);
}

// §6.3 — control de salida contra el cuadrante + aviso de tareas pendientes.
async function confirmarSalida() {
    const empleado = document.getElementById('empleado')?.value || '';
    if (!empleado) {
        mostrarMensaje('Por favor selecciona tu nombre', 'error');
        return;
    }

    // El cuadrante manda: si aún no ha terminado su turno no se ficha, y si se
    // queda más allá de su hora tiene que explicar por qué.
    const control = await controlarSalidaConHorario(empleado);
    if (!control) return;   // salida anticipada sin autorizar, o cancelada

    // Tope corto: si las tareas tardan, se ficha la salida igualmente. El
    // registro de jornada no puede depender de este aviso.
    const datos = await cargarTareasCentro(true, 2500);
    const pend = pendientesDe(datos, empleado);

    if (pend.length) {
        const lista = pend.slice(0, 6)
            .map(t => `· ${t.nombre}${t.criticidad === 'BLOQUEANTE' ? ' (bloqueante)' : ''}`)
            .join('\n');
        const resto = pend.length > 6 ? `\n… y ${pend.length - 6} más` : '';
        const seguir = confirm(
            `Te quedan ${pend.length} tarea${pend.length !== 1 ? 's' : ''} pendientes de tu turno:\n${lista}${resto}\n\n` +
            `Aceptar = fichar salida igualmente\nCancelar = ir a completarlas`
        );
        if (!seguir) { irATareas(); return; }

        // Queda constancia de la salida con pendientes; el encargado lo verá.
        try {
            await fetch('/api/tareas?accion=evento-salida', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    empleado,
                    centro: centroActual || '',
                    device_id: localStorage.getItem('device_id') || '',
                    pendientes: pend.map(t => ({ id: t.id, nombre: t.nombre, criticidad: t.criticidad })),
                }),
            });
        } catch {}
    }

    // El motivo viaja con el fichaje y aparece en el panel de gerencia. No se
    // publica en el parte del turno: el relevo necesita saber que se ha
    // acabado el vermut, no a qué hora salió cada compañero.
    await registrarFichaje('salida', control.horaPrevista, '', control.motivo);
}

// ── Panel de tareas en la pantalla de fichaje ─────────────────
// El equipo marca la tarea aquí mismo: nombre + quién la ha hecho + Guardar.
let listaEmpleados = [];
let tareasRefreshInterval = null;
let tareasHechasAbierto = false;   // se recuerda entre refrescos
const fotosTarea = {};   // instancia_id → { b64, origen }

const BLOQUE_TXT = {
    APERTURA: 'Apertura', DURANTE_SERVICIO: 'Durante el servicio',
    CAMBIO_TURNO: 'Cambio de turno', CIERRE: 'Cierre',
    SEMANAL: 'Semanal', MENSUAL: 'Mensual',
};
const ORDEN_BLOQUES = ['APERTURA', 'DURANTE_SERVICIO', 'CAMBIO_TURNO', 'CIERRE', 'SEMANAL', 'MENSUAL'];

function escTarea(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function horaCorta(ts) {
    return ts ? new Date(Number(ts)).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '';
}

async function renderTareasPanel(forzar = false) {
    const panel = document.getElementById('tareasPanel');
    const lista = document.getElementById('tareasLista');
    const countEl = document.getElementById('tareasCount');
    if (!panel || !lista || !centroActual) return;

    const datos = await cargarTareasCentro(forzar);
    // Si no hay tareas configuradas para el centro, el panel no estorba.
    if (!datos || !Array.isArray(datos.tareas) || datos.tareas.length === 0) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';
    const r = datos.resumen || { total: 0, completadas: 0 };
    countEl.textContent = `${r.completadas}/${r.total} hechas`;

    const ahora = Date.now();

    // Lo que interesa ver es lo que falta: las cerradas se agrupan plegadas al
    // final para que la lista no crezca según avanza el día.
    const cerrada = t => ['COMPLETADA', 'COMPLETADA_TARDIA', 'NO_APLICA'].includes(t.estado);
    const pendientes = datos.tareas.filter(t => !cerrada(t));
    const hechas = datos.tareas.filter(cerrada);

    let html = '';
    for (const bloque of ORDEN_BLOQUES) {
        const delBloque = pendientes.filter(t => t.bloque === bloque);
        if (!delBloque.length) continue;
        html += `<div class="tarea-bloque">${BLOQUE_TXT[bloque] || bloque}</div>`;
        html += delBloque.map(t => filaTarea(t, ahora)).join('');
    }

    if (!pendientes.length) {
        html += `<div class="tareas-todo-hecho">✓ Todas las tareas de hoy están hechas</div>`;
    }

    if (hechas.length) {
        html += `
            <button type="button" class="panel-toggle tareas-hechas-toggle" id="tareasHechasToggle"
                    aria-expanded="${tareasHechasAbierto ? 'true' : 'false'}" aria-controls="tareasHechasCuerpo">
                <span class="tarea-bloque" style="margin:0">Ya hechas · ${hechas.length}</span>
                <span class="panel-flecha" aria-hidden="true">▾</span>
            </button>
            <div id="tareasHechasCuerpo" class="panel-cuerpo"${tareasHechasAbierto ? '' : ' hidden'}>
                ${hechas.map(t => filaTarea(t, ahora)).join('')}
            </div>`;
    }

    lista.innerHTML = html;

    // El grupo se refresca cada minuto: hay que recordar si estaba abierto,
    // o se cerraría solo mientras alguien lo está mirando.
    const toggle = document.getElementById('tareasHechasToggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            const cuerpo = document.getElementById('tareasHechasCuerpo');
            tareasHechasAbierto = !tareasHechasAbierto;
            toggle.setAttribute('aria-expanded', tareasHechasAbierto ? 'true' : 'false');
            if (cuerpo) cuerpo.hidden = !tareasHechasAbierto;
        });
    }

    lista.querySelectorAll('[data-guardar]').forEach(b =>
        b.addEventListener('click', () => guardarTarea(Number(b.dataset.guardar))));
    lista.querySelectorAll('[data-tfoto]').forEach(btn =>
        btn.addEventListener('click', () => abrirCamaraTarea(Number(btn.dataset.tfoto))));
}

function filaTarea(t, ahora) {
    const hecha = t.estado === 'COMPLETADA' || t.estado === 'COMPLETADA_TARDIA';
    const noAplica = t.estado === 'NO_APLICA';
    const vencida = t.estado === 'VENCIDA';
    const futura = ahora < Number(t.ventana_inicio_ts);
    const cls = hecha ? 'hecha' : vencida ? 'vencida' : futura ? 'futura' : '';

    const nombre = `<div class="tarea-nom">${escTarea(t.nombre)}
        <small>${horaCorta(t.ventana_inicio_ts)}–${horaCorta(t.ventana_fin_ts)} · ${escTarea(t.rol_responsable)}${t.criticidad === 'BLOQUEANTE' ? ' · <span class="tarea-bloq">imprescindible</span>' : ''}</small>
    </div>`;

    if (hecha) {
        // Se registra igual, pero se distingue si se hizo fuera de su franja.
        const tarde = Number(t.fuera_de_plazo) === 1;
        return `<div class="tarea-row hecha"><span class="tarea-punto"></span>${nombre}
            <span class="tarea-hecha-info${tarde ? ' tarde' : ''}">✓ ${escTarea(t.completada_por)} · ${horaCorta(t.completada_ts_servidor)}${tarde ? ' ⚠' : ''}</span></div>`;
    }
    if (noAplica) {
        return `<div class="tarea-row"><span class="tarea-punto"></span>${nombre}
            <span class="tarea-hecha-info" style="color:#6b7280">No aplica</span></div>`;
    }
    // Pendiente, vencida o aún por llegar: siempre se puede marcar
    const opciones = ['<option value="">¿Quién?</option>']
        .concat(listaEmpleados.map(n => `<option value="${escTarea(n)}">${escTarea(n)}</option>`))
        .join('');

    let extras = '';
    const tipo = t.tipo_evidencia;
    if (tipo === 'NUMERO' || tipo === 'FOTO+NUMERO') {
        let cfg = {};
        try { cfg = JSON.parse(t.evidencia_config || '{}'); } catch {}
        extras += `<input type="number" step="0.1" inputmode="decimal" class="tarea-num"
                    id="tnum-${t.id}" placeholder="${escTarea(cfg.unidad || 'valor')}">`;
    }
    if (tipo === 'TEXTO') {
        extras += `<input type="text" class="tarea-txt" id="ttxt-${t.id}" placeholder="Anota...">`;
    }
    if (tipo === 'FOTO' || tipo === 'FOTO+NUMERO') {
        extras += `<button type="button" class="tarea-foto-btn" id="tfotolbl-${t.id}" data-tfoto="${t.id}">📷</button>`;
    }

    return `<div class="tarea-row ${cls}"><span class="tarea-punto"></span>${nombre}
        <select class="tarea-sel" id="tsel-${t.id}">${opciones}</select>
        ${extras}
        <button type="button" class="tarea-guardar" data-guardar="${t.id}">Guardar</button>
        <div class="tarea-error" id="terr-${t.id}"></div>
    </div>`;
}

/**
 * Reescala una imagen a 1024 px y la devuelve en JPEG.
 * Estaba escrito tres veces en el proyecto; ahora vive en un solo sitio.
 */
function aJpegPequeno(fuente, anchoNatural, altoNatural) {
    const MAX = 1024;
    let w = anchoNatural, h = altoNatural;
    if (w > MAX || h > MAX) {
        const f = Math.min(MAX / w, MAX / h);
        w = Math.round(w * f); h = Math.round(h * f);
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(fuente, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.6);
}

/**
 * Cámara dentro de la propia app.
 *
 * Antes esto era un <input type="file">, y aunque llevara `capture` el iPhone
 * seguía ofreciendo la fototeca: se podía "hacer" la tarea con una foto vieja.
 * Abriendo la cámara aquí no hay galería que elegir. Aun así, la prueba de que
 * la persona está en el bar no la da la foto, sino el código del iPad.
 */
async function abrirCamaraTarea(id) {
    const marcarLista = () => {
        const lbl = document.getElementById(`tfotolbl-${id}`);
        if (lbl) { lbl.classList.add('lista'); lbl.textContent = '✓'; }
    };

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' } }, audio: false,
        });
    } catch {
        // Sin permiso de cámara no se deja a nadie tirado: se ofrece el
        // selector de siempre, y esa evidencia queda marcada en el servidor.
        return respaldoSelectorFoto(id, marcarLista);
    }

    const modal = document.getElementById('camModal');
    const video = document.getElementById('camVideo');
    video.srcObject = stream;
    await video.play().catch(() => {});
    modal.classList.add('visible');

    const cerrar = () => {
        stream.getTracks().forEach(t => t.stop());
        video.srcObject = null;
        modal.classList.remove('visible');
    };

    document.getElementById('camDisparar').onclick = () => {
        fotosTarea[id] = { b64: aJpegPequeno(video, video.videoWidth, video.videoHeight), origen: 'camara' };
        marcarLista();
        cerrar();
    };
    document.getElementById('camCancelar').onclick = cerrar;
}

/** Último recurso si el móvil no da permiso de cámara. */
function respaldoSelectorFoto(id, marcarLista) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.capture = 'environment';
    inp.onchange = ev => {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                fotosTarea[id] = { b64: aJpegPequeno(img, img.width, img.height), origen: 'selector' };
                marcarLista();
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    };
    inp.click();
}

function errorEnFila(id, texto) {
    const el = document.getElementById(`terr-${id}`);
    if (el) el.textContent = texto || '';
    if (texto) mostrarMensaje(texto, 'error');
}

async function guardarTarea(id) {
    const sel = document.getElementById(`tsel-${id}`);
    const btn = document.querySelector(`[data-guardar="${id}"]`);
    const quien = sel ? sel.value : '';
    errorEnFila(id, '');
    if (!quien) {
        errorEnFila(id, 'Elige quién ha hecho la tarea');
        return;
    }

    const body = {
        instancia_id: id,
        empleado: quien,
        device_id: idDispositivo(),
        sesion: testigoSesion(),   // con sesión iniciada no hace falta teclear el PIN
        ts_cliente: Date.now(),
        origen_ui: 'inicio',
        idempotency_key: `${id}-${quien}-${Date.now()}`,
    };
    const num = document.getElementById(`tnum-${id}`);
    if (num && num.value !== '') body.valor_numerico = num.value;
    const txt = document.getElementById(`ttxt-${id}`);
    if (txt) body.texto = txt.value;
    if (fotosTarea[id]) {
        body.foto_b64 = fotosTarea[id].b64;
        body.origen_captura = fotosTarea[id].origen;
        // Las tareas con foto exigen estar en el bar: viaja el código leído.
        body.qr = codigoDelBar();
    }

    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    try {
        const res = await fetch('/api/tareas?accion=completar', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Auth-Token': sessionStorage.getItem('adminToken') || sessionStorage.getItem('encargadoToken') || '',
                'X-Device-Id': idDispositivo(),
            },
            body: JSON.stringify(body),
        });
        let data = await res.json().catch(() => ({}));

        // Si a esa persona le han asignado PIN, se lo pedimos y reintentamos.
        // Mientras no tenga PIN, guardar es un solo toque.
        if (!res.ok && res.status === 403 && /PIN/i.test(data.error || '')) {
            const pin = prompt(`PIN de ${quien}:`);
            if (!pin) {
                if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
                return;
            }
            const res2 = await fetch('/api/tareas?accion=completar', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Auth-Token': sessionStorage.getItem('adminToken') || sessionStorage.getItem('encargadoToken') || '',
                },
                body: JSON.stringify({ ...body, pin, idempotency_key: `${id}-${quien}-${Date.now()}` }),
            });
            data = await res2.json().catch(() => ({}));
            if (!res2.ok) {
                errorEnFila(id, data.error || 'No se pudo guardar la tarea');
                if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
                return;
            }
        } else if (!res.ok) {
            errorEnFila(id, data.error || 'No se pudo guardar la tarea');
            if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
            return;
        }
        delete fotosTarea[id];
        const fueraTxt = data.momento === 'vencida' ? ' (fuera de su franja)'
                       : data.momento === 'antes_de_tiempo' ? ' (antes de su franja)' : '';
        mostrarMensaje(data.aviso ? `✓ Guardada${fueraTxt}. ${data.aviso}`
                                  : `✓ ${quien}: tarea guardada${fueraTxt}`, 'success');
        renderTareasPanel(true);
    } catch {
        errorEnFila(id, 'Error de conexión al guardar la tarea');
        if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    }
}

// ── Libro de turno e incidencias ──────────────────────────────
// Lo que el turno saliente deja dicho al entrante, y las averías del local.
let notasRefreshInterval = null;
let notaTipoActual = 'nota';
let notaFotoB64 = null;

async function cargarNotas() {
    const panel = document.getElementById('notasPanel');
    const lista = document.getElementById('notasLista');
    const countEl = document.getElementById('notasCount');
    if (!panel || !lista || !centroActual) return;

    let datos = null;
    try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(`/api/turno-notas?centro=${encodeURIComponent(centroActual)}`,
            { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(to);
        if (!res.ok) throw new Error();
        datos = await res.json();
    } catch {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';

    // Rellenar el desplegable de autor con la gente del centro
    const selAutor = document.getElementById('notaAutor');
    if (selAutor && selAutor.options.length <= 1 && listaEmpleados.length) {
        selAutor.innerHTML = '<option value="">¿Quién avisa?</option>' +
            listaEmpleados.map(n => `<option value="${escTarea(n)}">${escTarea(n)}</option>`).join('');
    }

    const incidencias = datos.incidencias || [];
    const faltas = datos.faltas || [];
    const notas = datos.notas || [];
    const abiertas = incidencias.filter(i => i.estado !== 'resuelta').length;
    const faltan = faltas.filter(f => f.estado !== 'resuelta').length;

    const resumen = [];
    if (abiertas) resumen.push(`${abiertas} sin arreglar`);
    if (faltan) resumen.push(`${faltan} por pedir`);
    if (!resumen.length && notas.length) resumen.push(`${notas.length} aviso${notas.length !== 1 ? 's' : ''}`);
    countEl.textContent = resumen.join(' · ') || 'Todo en orden';

    if (!incidencias.length && !faltas.length && !notas.length) {
        lista.innerHTML = '<div class="notas-vacio">Nada que reportar. Usa los botones si hay algo que el siguiente turno deba saber, algo roto o algún producto agotado.</div>';
        return;
    }

    const grupo = (titulo, items, render) =>
        items.length ? `<div class="notas-grupo">${titulo}</div>` + items.map(render).join('') : '';

    lista.innerHTML =
        grupo('Roto o averiado', incidencias, itemIncidencia) +
        grupo('Falta / hay que pedir', faltas, itemIncidencia) +
        grupo('Para el siguiente turno', notas, itemNota);

    lista.querySelectorAll('[data-visto]').forEach(b =>
        b.addEventListener('click', () => marcarVisto(Number(b.dataset.visto))));
    lista.querySelectorAll('[data-incestado]').forEach(b =>
        b.addEventListener('click', () => cambiarEstadoIncidencia(Number(b.dataset.incestado), b.dataset.estado)));
}

function fechaCorta(ts) {
    const d = new Date(Number(ts));
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }).replace('.', '')
        + ' ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function itemIncidencia(i) {
    const esFalta = i.tipo === 'falta';
    const resuelta = i.estado === 'resuelta';
    const cls = `nota-item ${esFalta ? 'falta' : 'inc'}${i.prioridad === 'alta' ? ' alta' : ''}${resuelta ? ' resuelta' : ''}`;
    const etiqueta = esFalta
        ? (resuelta ? '✓ Repuesto' : i.estado === 'en_curso' ? '⏳ Pedido' : '🛒 Falta')
        : (resuelta ? '✓ Arreglado' : i.estado === 'en_curso' ? '⏳ En curso' : '⚠ Sin arreglar');
    const foto = Number(i.tiene_foto) === 1
        ? ` · <a href="/api/turno-notas?foto=${i.id}" target="_blank" rel="noopener">ver foto</a>` : '';

    let acciones = '';
    if (!resuelta) {
        const intermedio = esFalta ? 'Ya pedido' : 'En curso';
        const final = esFalta ? 'Ya repuesto' : 'Arreglado';
        acciones = `
            ${i.estado === 'abierta' ? `<button type="button" class="nota-btn-mini" data-incestado="${i.id}" data-estado="en_curso">${intermedio}</button>` : ''}
            <button type="button" class="nota-btn-mini" data-incestado="${i.id}" data-estado="resuelta">${final}</button>`;
    }

    return `<div class="${cls}">
        <div class="nota-texto">${escTarea(i.texto)}</div>
        <div class="nota-meta">
            <strong>${etiqueta}</strong>
            <span>${escTarea(i.autor || 'Sin nombre')} · ${fechaCorta(i.creado_en)}${foto}</span>
            ${resuelta && i.resuelto_por ? `<span>Por ${escTarea(i.resuelto_por)}</span>` : ''}
            ${acciones}
        </div>
    </div>`;
}

function itemNota(n) {
    const foto = Number(n.tiene_foto) === 1
        ? ` · <a href="/api/turno-notas?foto=${n.id}" target="_blank" rel="noopener">ver foto</a>` : '';
    const vistos = (n.vistos || []).length
        ? `<span class="nota-vistos">Visto por ${n.vistos.map(escTarea).join(', ')}</span>`
        : `<button type="button" class="nota-btn-mini" data-visto="${n.id}">Marcar como leído</button>`;

    return `<div class="nota-item">
        <div class="nota-texto">${escTarea(n.texto)}</div>
        <div class="nota-meta">
            <span>${escTarea(n.autor || 'Sin nombre')} · ${fechaCorta(n.creado_en)}${foto}</span>
            ${vistos}
        </div>
    </div>`;
}

function abrirFormNota(tipo) {
    notaTipoActual = tipo;
    const form = document.getElementById('notaForm');
    const prio = document.getElementById('notaPrioridad');
    const txt = document.getElementById('notaTexto');
    if (!form) return;

    form.classList.add('abierto');
    if (prio) prio.style.display = tipo === 'nota' ? 'none' : 'block';
    if (txt) {
        txt.placeholder =
            tipo === 'incidencia' ? 'Qué está roto: la nevera no enfría, silla rota...' :
            tipo === 'falta'      ? 'Qué falta y cuánto: zumo de naranja (2 cajas), servilletas...' :
                                    'Qué tiene que saber el siguiente turno...';
        txt.focus();
    }
    // Si hay alguien seleccionado arriba, lo damos por autor
    const empleado = document.getElementById('empleado')?.value;
    const selAutor = document.getElementById('notaAutor');
    if (empleado && selAutor) selAutor.value = empleado;
}

async function enviarNota() {
    const txt = document.getElementById('notaTexto');
    const autor = document.getElementById('notaAutor')?.value || '';
    const prioridad = document.getElementById('notaPrioridad')?.value || 'normal';
    const btn = document.getElementById('btnEnviarNota');
    const texto = (txt?.value || '').trim();

    if (!texto) { mostrarMensaje('Escribe el aviso', 'error'); return; }
    if (!autor) { mostrarMensaje('Indica quién avisa', 'error'); return; }

    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    try {
        const res = await fetch('/api/turno-notas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                centro: centroActual, tipo: notaTipoActual, texto, autor, prioridad,
                foto_b64: notaFotoB64 || undefined,
                device_id: localStorage.getItem('device_id') || '',
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { mostrarMensaje(data.error || 'No se pudo publicar', 'error'); return; }

        txt.value = '';
        notaFotoB64 = null;
        const lbl = document.getElementById('notaFotoLbl');
        if (lbl) { lbl.classList.remove('lista'); lbl.childNodes[0].nodeValue = '📷'; }
        document.getElementById('notaForm')?.classList.remove('abierto');
        mostrarMensaje(
            notaTipoActual === 'incidencia' ? '✓ Avería registrada' :
            notaTipoActual === 'falta'      ? '✓ Apuntado para pedir' :
                                              '✓ Aviso publicado', 'success');
        cargarNotas();
    } catch {
        mostrarMensaje('Error de conexión', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Publicar'; }
    }
}

async function marcarVisto(id) {
    const empleado = document.getElementById('empleado')?.value
        || document.getElementById('notaAutor')?.value || '';
    if (!empleado) { mostrarMensaje('Selecciona antes tu nombre', 'error'); return; }
    try {
        await fetch('/api/turno-notas', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, accion: 'visto', empleado }),
        });
        cargarNotas();
    } catch { mostrarMensaje('No se pudo marcar como leído', 'error'); }
}

async function cambiarEstadoIncidencia(id, estado) {
    const empleado = document.getElementById('empleado')?.value || '';
    let resolucion = '';
    if (estado === 'resuelta') {
        resolucion = prompt('¿Cómo se ha resuelto? (opcional)') || '';
    }
    try {
        const res = await fetch('/api/turno-notas', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id, estado, empleado, resolucion,
                centro: centroActual, device_id: localStorage.getItem('device_id') || '',
            }),
        });
        if (!res.ok) { mostrarMensaje('No se pudo actualizar', 'error'); return; }
        mostrarMensaje(estado === 'resuelta' ? '✓ Marcado como resuelto' : '✓ Actualizado', 'success');
        cargarNotas();
    } catch { mostrarMensaje('Error de conexión', 'error'); }
}

function configurarNotas() {
    document.getElementById('btnNuevaNota')?.addEventListener('click', () => abrirFormNota('nota'));
    document.getElementById('btnNuevaIncidencia')?.addEventListener('click', () => abrirFormNota('incidencia'));
    document.getElementById('btnNuevaFalta')?.addEventListener('click', () => abrirFormNota('falta'));
    document.getElementById('btnEnviarNota')?.addEventListener('click', enviarNota);
    document.getElementById('notaFoto')?.addEventListener('change', ev => {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const MAX = 1024;
                let { width: w, height: h } = img;
                if (w > MAX || h > MAX) {
                    const f = Math.min(MAX / w, MAX / h);
                    w = Math.round(w * f); h = Math.round(h * f);
                }
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                c.getContext('2d').drawImage(img, 0, 0, w, h);
                notaFotoB64 = c.toDataURL('image/jpeg', 0.6);
                const lbl = document.getElementById('notaFotoLbl');
                if (lbl) { lbl.classList.add('lista'); lbl.childNodes[0].nodeValue = '✓ '; }
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });

    cargarNotas();
    if (notasRefreshInterval) clearInterval(notasRefreshInterval);
    notasRefreshInterval = setInterval(cargarNotas, 2 * 60 * 1000);
}

// ── Control de entradas anticipadas ───────────────────────────
// Al fichar entrada se le pregunta SIEMPRE a qué hora empieza su turno: los
// horarios varían de un día a otro, así que preguntarlo es más fiable que
// depender de un cuadrante subido. Si aún no le toca, no se ficha, y se le
// dice cuánto falta. La hora declarada se guarda con el fichaje.
const MARGEN_ENTRADA_MIN = 5;
const habitualPorEmpleado = {};  // empleado → JSON {1..7: "HH:MM"} de su ficha

/** Hora de entrada habitual del empleado para hoy (solo para proponerla). */
function horaHabitualDeHoy(empleado) {
    const bruto = habitualPorEmpleado[empleado];
    if (!bruto) return null;
    let horario;
    try { horario = JSON.parse(bruto); } catch { return null; }
    const dow = new Date().getDay();          // 0=domingo
    const clave = dow === 0 ? 7 : dow;        // 1=lunes ... 7=domingo
    return horario[clave] || horario[String(clave)] || null;
}

function minutosDeHHMM(hhmm) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '').trim());
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
}

/**
 * Minutos de diferencia entre dos horas del reloj, resueltos por el lado más
 * cercano: así un turno que cruza medianoche no parece medio día de desfase.
 */
function diferenciaMinutos(minA, minB) {
    if (minA === null || minB === null) return null;
    let d = minA - minB;
    if (d > 12 * 60) d -= 24 * 60;
    if (d < -12 * 60) d += 24 * 60;
    return d;
}

function formatoEspera(min) {
    if (min >= 60) {
        const h = Math.floor(min / 60);
        const resto = min % 60;
        return resto ? `${h} h y ${resto} min` : `${h} h`;
    }
    return `${min} min`;
}

function cerrarEntModal() {
    document.getElementById('entModal')?.classList.remove('visible');
    document.getElementById('entPaso1').style.display = 'block';
    document.getElementById('entPaso2').style.display = 'none';
}

/** Abre el diálogo y devuelve la hora declarada, o null si cancela. */
function preguntarHoraEntrada(empleado) {
    return new Promise(resolve => {
        const modal = document.getElementById('entModal');
        const input = document.getElementById('entHora');
        if (!modal || !input) { resolve(null); return; }

        // Se propone la hora que ya conocemos (horario de la semana o el
        // habitual), pero siempre se puede cambiar: manda lo que él diga.
        const sugerida = horarioHoy?.hora_entrada || horaHabitualDeHoy(empleado) || '';
        input.value = sugerida ? sugerida.slice(0, 5) : '';

        document.getElementById('entPaso1').style.display = 'block';
        document.getElementById('entPaso2').style.display = 'none';
        modal.classList.add('visible');
        setTimeout(() => input.focus(), 50);

        const limpiar = () => {
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
        };
        const btnOk = document.getElementById('entContinuar');
        const btnCancel = document.getElementById('entCancelar');

        function onOk() {
            const valor = input.value;
            if (minutosDeHHMM(valor) === null) {
                mostrarMensaje('Indica tu hora de entrada', 'error');
                return;
            }
            limpiar();
            resolve(valor);
        }
        function onCancel() {
            limpiar();
            cerrarEntModal();
            resolve(null);
        }
        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
    });
}

async function confirmarEntrada() {
    const empleado = document.getElementById('empleado')?.value || '';
    if (!empleado) {
        mostrarMensaje('Por favor selecciona tu nombre', 'error');
        return;
    }

    const horaPrevista = await preguntarHoraEntrada(empleado);
    if (!horaPrevista) return;

    const prevMin = minutosDeHHMM(horaPrevista);
    const ahora = new Date();
    const ahoraMin = ahora.getHours() * 60 + ahora.getMinutes();

    // Diferencia resuelta al lado más cercano del reloj, para que los turnos
    // que cruzan medianoche no parezcan medio día de adelanto.
    let faltan = prevMin - ahoraMin;
    if (faltan > 12 * 60) faltan -= 24 * 60;
    if (faltan < -12 * 60) faltan += 24 * 60;

    // Le toca ya (o va tarde): se ficha con normalidad.
    if (faltan <= MARGEN_ENTRADA_MIN) {
        cerrarEntModal();
        registrarFichaje('entrada', horaPrevista);
        return;
    }

    // Aún no empieza: se le explica cuánto falta y desde cuándo puede fichar.
    const desde = new Date(ahora.getTime() + (faltan - MARGEN_ENTRADA_MIN) * 60000);
    const puedeDesde = `${String(desde.getHours()).padStart(2, '0')}:${String(desde.getMinutes()).padStart(2, '0')}`;

    document.getElementById('entFalta').textContent =
        `Tu jornada no empieza hasta dentro de ${formatoEspera(faltan)}.`;
    document.getElementById('entDesde').textContent =
        `Podrás fichar a partir de las ${puedeDesde}.`;
    document.getElementById('entPaso1').style.display = 'none';
    document.getElementById('entPaso2').style.display = 'block';

    document.getElementById('entEntendido').onclick = () => cerrarEntModal();

    // Vía de excepción: si de verdad tiene que empezar antes, un responsable lo
    // autoriza y ese tiempo queda registrado. Un fichaje que no refleja el
    // trabajo real no protege a nadie.
    document.getElementById('entAutorizar').onclick = async () => {
        const clave = prompt('Contraseña del responsable para autorizar la entrada anticipada:');
        if (!clave) return;
        if (!(await validarResponsable(clave))) {
            mostrarMensaje('✗ Contraseña incorrecta: no se ha fichado', 'error');
            return;
        }
        cerrarEntModal();
        await registrarFichaje('entrada', horaPrevista, '',
            `Entrada anticipada autorizada por un responsable (${formatoEspera(faltan)} antes de las ${horaPrevista}).`);
    };
}

// ── Control de salidas contra el cuadrante ────────────────────
// Ahora que el horario está cargado, la hora de salida también tiene
// referencia: salir antes no se permite (se le recuerda su hora), y salir más
// tarde obliga a explicar el motivo, que queda con el fichaje y en el parte.
const MARGEN_SALIDA_PRONTO_MIN = 5;   // tolerancia para fichar justo antes
const MARGEN_SALIDA_TARDE_MIN = 15;   // a partir de aquí hay que explicarlo

function cerrarSalModal() {
    document.getElementById('salModal')?.classList.remove('visible');
    const p1 = document.getElementById('salPaso1');
    const p2 = document.getElementById('salPaso2');
    if (p1) p1.style.display = 'none';
    if (p2) p2.style.display = 'none';
}

/** El turno del cuadrante al que corresponde esta salida, o null. */
async function turnoDeLaSalida(empleado) {
    if (!horariosCerca.length) await cargarHorarioHoy(empleado, true);
    if (!horariosCerca.length) return null;

    // Si sabemos a qué hora entró, el turno es el que empezaba cerca de esa
    // hora: es más fiable que mirar solo el reloj de ahora.
    let referencia = Date.now();
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2500);
        const res = await fetch(
            `/api/fichajes?empleado=${encodeURIComponent(empleado)}&limit=6`,
            { signal: ctrl.signal }
        );
        clearTimeout(t);
        if (res.ok) {
            const data = await res.json();
            const entrada = data.find(f => f.tipo === 'entrada');
            if (entrada?.timestamp) referencia = Number(entrada.timestamp);
        }
    } catch {}

    return turnoCercaDe(referencia);
}

/** Paso «todavía no terminas»: no se ficha salvo que lo autorice un responsable. */
function avisarSalidaAnticipada(horaSalida, faltan) {
    return new Promise(resolve => {
        const modal = document.getElementById('salModal');
        // Respaldo si la pantalla viene de una versión antigua en caché: el
        // control se mantiene, solo cambia el aspecto del aviso.
        if (!modal) {
            const pedir = confirm(
                `Tu turno termina a las ${horaSalida}. Todavía te quedan ${formatoEspera(faltan)}.\n\n` +
                `Aceptar = pedir que un responsable lo autorice\nCancelar = volver`
            );
            if (!pedir) { resolve('cancelar'); return; }
            const clave = prompt('Contraseña del responsable:');
            if (!clave) { resolve('cancelar'); return; }
            validarResponsable(clave)
                .then(ok => resolve(ok ? 'autorizado' : 'cancelar'))
                .catch(() => resolve('cancelar'));
            return;
        }

        document.getElementById('salFin').textContent =
            `Tu turno termina a las ${horaSalida}.`;
        document.getElementById('salFalta').textContent =
            `Todavía te quedan ${formatoEspera(faltan)}.`;
        document.getElementById('salPaso1').style.display = 'block';
        document.getElementById('salPaso2').style.display = 'none';
        modal.classList.add('visible');

        document.getElementById('salEntendido').onclick = () => {
            cerrarSalModal();
            resolve('cancelar');
        };

        // Vía de excepción: si de verdad tiene que irse antes (se encuentra mal,
        // le mandan a casa), un responsable lo autoriza y queda registrado. Un
        // fichaje que no refleja la jornada real no protege a nadie.
        document.getElementById('salAutorizar').onclick = async () => {
            const clave = prompt('Contraseña del responsable para autorizar la salida anticipada:');
            if (!clave) return;
            if (!(await validarResponsable(clave))) {
                mostrarMensaje('✗ Contraseña incorrecta: no se ha fichado', 'error');
                return;
            }
            cerrarSalModal();
            resolve('autorizado');
        };
    });
}

/** Paso «sales más tarde»: motivo obligatorio. Devuelve el texto o null. */
function pedirMotivoSalida(horaSalida, deMas) {
    return new Promise(resolve => {
        const modal = document.getElementById('salModal');
        const input = document.getElementById('salMotivo');
        if (!modal || !input) {
            const texto = prompt(
                `Tu turno terminaba a las ${horaSalida} y llevas ${formatoEspera(deMas)} de más.\n¿Por qué sales más tarde?`
            );
            resolve(texto === null ? null : texto.trim());
            return;
        }

        document.getElementById('salTardeTxt').textContent =
            `Tu turno terminaba a las ${horaSalida} y llevas ${formatoEspera(deMas)} de más. Cuéntanos por qué.`;
        input.value = '';
        document.getElementById('salPaso1').style.display = 'none';
        document.getElementById('salPaso2').style.display = 'block';
        modal.classList.add('visible');
        setTimeout(() => input.focus(), 50);

        document.getElementById('salConfirmar').onclick = () => {
            const texto = input.value.trim();
            if (texto.length < 5) {
                mostrarMensaje('Explica brevemente por qué sales más tarde', 'error');
                return;
            }
            cerrarSalModal();
            resolve(texto);
        };
        document.getElementById('salCancelar').onclick = () => {
            cerrarSalModal();
            resolve(null);
        };
    });
}

/**
 * Compara la hora actual con la de salida del cuadrante.
 * Devuelve null si la salida no debe registrarse, o {horaPrevista, motivo, nota}.
 * Sin cuadrante para ese turno, la salida sigue su curso normal.
 */
async function controlarSalidaConHorario(empleado) {
    const turno = await turnoDeLaSalida(empleado);
    if (!turno) return { horaPrevista: '', motivo: '' };

    const horaSalida = String(turno.hora_salida).slice(0, 5);
    const diff = Math.round((Date.now() - turno.finMs) / 60000);

    if (diff < -MARGEN_SALIDA_PRONTO_MIN) {
        const faltan = -diff;
        const r = await avisarSalidaAnticipada(horaSalida, faltan);
        if (r !== 'autorizado') return null;
        return {
            horaPrevista: horaSalida,
            motivo: `Salida anticipada autorizada por un responsable (${formatoEspera(faltan)} antes de las ${horaSalida}).`,
        };
    }

    if (diff > MARGEN_SALIDA_TARDE_MIN) {
        const motivo = await pedirMotivoSalida(horaSalida, diff);
        if (motivo === null) return null;
        return {
            horaPrevista: horaSalida,
            motivo,
        };
    }

    return { horaPrevista: horaSalida, motivo: '' };
}

/**
 * Acepta la contraseña de gerencia o la del encargado.
 * Es una sola pregunta —"¿es esta la clave de alguien que puede autorizar?"—
 * así que va en una sola llamada, no en dos encadenadas.
 */
async function validarResponsable(clave) {
    try {
        const res = await fetch('/api/auth?rol=responsable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: clave }),
        });
        return res.ok;
    } catch {
        return false;
    }
}
