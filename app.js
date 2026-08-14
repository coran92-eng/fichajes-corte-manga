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

    actualizarEstadoBotones(null);
    if (centroActual) { iniciarPanelTurno(); configurarNotas(); }
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
    });
}

function seleccionarEmpleado(nombre, btn) {
    const cont = document.getElementById('empleadosBotones');
    if (cont) cont.querySelectorAll('.btn-emp').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    document.getElementById('empleado').value = nombre;
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

async function registrarFichaje(tipo, horaPrevista = '', passwordResponsable = '') {
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
            password_responsable: passwordResponsable || ''
        };

        const response = await fetch('/api/fichajes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fichaje)
        });

        // Fichaje fuera de la red del local (§7): se ofrece la excepción con
        // contraseña de responsable, para que un trabajo real nunca se quede
        // sin registrar por un problema de conexión.
        if (response.status === 403) {
            const data = await response.json().catch(() => ({}));
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
                return registrarFichaje(tipo, horaPrevista, clave);
            }
            mostrarMensaje(data.error || 'No se ha podido fichar', 'error');
            return;
        }
        if (!response.ok) throw new Error('Error en la respuesta del servidor');

        const respuesta = await response.json().catch(() => ({}));

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
            const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
            const ahoraMin = now.getHours() * 60 + now.getMinutes();
            const prevMin = toMin(refEntrada);
            const diff = ahoraMin - prevMin;
            if (diff > 5) {
                setTimeout(() => mostrarMensaje(`⚠ ${diff} min tarde (entrada: ${refEntrada})`, 'error'), 3100);
            } else if (diff >= -60) {
                setTimeout(() => mostrarMensaje(`✓ A tiempo (entrada: ${refEntrada})`, 'success'), 3100);
            }
        }

        if (respuesta.fuera_de_red) {
            const etiquetas = { entrada: 'entrada', salida: 'salida', inicio_descanso: 'inicio de descanso', fin_descanso: 'fin de descanso' };
            fetch('/api/turno-notas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    centro: centroActual,
                    tipo: 'nota',
                    autor: 'Sistema',
                    texto: `Fichaje autorizado fuera del local: ${empleado} ha registrado su ${etiquetas[tipo] || tipo} a las ${fichaje.hora.slice(0, 5)} desde otra red.`,
                    device_id: localStorage.getItem('device_id') || '',
                }),
            }).then(() => cargarNotas()).catch(() => {});
        }

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

async function cargarTurnoActual() {
    try {
        const desde = Date.now() - 36 * 60 * 60 * 1000;
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(
            `/api/fichajes?centro=${encodeURIComponent(centroActual)}&desde=${desde}`,
            { signal: ctrl.signal, cache: 'no-store' }
        );
        clearTimeout(to);
        if (!res.ok) { renderizarTurnoPanel([]); return; }
        const fichajes = await res.json();

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
    if (!panel || !lista) return;

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

// §6.3 — aviso antes de la salida. La salida se registra SIEMPRE.
async function confirmarSalida() {
    const empleado = document.getElementById('empleado')?.value || '';
    if (!empleado) {
        mostrarMensaje('Por favor selecciona tu nombre', 'error');
        return;
    }

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

    registrarFichaje('salida');
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
    lista.querySelectorAll('[data-tfoto]').forEach(inp =>
        inp.addEventListener('change', ev => capturarFotoTarea(ev, Number(inp.dataset.tfoto))));
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
        extras += `<label class="tarea-foto-btn" id="tfotolbl-${t.id}">📷
            <input type="file" accept="image/*" capture="environment" data-tfoto="${t.id}" style="display:none"></label>`;
    }

    return `<div class="tarea-row ${cls}"><span class="tarea-punto"></span>${nombre}
        <select class="tarea-sel" id="tsel-${t.id}">${opciones}</select>
        ${extras}
        <button type="button" class="tarea-guardar" data-guardar="${t.id}">Guardar</button>
        <div class="tarea-error" id="terr-${t.id}"></div>
    </div>`;
}

// Reescalado en el propio móvil: la foto viaja pequeña y no cuesta almacenamiento.
function capturarFotoTarea(ev, id) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const recien = (Date.now() - (file.lastModified || 0)) < 2 * 60 * 1000;
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
            fotosTarea[id] = { b64: c.toDataURL('image/jpeg', 0.6), origen: recien ? 'camara' : 'galeria' };
            const lbl = document.getElementById(`tfotolbl-${id}`);
            if (lbl) { lbl.classList.add('lista'); lbl.childNodes[0].nodeValue = '✓ '; }
        };
        img.src = reader.result;
    };
    reader.readAsDataURL(file);
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
        device_id: localStorage.getItem('device_id') || '',
        ts_cliente: Date.now(),
        origen_ui: 'inicio',
        idempotency_key: `${id}-${quien}-${Date.now()}`,
    };
    const num = document.getElementById(`tnum-${id}`);
    if (num && num.value !== '') body.valor_numerico = num.value;
    const txt = document.getElementById(`ttxt-${id}`);
    if (txt) body.texto = txt.value;
    if (fotosTarea[id]) { body.foto_b64 = fotosTarea[id].b64; body.origen_captura = fotosTarea[id].origen; }

    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    try {
        const res = await fetch('/api/tareas?accion=completar', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Auth-Token': sessionStorage.getItem('adminToken') || sessionStorage.getItem('encargadoToken') || '',
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
        await registrarFichaje('entrada', horaPrevista);
        try {
            await fetch('/api/turno-notas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    centro: centroActual,
                    tipo: 'nota',
                    autor: 'Sistema',
                    texto: `Entrada anticipada autorizada: ${empleado} ha fichado ${formatoEspera(faltan)} antes de su hora (${horaPrevista}).`,
                    device_id: localStorage.getItem('device_id') || '',
                }),
            });
            cargarNotas();
        } catch {}
    };
}

/** Acepta la contraseña de gerencia o la del encargado. */
async function validarResponsable(clave) {
    try {
        const rAdmin = await fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: clave }),
        });
        if (rAdmin.ok) return true;
    } catch {}

    try {
        const usuario = sessionStorage.getItem('encargadoNombre') || 'Albert';
        const rEnc = await fetch('/api/auth-encargado', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario, password: clave }),
        });
        if (rEnc.ok) return true;
    } catch {}

    return false;
}
