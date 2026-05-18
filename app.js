const EMPLEADOS_DEFAULT = [
    'Albert', 'Maikel', 'Carlos', 'Jecko',
    'Pol', 'Sonia', 'Nacho', 'Claudia'
];

const params = new URLSearchParams(window.location.search);
const centroActual = params.get('centro');

let _dbgTrail = 'v8';
function dbg(step) {
    _dbgTrail += '>' + step;
    const el = document.getElementById('buildStamp');
    if (el) el.textContent = _dbgTrail;
}
window.addEventListener('error', e => {
    const el = document.getElementById('buildStamp');
    if (el) el.textContent = _dbgTrail + ' ERR: ' + (e.message || e.error) + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno;
});
window.addEventListener('unhandledrejection', e => {
    const el = document.getElementById('buildStamp');
    if (el) el.textContent = _dbgTrail + ' REJ: ' + (e.reason && (e.reason.message || e.reason));
});

document.addEventListener('DOMContentLoaded', async () => {
    dbg('dom');

    if (!centroActual) {
        await mostrarSelectorCentro();
        return;
    }

    document.getElementById('centroBadge').textContent = centroActual;
    document.getElementById('centroBadge').style.display = 'inline-block';

    try {
        inicializar();
        dbg('init-ok');
    } catch (err) {
        dbg('init-THREW:' + (err && err.message));
    }
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

    actualizarEstadoBotones(null);
    dbg('pre-panel');
    if (centroActual) iniciarPanelTurno();
    dbg('post-panel');
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

    cont.innerHTML = '';
    empleados.forEach(({ nombre }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-emp';
        btn.textContent = nombre;
        btn.addEventListener('click', () => seleccionarEmpleado(nombre, btn));
        cont.appendChild(btn);
    });
}

function seleccionarEmpleado(nombre, btn) {
    const cont = document.getElementById('empleadosBotones');
    if (cont) cont.querySelectorAll('.btn-emp').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    document.getElementById('empleado').value = nombre;
    actualizarUltimaAccion();
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
    document.getElementById('btnEncargado')?.addEventListener('click', () => {
        window.location.href = 'login-encargado.html';
    });

    document.getElementById('btnSolicitarCorreccion')?.addEventListener('click', abrirModalSolicitud);
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

        if (tipo === 'entrada' && horarioHoy) {
            const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
            const ahoraMin = now.getHours() * 60 + now.getMinutes();
            const prevMin = toMin(horarioHoy.hora_entrada);
            const diff = ahoraMin - prevMin;
            if (diff > 5) {
                setTimeout(() => mostrarMensaje(`⚠ ${diff} min tarde (horario: ${horarioHoy.hora_entrada})`, 'error'), 3100);
            } else if (diff >= -60) {
                setTimeout(() => mostrarMensaje(`✓ A tiempo (horario: ${horarioHoy.hora_entrada})`, 'success'), 3100);
            }
        }

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
let horarioHoy = null;

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

async function cargarHorarioHoy(empleado) {
    horarioHoy = null;
    const badge = document.getElementById('horarioBadge');
    if (badge) badge.style.display = 'none';
    if (!empleado) return;

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fecha = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    try {
        const res = await fetch(`/api/horarios?empleado=${encodeURIComponent(empleado)}&fecha=${fecha}&estado=validado`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.length === 0) return;

        horarioHoy = data[0];
        if (badge) {
            badge.textContent = `Horario: ${horarioHoy.hora_entrada} – ${horarioHoy.hora_salida}`;
            badge.style.display = 'inline-block';
        }
    } catch {}
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
    dbg('iniciarPanel');
    cargarTurnoActual();
    if (turnoRefreshInterval) clearInterval(turnoRefreshInterval);
    turnoRefreshInterval = setInterval(cargarTurnoActual, 30000);
}

async function cargarTurnoActual() {
    try {
        dbg('fetch');
        const res = await fetch(`/api/fichajes?centro=${encodeURIComponent(centroActual)}`);
        dbg('http' + res.status);
        if (!res.ok) { renderizarTurnoPanel([]); return; }
        const fichajes = await res.json();
        dbg('rows' + (Array.isArray(fichajes) ? fichajes.length : 'NOarray'));

        // Agrupar por empleado (API devuelve ORDER BY timestamp DESC)
        const porEmpleado = {};
        fichajes.forEach(f => {
            if (!porEmpleado[f.empleado]) porEmpleado[f.empleado] = [];
            porEmpleado[f.empleado].push(f);
        });

        const enTurno = [];

        Object.entries(porEmpleado).forEach(([nombre, registros]) => {
            // Si el último movimiento es salida, está fuera
            if (registros[0].tipo === 'salida') return;

            // Buscar la última entrada para delimitar el turno actual
            const idxEntrada = registros.findIndex(f => f.tipo === 'entrada');
            if (idxEntrada === -1) return;

            // Eventos del turno actual en orden cronológico
            const turno = registros.slice(0, idxEntrada + 1).reverse();

            const entrada = turno[0];
            const descansos = [];
            let descansoActivo = null;

            for (const r of turno) {
                if (r.tipo === 'inicio_descanso') {
                    descansoActivo = { hora: r.hora, timestamp: Number(r.timestamp) };
                } else if (r.tipo === 'fin_descanso' && descansoActivo) {
                    const durMin = Math.round((Number(r.timestamp) - descansoActivo.timestamp) / 60000);
                    descansos.push({ inicio: descansoActivo.hora, fin: r.hora, durMin });
                    descansoActivo = null;
                }
            }

            const estado = registros[0].tipo === 'inicio_descanso' ? 'descanso' : 'activo';
            enTurno.push({ nombre, estado, entradaHora: entrada.hora, descansos, descansoActivo });
        });

        enTurno.sort((a, b) => a.nombre.localeCompare(b.nombre));
        renderizarTurnoPanel(enTurno);
    } catch {
        renderizarTurnoPanel([]);
    }
}

function renderizarTurnoPanel(enTurno) {
    const panel = document.getElementById('turnoPanel');
    const lista = document.getElementById('turnoLista');
    const countEl = document.getElementById('turnoCount');
    dbg('render(panel=' + !!panel + ',lista=' + !!lista + ',n=' + enTurno.length + ')');
    if (!panel || !lista) return;
    dbg('SET-block');

    if (enTurno.length === 0) {
        panel.style.display = 'block';
        countEl.textContent = 'Nadie ahora';
        lista.innerHTML = '<div class="turno-vacio">Nadie en el local en este momento</div>';
        return;
    }

    panel.style.display = 'block';
    countEl.textContent = `${enTurno.length} persona${enTurno.length !== 1 ? 's' : ''}`;

    lista.innerHTML = enTurno.map(({ nombre, estado, entradaHora, descansos, descansoActivo }) => {
        const minDescanso = descansoActivo
            ? Math.round((Date.now() - descansoActivo.timestamp) / 60000)
            : 0;
        const warning = minDescanso > 20;
        const variant = warning ? 'warning' : estado;

        const badgeText = estado === 'activo'
            ? 'Activo'
            : warning
                ? `⚠ Descanso ${minDescanso} min`
                : `Descanso ${minDescanso} min`;

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
                        <span class="turno-linea-val">${entradaHora.slice(0,5)}</span>
                    </div>
                    ${descansosHtml}${descansoActivoHtml}
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
