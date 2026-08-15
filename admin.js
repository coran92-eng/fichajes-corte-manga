// Firebase eliminado. Usamos fetch a Vercel API.

let centrosDisponibles = [];

let callbackModal = null;
let fichajesGlobales = []; // Caché en memoria para filtros y exportación

document.addEventListener('DOMContentLoaded', () => {
    // Proteger ruta con token de sessionStorage
    const token = sessionStorage.getItem('adminToken');
    if (!token) {
        window.location.href = 'login.html';
    } else {
        inicializarAdmin();
    }
});

async function inicializarAdmin() {
    // Los botones se enganchan antes de tocar la red: si una llamada tarda o
    // falla, la cabecera tiene que seguir respondiendo igualmente.
    configurarBotones();
    configurarFiltros();
    configurarModal();

    await cargarCentros();
    inicializarEmpleados();
    cargarDatosEnTiempoReal();

    const btnConfig = document.getElementById('btnConfig');
    if(btnConfig) btnConfig.style.display = 'none';
}

async function cargarCentros() {
    try {
        const res = await fetch('/config.json');
        if (res.ok) {
            const cfg = await res.json();
            if (Array.isArray(cfg.centros)) centrosDisponibles = cfg.centros;
        }
    } catch {}

    const optionsHtml = centrosDisponibles.map(c => `<option value="${c}">${c}</option>`).join('');

    const filtroCentro = document.getElementById('filtroCentro');
    if (filtroCentro) filtroCentro.innerHTML = '<option value="">Todos los centros</option>' + optionsHtml;

    const selectCentroEmpleado = document.getElementById('selectCentroEmpleado');
    if (selectCentroEmpleado) selectCentroEmpleado.innerHTML = '<option value="">Sin asignar</option>' + optionsHtml;
}

let autoRefreshInterval = null;

function cargarDatosEnTiempoReal() {
    mostrarMensaje('Cargando registros...', 'info');
    
    const fetchData = async () => {
        try {
            const response = await fetch('/api/fichajes');
            if (!response.ok) throw new Error('Error de servidor');
            const fichajes = await response.json();
            
            fichajesGlobales = fichajes;
            renderizarTablas(fichajes);
            mostrarMensaje('✓ Registros sincronizados', 'success');
        } catch (error) {
            console.error("Error al obtener datos:", error);
            mostrarMensaje('✗ Error al leer registros', 'error');
        }
    };

    fetchData();

    // Actualizar cada 30 segundos
    if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    autoRefreshInterval = setInterval(fetchData, 30000);
}

function renderizarTablas(fichajes) {
    if (fichajes.length === 0) {
        document.getElementById('tabsContent').innerHTML =
            '<div class="empty"><p>No hay registros de fichaje aún</p></div>';
        return;
    }

    // Agrupar por empleado
    const porEmpleado = {};
    fichajes.forEach(f => {
        if (!porEmpleado[f.empleado]) {
            porEmpleado[f.empleado] = [];
        }
        porEmpleado[f.empleado].push(f);
    });

    const empleados = Object.keys(porEmpleado).sort();

    mostrarEstadisticas(fichajes, empleados);
    crearPestanas(['Cronológico', ...empleados]);
    crearContenidoCronologico(fichajes);
    crearContenidoPestanas(porEmpleado, empleados);
    detectarDescansosLargos(porEmpleado);
}

// ── Gestión de empleados ──────────────────────────────────────
function inicializarEmpleados() {
    renderEmpleados();
}

async function renderEmpleados(intento = 0) {
    const contenedor = document.getElementById('empleadosLista');
    if (!contenedor) return;
    contenedor.innerHTML = '<span style="color:#9ca3af;font-size:13px">Cargando...</span>';
    try {
        const response = await fetch('/api/empleados');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const raw = await response.json();
        const lista = raw.map(e => typeof e === 'string' ? { nombre: e, centro: '' } : e);

        if (lista.length === 0) {
            contenedor.innerHTML = '<span style="color:#9ca3af;font-size:13px">Sin empleados</span>';
            return;
        }
        const opcionesCentro = (sel) =>
            `<option value=""${!sel ? ' selected' : ''}>Sin centro</option>` +
            centrosDisponibles.map(c =>
                `<option value="${c}"${c === sel ? ' selected' : ''}>${c}</option>`
            ).join('');

        const ROLES = [
            { value: '',          label: 'Sin rol' },
            { value: 'sala',      label: 'Sala' },
            { value: 'cocina',    label: 'Cocina' },
            { value: 'barra',     label: 'Barra' },
            { value: 'limpieza',  label: 'Limpieza' },
            { value: 'encargado', label: 'Encargado' },
            { value: 'extra',     label: 'Extra' },
            { value: 'mixto',     label: 'Mixto (sala+cocina)' },
        ];
        const opcionesRol = (sel) => ROLES.map(r =>
            `<option value="${r.value}"${r.value === (sel || '') ? ' selected' : ''}>${r.label}</option>`
        ).join('');

        contenedor.innerHTML = lista.map(({ nombre, centro, rol, tiene_pin, horario_habitual }) => {
            const nEsc = nombre.replace(/"/g, '&quot;');
            const nJs = nombre.replace(/'/g, "\\'");
            return `
            <div class="empleado-tag empleado-rol--${rol || 'sin'}">
                ${nombre}
                <select class="empleado-centro" data-nombre="${nEsc}" title="Centro de ${nombre}">
                    ${opcionesCentro(centro)}
                </select>
                <select class="empleado-rol" data-nombre="${nEsc}" title="Rol de ${nombre}">
                    ${opcionesRol(rol)}
                </select>
                <button type="button" class="btn-hab ${horario_habitual ? 'puesto' : ''}"
                        title="Horario habitual de ${nombre}"
                        onclick="window.abrirHorarioHabitual('${nJs}')">
                    ${horario_habitual ? 'Horario ✓' : 'Horario'}
                </button>
                <button type="button" class="btn-pin ${tiene_pin ? 'con-pin' : 'sin-pin'}"
                        title="PIN de ${nombre} (tareas)"
                        onclick="window.gestionarPin('${nJs}', ${tiene_pin ? 'true' : 'false'})">
                    ${tiene_pin ? 'PIN ✓' : 'Sin PIN'}
                </button>
                <button type="button" title="Eliminar ${nombre}" onclick="window.confirmarEliminarEmpleado('${nJs}')">✕</button>
            </div>`;
        }).join('');

        contenedor.querySelectorAll('.empleado-centro').forEach(sel => {
            sel.addEventListener('change', () =>
                window.asignarCentroEmpleado(sel.dataset.nombre, sel.value));
        });
        contenedor.querySelectorAll('.empleado-rol').forEach(sel => {
            sel.addEventListener('change', () =>
                window.asignarRolEmpleado(sel.dataset.nombre, sel.value));
        });
    } catch (err) {
        if (intento < 2) {
            await new Promise(r => setTimeout(r, 1500));
            return renderEmpleados(intento + 1);
        }
        contenedor.innerHTML = '<span style="color:#ef4444;font-size:13px">Error al cargar empleados — <button onclick="window.renderEmpleados()" style="background:none;border:none;color:#2563eb;cursor:pointer;text-decoration:underline;font-size:13px;padding:0">Reintentar</button></span>';
    }
}
window.renderEmpleados = renderEmpleados;

// ── Red del local ─────────────────────────────────────────────
// Se autoriza pulsando el botón DESDE DENTRO del bar: así no hay que saber
// ninguna dirección técnica, y el día que el operador la cambie se repite.
window.abrirRedLocal = function() {
    const sel = document.getElementById('redCentro');
    sel.innerHTML = centrosDisponibles.map(c => `<option value="${c}">${c}</option>`).join('');
    document.getElementById('modalRed').style.display = 'flex';
    window.cargarEstadoRed();
};

window.cargarEstadoRed = async function() {
    const centro = document.getElementById('redCentro').value;
    const estado = document.getElementById('redEstado');
    const lista = document.getElementById('redLista');
    estado.textContent = 'Comprobando...';
    lista.innerHTML = '';

    try {
        const res = await fetch(`/api/red-local?centro=${encodeURIComponent(centro)}`, { cache: 'no-store' });
        const d = await res.json();

        if (d.sin_configurar) {
            estado.innerHTML = `<span style="color:#b45309">⚠ Sin configurar: ahora mismo se puede fichar desde cualquier sitio.</span>`;
        } else if (d.estas_dentro) {
            estado.innerHTML = `<span style="color:#059669">✓ Estás en una red autorizada.</span>`;
        } else {
            estado.innerHTML = `<span style="color:#b91c1c">✗ Esta red NO está autorizada: desde aquí no se puede fichar.</span>`;
        }
        estado.innerHTML += `<div style="color:#6b7280;font-size:12px;margin-top:4px">Tu conexión ahora: <code>${d.red_actual || '—'}</code></div>`;

        lista.innerHTML = d.autorizadas.length
            ? '<div style="font-size:12px;font-weight:700;color:#6b7280;margin-bottom:5px">REDES AUTORIZADAS</div>' +
              d.autorizadas.map(r => `
                <div style="display:flex;align-items:center;gap:8px;font-size:13px;padding:6px 0;border-bottom:1px solid #e5e7eb">
                    <code style="flex:1">${r}</code>
                    <button type="button" onclick="window.quitarRed('${r}')"
                            style="border:1px solid #fca5a5;background:none;color:#b91c1c;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;font-weight:600">Quitar</button>
                </div>`).join('')
            : '<div style="font-size:13px;color:#9ca3af">Ninguna red autorizada todavía.</div>';
    } catch {
        estado.textContent = 'No se pudo comprobar la red';
    }
};

window.autorizarRed = async function() {
    const centro = document.getElementById('redCentro').value;
    if (!confirm(`¿Autorizar la red desde la que estás ahora para fichar en "${centro}"?\n\nHazlo solo si estás dentro del local.`)) return;
    try {
        const res = await fetch('/api/red-local', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Auth-Token': sessionStorage.getItem('adminToken') || '',
            },
            body: JSON.stringify({ centro }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || '');
        mostrarMensaje(d.ya_estaba ? 'Esta red ya estaba autorizada' : '✓ Red autorizada', 'success');
        window.cargarEstadoRed();
    } catch (e) {
        mostrarMensaje(`✗ ${e.message || 'Error al autorizar la red'}`, 'error');
    }
};

window.quitarRed = async function(red) {
    const centro = document.getElementById('redCentro').value;
    if (!confirm(`¿Quitar la red ${red}? Desde ella ya no se podrá fichar.`)) return;
    try {
        await fetch(`/api/red-local?centro=${encodeURIComponent(centro)}&red=${encodeURIComponent(red)}`, {
            method: 'DELETE',
            headers: { 'X-Auth-Token': sessionStorage.getItem('adminToken') || '' },
        });
        mostrarMensaje('Red retirada', 'success');
        window.cargarEstadoRed();
    } catch {
        mostrarMensaje('✗ Error al quitar la red', 'error');
    }
};

// ── Horario habitual por empleado ─────────────────────────────
// Se configura una vez y evita depender de que se suba el horario semanal.
const DIAS_SEMANA = [
    { n: 1, label: 'Lunes' }, { n: 2, label: 'Martes' }, { n: 3, label: 'Miércoles' },
    { n: 4, label: 'Jueves' }, { n: 5, label: 'Viernes' }, { n: 6, label: 'Sábado' },
    { n: 7, label: 'Domingo' },
];
let habEmpleadoActual = '';

window.abrirHorarioHabitual = async function(nombre) {
    habEmpleadoActual = nombre;
    document.getElementById('habTitulo').textContent = `Horario habitual · ${nombre}`;

    let actual = {};
    try {
        const res = await fetch('/api/empleados');
        const lista = await res.json();
        const emp = lista.find(e => e.nombre === nombre);
        if (emp && emp.horario_habitual) actual = JSON.parse(emp.horario_habitual);
    } catch {}

    document.getElementById('habDias').innerHTML = DIAS_SEMANA.map(d => `
        <div class="hab-fila">
            <span>${d.label}</span>
            <input type="time" step="300" id="hab-${d.n}" value="${actual[d.n] || ''}">
            <button type="button" onclick="document.getElementById('hab-${d.n}').value=''">Libra</button>
        </div>`).join('');

    document.getElementById('modalHabitual').classList.add('visible');
};

window.cerrarHorarioHabitual = function() {
    document.getElementById('modalHabitual').classList.remove('visible');
};

window.guardarHorarioHabitual = async function() {
    const horario = {};
    DIAS_SEMANA.forEach(d => {
        const v = document.getElementById(`hab-${d.n}`)?.value;
        if (v) horario[d.n] = v;
    });

    try {
        const res = await fetch('/api/empleados', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Auth-Token': sessionStorage.getItem('adminToken') || '',
            },
            body: JSON.stringify({
                nombre: habEmpleadoActual,
                horario_habitual: Object.keys(horario).length ? JSON.stringify(horario) : '',
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '');
        mostrarMensaje(`✓ Horario habitual guardado para "${habEmpleadoActual}"`, 'success');
        window.cerrarHorarioHabitual();
        renderEmpleados();
    } catch (e) {
        mostrarMensaje(`✗ ${e.message || 'Error al guardar el horario'}`, 'error');
    }
};

window.confirmarEliminarEmpleado = function(nombre) {
    mostrarModal(
        '👤 Eliminar empleado',
        `¿Eliminar a "${nombre}" de la lista? Sus fichajes anteriores se conservarán.`,
        async () => {
            try {
                const response = await fetch('/api/empleados', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nombre })
                });
                if (!response.ok) throw new Error();
                renderEmpleados();
                mostrarMensaje(`✓ "${nombre}" eliminado`, 'success');
            } catch {
                mostrarMensaje(`✗ Error al eliminar "${nombre}"`, 'error');
            }
        }
    );
};

window.asignarCentroEmpleado = async function(nombre, centro) {
    try {
        const response = await fetch('/api/empleados', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre, centro })
        });
        if (!response.ok) throw new Error();
        mostrarMensaje(`✓ "${nombre}" asignado a ${centro || 'sin centro'}`, 'success');
    } catch {
        mostrarMensaje(`✗ Error al asignar centro a "${nombre}"`, 'error');
        renderEmpleados();
    }
};

// PIN del empleado para el módulo de tareas (tablet compartida).
window.gestionarPin = async function(nombre, tienePin) {
    const texto = tienePin
        ? `Nuevo PIN para "${nombre}" (4-6 dígitos).\nDéjalo vacío para quitarle el PIN:`
        : `PIN para "${nombre}" (4-6 dígitos):`;
    const pin = prompt(texto);
    if (pin === null) return;

    const limpio = pin.trim();
    if (limpio !== '' && !/^\d{4,6}$/.test(limpio)) {
        mostrarMensaje('✗ El PIN debe tener entre 4 y 6 dígitos', 'error');
        return;
    }

    try {
        const response = await fetch('/api/empleados', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Auth-Token': sessionStorage.getItem('adminToken') || '',
            },
            body: JSON.stringify({ nombre, pin: limpio })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '');
        mostrarMensaje(limpio ? `✓ PIN actualizado para "${nombre}"` : `✓ PIN eliminado a "${nombre}"`, 'success');
        renderEmpleados();
    } catch (e) {
        mostrarMensaje(`✗ ${e.message || 'Error al guardar el PIN'}`, 'error');
    }
};

window.asignarRolEmpleado = async function(nombre, rol) {
    try {
        const response = await fetch('/api/empleados', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre, rol })
        });
        if (!response.ok) throw new Error();
        const etiqueta = rol ? rol.charAt(0).toUpperCase() + rol.slice(1) : 'sin rol';
        mostrarMensaje(`✓ "${nombre}" · rol: ${etiqueta}`, 'success');
        renderEmpleados();
    } catch {
        mostrarMensaje(`✗ Error al asignar rol a "${nombre}"`, 'error');
        renderEmpleados();
    }
};

function configurarFormEmpleados() {
    document.getElementById('formNuevoEmpleado').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('inputNuevoEmpleado');
        const nombre = input.value.trim();
        const centro = document.getElementById('selectCentroEmpleado')?.value || '';
        if (!nombre) return;

        try {
            const response = await fetch('/api/empleados', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre, centro })
            });
            if (!response.ok) {
                const data = await response.json();
                mostrarMensaje(`⚠ ${data.error || 'Error al añadir'}`, 'error');
                return;
            }
            input.value = '';
            renderEmpleados();
            mostrarMensaje(`✓ "${nombre}" añadido${centro ? ` a ${centro}` : ''}`, 'success');
        } catch {
            mostrarMensaje('✗ Error de conexión', 'error');
        }
    });
}

/** Texto plano dentro del HTML: los motivos los escribe el equipo. */
function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function crearContenidoCronologico(fichajes) {
    const filas = fichajes
        .map(f => `
            <tr data-centro="${f.centro || ''}">
                <td class="fecha">${f.fecha}</td>
                <td class="hora">${f.hora}</td>
                <td><strong>${f.empleado}</strong></td>
                <td>
                    <span class="tipo ${f.tipo}">
                        ${getTipoLabel(f.tipo)}
                    </span>
                    ${f.hora_prevista ? `<div style="font-size:11px;color:#9ca3af;margin-top:3px">previsto ${escHtml(String(f.hora_prevista).slice(0, 5))}</div>` : ''}
                    ${f.motivo ? `<div style="font-size:12px;color:#b45309;margin-top:3px">${escHtml(f.motivo)}</div>` : ''}
                </td>
                ${f.centro ? `<td style="font-size:12px;color:#6b7280">${f.centro}</td>` : '<td></td>'}
            </tr>
        `)
        .join('');

    const html = `
        <div class="tab-content active" data-tab="Cronológico">
            <table>
                <thead>
                    <tr>
                        <th>Fecha</th>
                        <th>Hora</th>
                        <th>Empleado</th>
                        <th>Tipo</th>
                    </tr>
                </thead>
                <tbody>
                    ${filas}
                </tbody>
            </table>
        </div>
    `;

    document.getElementById('tabsContent').innerHTML = html;
}

function detectarDescansosLargos(porEmpleado) {
    const avisoHTML = document.createElement('div');
    avisoHTML.className = 'aviso-descanso';
    let tieneAvisos = false;

    let contenidoAvisos = '<div class="aviso-titulo">⚠️ Descansos que exceden 20 minutos:</div>';

    Object.keys(porEmpleado).forEach(empleado => {
        // Orden cronológico normal (del más antiguo al más nuevo) para calcular
        const fichajes = [...porEmpleado[empleado]]
            .sort((a, b) => new Date(a.fecha + ' ' + a.hora) - new Date(b.fecha + ' ' + b.hora));

        for (let i = 0; i < fichajes.length - 1; i++) {
            const actual = fichajes[i];
            if (actual.tipo === 'inicio_descanso') {
                const siguiente = fichajes[i + 1];
                if (siguiente && siguiente.tipo === 'fin_descanso') {
                    const inicio = new Date(actual.fecha + ' ' + actual.hora);
                    const fin = new Date(siguiente.fecha + ' ' + siguiente.hora);
                    const duracion = (fin - inicio) / (1000 * 60); // en minutos

                    if (duracion > 20) {
                        tieneAvisos = true;
                        const minutos = Math.round(duracion);
                        contenidoAvisos += `
                            <div class="aviso-detalle">
                                <strong>${empleado}</strong>:
                                ${actual.hora} - ${siguiente.hora}
                                (<span class="duracion-descanso">${minutos} min</span>)
                            </div>
                        `;
                    }
                }
            }
        }
    });

    if (tieneAvisos) {
        avisoHTML.innerHTML = contenidoAvisos;
        avisoHTML.classList.add('visible');
        const containerInicio = document.querySelector('[data-tab="Cronológico"]');
        if (containerInicio) {
            containerInicio.insertAdjacentElement('beforebegin', avisoHTML);
        }
    }
}

function mostrarEstadisticas(fichajes, empleados) {
    const statsHtml = `
        <div class="stat-card">
            <div class="stat-value">${fichajes.length}</div>
            <div class="stat-label">Total Registros</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${empleados.length}</div>
            <div class="stat-label">Empleados con actividad</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${new Date().toLocaleDateString('es-ES')}</div>
            <div class="stat-label">Fecha de Hoy</div>
        </div>
    `;
    document.getElementById('stats').innerHTML = statsHtml;
}

function crearPestanas(empleadosConCronologico) {
    const tabsHtml = empleadosConCronologico
        .map((emp, idx) =>
            `<button class="tab-btn ${idx === 0 ? 'active' : ''}" data-empleado="${emp}">
                ${emp === 'Cronológico' ? '📅 Cronológico' : emp}
            </button>`
        )
        .join('');

    const tabsEl = document.getElementById('tabs');
    tabsEl.innerHTML = tabsHtml;

    tabsEl.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            e.target.classList.add('active');
            document.querySelector(`[data-tab="${e.target.dataset.empleado}"]`).classList.add('active');
        });
    });
}

function crearContenidoPestanas(porEmpleado, empleados) {
    const contentHtml = empleados
        .map(emp => {
            const fichajes = porEmpleado[emp];
            const filas = fichajes
                .map(f => `
                    <tr>
                        <td class="fecha">${f.fecha}</td>
                        <td class="hora">${f.hora}</td>
                        <td>
                            <span class="tipo ${f.tipo}">
                                ${getTipoLabel(f.tipo)}
                            </span>
                        </td>
                    </tr>
                `)
                .join('');

            return `
                <div class="tab-content" data-tab="${emp}">
                    <table>
                        <thead>
                            <tr>
                                <th>Fecha</th>
                                <th>Hora</th>
                                <th>Tipo</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${filas}
                        </tbody>
                    </table>
                </div>
            `;
        })
        .join('');

    document.getElementById('tabsContent').innerHTML += contentHtml;
}

function getTipoLabel(tipo) {
    const labels = {
        'entrada': 'Entrada',
        'salida': 'Salida',
        'inicio_descanso': 'Inicio Descanso',
        'fin_descanso': 'Fin Descanso'
    };
    return labels[tipo] || tipo;
}

function configurarModal() {
    document.getElementById('btnModalCancel').addEventListener('click', () => {
        document.getElementById('modalConfirmacion').classList.remove('visible');
    });

    document.getElementById('btnModalConfirmar').addEventListener('click', () => {
        if (callbackModal) {
            callbackModal();
        }
        document.getElementById('modalConfirmacion').classList.remove('visible');
    });
}

function mostrarModal(titulo, mensaje, callback) {
    document.getElementById('modalTitulo').textContent = titulo;
    document.getElementById('modalMensaje').textContent = mensaje;
    callbackModal = callback;
    document.getElementById('modalConfirmacion').classList.add('visible');
}

function configurarFiltros() {
    document.getElementById('filtroCentro')?.addEventListener('change', aplicarFiltros);
    document.getElementById('filtroEmpleado')?.addEventListener('input', aplicarFiltros);
    document.getElementById('filtroFechaDesde')?.addEventListener('change', aplicarFiltros);
    document.getElementById('filtroFechaHasta')?.addEventListener('change', aplicarFiltros);
    document.getElementById('btnLimpiarFiltros')?.addEventListener('click', limpiarFiltros);
}

function aplicarFiltros() {
    const centro = (document.getElementById('filtroCentro')?.value || '').toLowerCase();
    const empleado = (document.getElementById('filtroEmpleado')?.value || '').toLowerCase();
    const desde = document.getElementById('filtroFechaDesde')?.value;
    const hasta = document.getElementById('filtroFechaHasta')?.value;

    document.querySelectorAll('tbody tr').forEach(fila => {
        let mostrar = true;

        if (centro) {
            const celdaCentro = fila.dataset.centro || '';
            mostrar = mostrar && celdaCentro.toLowerCase() === centro;
        }

        if (empleado) {
            const celdaEmpleado = fila.querySelector('td:nth-child(3)');
            if (celdaEmpleado && !celdaEmpleado.querySelector('.tipo')) {
                mostrar = mostrar && celdaEmpleado.textContent.toLowerCase().includes(empleado);
            }
        }

        if (desde || hasta) {
            const fecha = fila.querySelector('td:first-child')?.textContent.trim();
            if (desde && fecha < desde) mostrar = false;
            if (hasta && fecha > hasta) mostrar = false;
        }

        fila.style.display = mostrar ? '' : 'none';
    });
}

function limpiarFiltros() {
    document.getElementById('filtroCentro').value = '';
    document.getElementById('filtroEmpleado').value = '';
    document.getElementById('filtroFechaDesde').value = '';
    document.getElementById('filtroFechaHasta').value = '';
    document.querySelectorAll('tbody tr').forEach(fila => fila.style.display = '');
}

function configurarBotones() {
    document.getElementById('btnVolver').addEventListener('click', () => {
        window.location.href = 'index.html';
    });

    document.getElementById('btnHorasSemana').addEventListener('click', () => {
        window.location.href = 'horas-semana.html';
    });

    document.getElementById('btnHorasMes')?.addEventListener('click', () => {
        window.location.href = 'horas-mes.html';
    });

    document.getElementById('btnTareasAdmin')?.addEventListener('click', () => {
        window.location.href = 'tareas-admin.html';
    });

    document.getElementById('btnResumenDia')?.addEventListener('click', () => {
        window.location.href = 'resumen-dia.html';
    });

    document.getElementById('btnMantenimiento')?.addEventListener('click', () => {
        const centro = document.getElementById('filtroCentro')?.value || '';
        window.location.href = 'mantenimiento.html' + (centro ? `?centro=${encodeURIComponent(centro)}` : '');
    });

    document.getElementById('btnRedLocal')?.addEventListener('click', window.abrirRedLocal);
    document.getElementById('btnRedCerrar')?.addEventListener('click', () => {
        document.getElementById('modalRed').style.display = 'none';
    });
    document.getElementById('btnRedAutorizar')?.addEventListener('click', window.autorizarRed);
    document.getElementById('redCentro')?.addEventListener('change', window.cargarEstadoRed);

    document.getElementById('btnHabCerrar')?.addEventListener('click', window.cerrarHorarioHabitual);
    document.getElementById('btnHabGuardar')?.addEventListener('click', window.guardarHorarioHabitual);
    document.getElementById('modalHabitual')?.addEventListener('click', (e) => {
        if (e.target.id === 'modalHabitual') window.cerrarHorarioHabitual();
    });

    document.getElementById('btnEmpleados').addEventListener('click', () => {
        const panel = document.getElementById('panelEmpleados');
        panel.classList.toggle('visible');
        if (panel.classList.contains('visible')) {
            cargarCentros();
            renderEmpleados();
        }
    });

    configurarFormEmpleados();

    document.getElementById('btnExportarExcel').addEventListener('click', () => {
        mostrarModal(
            '📥 Exportar a Excel',
            '¿Descargar todos los registros mostrados en Excel?',
            exportarExcel
        );
    });

    document.getElementById('btnLimpiar').addEventListener('click', () => {
        mostrarModal(
            '🗑️ Eliminar datos',
            '⚠️ ADVERTENCIA: Esto eliminará TODOS los registros de Firebase de forma permanente. Esta acción NO se puede deshacer. ¿Continuar?',
            limpiarDatosFirebase
        );
    });

    document.getElementById('btnLogout').addEventListener('click', () => {
        mostrarModal(
            '🚪 Cerrar sesión',
            '¿Deseas cerrar tu sesión?',
            logout
        );
    });

    document.getElementById('btnHorarios')?.addEventListener('click', () => {
        const panel = document.getElementById('panelHorarios');
        panel.classList.toggle('visible');
        if (panel.classList.contains('visible')) cargarHorarios();
    });
    document.getElementById('btnRecargarHorarios')?.addEventListener('click', cargarHorarios);
    document.getElementById('filtroEstadoHorario')?.addEventListener('change', cargarHorarios);

    document.getElementById('btnSolicitudes')?.addEventListener('click', () => {
        const panel = document.getElementById('panelSolicitudes');
        panel.classList.toggle('visible');
        if (panel.classList.contains('visible')) cargarSolicitudes();
    });
    document.getElementById('btnRecargarSolicitudes')?.addEventListener('click', cargarSolicitudes);
    document.getElementById('filtroEstadoSolicitud')?.addEventListener('change', cargarSolicitudes);
    document.getElementById('btnIrEncargado')?.addEventListener('click', () => {
        window.location.href = 'horario-encargado.html';
    });
}

function logout() {
    sessionStorage.removeItem('adminToken');
    window.location.href = 'login.html';
}

function exportarExcel() {
    if (fichajesGlobales.length === 0) {
        mostrarMensaje('✗ No hay datos para exportar', 'error');
        return;
    }

    mostrarMensaje('⏳ Generando archivo Excel...', 'info');

    const workbook = XLSX.utils.book_new();
    const porEmpleado = {};
    
    fichajesGlobales.forEach(f => {
        if (!porEmpleado[f.empleado]) {
            porEmpleado[f.empleado] = [];
        }
        porEmpleado[f.empleado].push({
            Fecha: f.fecha,
            Hora: f.hora,
            Tipo: getTipoLabel(f.tipo)
        });
    });

    Object.keys(porEmpleado).sort().forEach(empleado => {
        const datos = porEmpleado[empleado];
        const worksheet = XLSX.utils.json_to_sheet(datos);
        worksheet['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 15 }];
        XLSX.utils.book_append_sheet(workbook, worksheet, empleado.substring(0, 31));
    });

    const resumen = Object.keys(porEmpleado).map(emp => ({
        Empleado: emp,
        'Total Registros': porEmpleado[emp].length,
        'Último Registro': porEmpleado[emp][0].Hora
    }));

    const resumenSheet = XLSX.utils.json_to_sheet(resumen);
    resumenSheet['!cols'] = [{ wch: 20 }, { wch: 15 }, { wch: 15 }];
    XLSX.utils.book_append_sheet(workbook, resumenSheet, 'Resumen');

    const fecha = new Date().toISOString().split('T')[0];
    XLSX.writeFile(workbook, `Fichaje_${fecha}.xlsx`);

    mostrarMensaje('✓ Archivo exportado correctamente', 'success');
}

async function limpiarDatosFirebase() {
    mostrarMensaje('⏳ Eliminando datos...', 'info');
    
    try {
        const response = await fetch('/api/fichajes', { method: 'DELETE' });
        if (!response.ok) throw new Error('No se pudieron eliminar');
        
        mostrarMensaje('✓ Todos los registros fueron eliminados', 'success');
        // Recargar datos (vacíos)
        cargarDatosEnTiempoReal();
    } catch (error) {
        console.error("Error al limpiar datos:", error);
        mostrarMensaje('✗ Error al eliminar datos', 'error');
    }
}

function mostrarMensaje(texto, tipo) {
    const msgEl = document.getElementById('message');
    msgEl.textContent = texto;
    msgEl.className = `message ${tipo}`;
    setTimeout(() => {
        msgEl.className = 'message';
    }, 3000);
}

async function cargarHorarios() {
    const estado = document.getElementById('filtroEstadoHorario')?.value || 'pendiente';
    const contenido = document.getElementById('horariosContenido');
    if (!contenido) return;
    contenido.innerHTML = '<p style="color:#9ca3af;font-size:13px">Cargando...</p>';

    try {
        const res = await fetch(`/api/horarios?estado=${encodeURIComponent(estado)}`);
        if (!res.ok) throw new Error();
        const horarios = await res.json();

        if (horarios.length === 0) {
            contenido.innerHTML = `<p style="color:#9ca3af;font-size:13px">No hay horarios con estado "${estado}".</p>`;
            return;
        }

        // Group by semana → centro
        const grupos = {};
        horarios.forEach(h => {
            const key = `${h.semana}||${h.centro}`;
            if (!grupos[key]) grupos[key] = { semana: h.semana, centro: h.centro, filas: [] };
            grupos[key].filas.push(h);
        });

        const diasSemana = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
        const html = Object.values(grupos).map(g => {
            const filas = g.filas.map(h => {
                const diaIdx = (new Date(h.fecha + 'T00:00:00').getDay() + 6) % 7;
                return `<tr>
                    <td><strong>${h.empleado}</strong></td>
                    <td>${diasSemana[diaIdx]} ${h.fecha.slice(5)}</td>
                    <td style="font-family:monospace">${h.hora_entrada} – ${h.hora_salida}</td>
                    <td><span class="badge-estado badge-${h.estado}">${h.estado}</span></td>
                </tr>`;
            }).join('');

            const acciones = estado === 'pendiente' ? `
                <div class="horario-grupo-acciones">
                    <button class="btn-validar" onclick="validarHorario('${g.semana}','${g.centro}','validado')">✓ Validar</button>
                    <button class="btn-rechazar" onclick="validarHorario('${g.semana}','${g.centro}','rechazado')">✗ Rechazar</button>
                </div>` : '';

            return `<div class="horario-grupo">
                <div class="horario-grupo-header">
                    <span class="horario-grupo-titulo">📅 ${g.semana} • ${g.centro || 'Sin centro'}</span>
                    ${acciones}
                </div>
                <table class="horario-tabla">
                    <thead><tr><th>Empleado</th><th>Día</th><th>Horario</th><th>Estado</th></tr></thead>
                    <tbody>${filas}</tbody>
                </table>
            </div>`;
        }).join('');

        contenido.innerHTML = html;
    } catch {
        contenido.innerHTML = '<p style="color:#ef4444;font-size:13px">Error al cargar horarios.</p>';
    }
}

window.validarHorario = async function(semana, centro, estado) {
    try {
        const res = await fetch('/api/horarios', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ semana, centro, estado })
        });
        if (!res.ok) throw new Error();
        mostrarMensaje(`✓ Semana ${estado === 'validado' ? 'validada' : 'rechazada'} correctamente`, 'success');
        cargarHorarios();
    } catch {
        mostrarMensaje('✗ Error al actualizar el horario', 'error');
    }
};

const SOL_TIPO_LABEL = {
    crear: 'Añadir',
    modificar: 'Cambiar hora',
    eliminar: 'Eliminar',
};

function describirCambio(s) {
    const tipoFichaje = getTipoLabel(s.tipo_fichaje);
    const orig = s.hora_original || '—';
    const prop = s.hora_propuesta || '—';
    if (s.tipo_solicitud === 'crear') {
        return `Añadir <strong>${tipoFichaje}</strong> a las <ins>${prop}</ins>`;
    }
    if (s.tipo_solicitud === 'eliminar') {
        return `Eliminar <strong>${tipoFichaje}</strong> (${orig})`;
    }
    return `<strong>${tipoFichaje}</strong>: <del>${orig}</del> → <ins>${prop}</ins>`;
}

async function cargarSolicitudes() {
    const estado = document.getElementById('filtroEstadoSolicitud')?.value || 'pendiente';
    const contenido = document.getElementById('solicitudesContenido');
    if (!contenido) return;
    contenido.innerHTML = '<p style="color:#9ca3af;font-size:13px">Cargando...</p>';

    try {
        const res = await fetch(`/api/solicitudes?estado=${encodeURIComponent(estado)}`);
        if (!res.ok) throw new Error();
        const solicitudes = await res.json();

        if (solicitudes.length === 0) {
            contenido.innerHTML = `<p style="color:#9ca3af;font-size:13px">No hay solicitudes con estado "${estado}".</p>`;
            return;
        }

        const filas = solicitudes.map(s => {
            const acciones = s.estado === 'pendiente' ? `
                <div class="horario-grupo-acciones">
                    <button class="btn-validar" onclick="resolverSolicitud(${s.id},'aprobada')">✓ Aprobar</button>
                    <button class="btn-rechazar" onclick="resolverSolicitud(${s.id},'rechazada')">✗ Rechazar</button>
                </div>` : `<span class="badge-estado badge-${s.estado}">${s.estado}</span>`;
            const nota = s.nota_admin ? `<div class="sol-motivo">Nota: ${s.nota_admin}</div>` : '';
            return `<tr>
                <td><strong>${s.empleado}</strong><div class="fecha">${s.fecha}</div></td>
                <td><span class="badge-estado badge-pendiente">${SOL_TIPO_LABEL[s.tipo_solicitud] || s.tipo_solicitud}</span></td>
                <td class="sol-cambio">${describirCambio(s)}</td>
                <td><div>${s.motivo}</div>${nota}</td>
                <td>${acciones}</td>
            </tr>`;
        }).join('');

        contenido.innerHTML = `
            <div class="horario-grupo">
                <table class="horario-tabla">
                    <thead><tr><th>Empleado</th><th>Tipo</th><th>Cambio</th><th>Motivo</th><th></th></tr></thead>
                    <tbody>${filas}</tbody>
                </table>
            </div>`;
    } catch {
        contenido.innerHTML = '<p style="color:#ef4444;font-size:13px">Error al cargar solicitudes.</p>';
    }
}

window.resolverSolicitud = function(id, estado) {
    const titulo = estado === 'aprobada' ? '✓ Aprobar solicitud' : '✗ Rechazar solicitud';
    const mensaje = estado === 'aprobada'
        ? 'Se aplicará el cambio al fichaje del empleado. ¿Confirmar?'
        : 'La solicitud quedará rechazada y el fichaje no cambiará. ¿Confirmar?';
    mostrarModal(titulo, mensaje, async () => {
        let nota_admin = '';
        if (estado === 'rechazada') {
            nota_admin = window.prompt('Nota para el empleado (opcional):') || '';
        }
        try {
            const res = await fetch('/api/solicitudes', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, estado, nota_admin })
            });
            if (!res.ok) throw new Error();
            mostrarMensaje(`✓ Solicitud ${estado === 'aprobada' ? 'aprobada' : 'rechazada'} correctamente`, 'success');
            cargarSolicitudes();
            if (estado === 'aprobada') cargarDatosEnTiempoReal();
        } catch {
            mostrarMensaje('✗ Error al resolver la solicitud', 'error');
        }
    });
};
