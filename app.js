const EMPLEADOS_DEFAULT = [
    'Albert', 'Maikel', 'Carlos', 'Jecko',
    'Pol', 'Sonia', 'Nacho', 'Claudia'
];

const params = new URLSearchParams(window.location.search);
const centroActual = params.get('centro');

document.addEventListener('DOMContentLoaded', async () => {
    if (!centroActual) {
        await mostrarSelectorCentro();
        return;
    }

    document.getElementById('centroBadge').textContent = centroActual;
    document.getElementById('centroBadge').style.display = 'inline-block';

    inicializar();
    actualizarReloj();
    setInterval(actualizarReloj, 1000);
});

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

    const inputEmpleado = document.getElementById('empleado');
    inputEmpleado.addEventListener('change', actualizarUltimaAccion);

    // Detectar selección en datalist antes de blur para no dejar el botón bloqueado
    let debounceEmpleado = null;
    inputEmpleado.addEventListener('input', () => {
        clearTimeout(debounceEmpleado);
        debounceEmpleado = setTimeout(actualizarUltimaAccion, 350);
    });

    actualizarEstadoBotones(null);
    if (centroActual) iniciarPanelTurno();
}

async function cargarEmpleados() {
    const select = document.getElementById('empleado');
    select.innerHTML = '<option value="">-- Selecciona tu nombre --</option>';

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

    const datalist = document.getElementById('empleados-list');
    if (datalist) {
        datalist.innerHTML = '';
        empleados.forEach(({ nombre }) => {
            const option = document.createElement('option');
            option.value = nombre;
            datalist.appendChild(option);
        });
    } else {
        empleados.forEach(({ nombre }) => {
            const option = document.createElement('option');
            option.value = nombre;
            option.textContent = nombre;
            select.appendChild(option);
        });
    }
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
    document.getElementById('btnEntrada').addEventListener('click', () => registrarFichaje('entrada'));
    document.getElementById('btnSalida').addEventListener('click', () => registrarFichaje('salida'));
    document.getElementById('btnDescansoIni').addEventListener('click', () => registrarFichaje('inicio_descanso'));
    document.getElementById('btnDescansoFin').addEventListener('click', () => registrarFichaje('fin_descanso'));
    document.getElementById('btnAdmin').addEventListener('click', () => {
        window.location.href = 'login.html';
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

async function registrarFichaje(tipo) {
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
            centro: centroActual || ''
        };

        const response = await fetch('/api/fichajes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fichaje)
        });

        if (!response.ok) throw new Error('Error en la respuesta del servidor');

        reproducirSonidoConfirmacion();
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

        const mensajes = {
            'entrada': '✓ Entrada registrada',
            'salida': '✓ Salida registrada',
            'inicio_descanso': '✓ Descanso iniciado',
            'fin_descanso': '✓ Descanso finalizado'
        };
        mostrarMensaje(mensajes[tipo], 'success');
        actualizarEstadoBotones(tipo);
        mostrarUndoToast(tipo, fichaje);
        if (centroActual) cargarTurnoActual();

    } catch (error) {
        console.error('Error al registrar:', error);
        mostrarMensaje('✗ Error al guardar. Intenta de nuevo.', 'error');
    } finally {
        btnElements.forEach(btn => btn.disabled = false);
    }
}

let pollingInterval = null;

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
            } else {
                lastActionEl.innerHTML = 'No tienes registros aún';
                lastActionEl.className = 'last-action';
                actualizarEstadoBotones(null);
            }
        } catch {
            lastActionEl.innerHTML = 'Error al cargar historial';
        }
    };

    fetchUltimaAccion();
    pollingInterval = setInterval(fetchUltimaAccion, 10000);
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

function iniciarPanelTurno() {
    cargarTurnoActual();
    if (turnoRefreshInterval) clearInterval(turnoRefreshInterval);
    turnoRefreshInterval = setInterval(cargarTurnoActual, 30000);
}

async function cargarTurnoActual() {
    try {
        const res = await fetch(`/api/fichajes?centro=${encodeURIComponent(centroActual)}`);
        if (!res.ok) return;
        const fichajes = await res.json();

        // Último fichaje por empleado (la API devuelve ORDER BY timestamp DESC)
        const ultimo = {};
        fichajes.forEach(f => {
            if (!ultimo[f.empleado]) ultimo[f.empleado] = f;
        });

        const enTurno = Object.entries(ultimo)
            .filter(([, f]) => f.tipo === 'entrada' || f.tipo === 'fin_descanso' || f.tipo === 'inicio_descanso')
            .map(([nombre, f]) => ({
                nombre,
                estado: f.tipo === 'inicio_descanso' ? 'descanso' : 'activo'
            }))
            .sort((a, b) => a.nombre.localeCompare(b.nombre));

        renderizarTurnoPanel(enTurno);
    } catch {}
}

function renderizarTurnoPanel(enTurno) {
    const panel = document.getElementById('turnoPanel');
    const lista = document.getElementById('turnoLista');
    const countEl = document.getElementById('turnoCount');
    if (!panel || !lista) return;

    if (enTurno.length === 0) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';
    countEl.textContent = `${enTurno.length} persona${enTurno.length !== 1 ? 's' : ''}`;
    lista.innerHTML = enTurno.map(({ nombre, estado }) => `
        <div class="turno-persona">
            <span class="turno-dot turno-dot--${estado}"></span>
            <span class="turno-nombre">${nombre}</span>
            <span class="turno-badge turno-badge--${estado}">${estado === 'activo' ? 'Activo' : 'Descanso'}</span>
        </div>
    `).join('');
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
