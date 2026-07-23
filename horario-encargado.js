// Horario de Turno — Encargado
// Gestión de horarios semanales por empleado y centro

let centroActual = '';
let semanaActual = '';
let empleadosList = []; // [{ nombre, rol }]

// ── Rango operativo (07:30 → 03:00 día siguiente) ─────────────
const APERTURA_MIN = 7 * 60 + 30;   // 07:30 en minutos absolutos
const DURACION_OP = 19.5 * 60;      // 1170 min

/**
 * Minutos operativos: 07:30 = 0, ..., 03:00 (día siguiente) = 1170.
 * Devuelve NaN si el string no es HH:MM.
 */
function toOpMinutes(hhmm) {
    if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return NaN;
    const [h, m] = hhmm.split(':').map(Number);
    const abs = h * 60 + m;
    let op = abs - APERTURA_MIN;
    if (op < 0) op += 24 * 60;
    return op;
}

/**
 * true si HH:MM cae dentro de 07:30 → 03:00 (día siguiente) y es media hora exacta.
 */
function esHoraOperativa(hhmm) {
    const op = toOpMinutes(hhmm);
    return !isNaN(op) && op >= 0 && op <= DURACION_OP && op % 30 === 0;
}

/**
 * Devuelve la duración (min) de un turno entrada→salida en el rango operativo,
 * o null si el turno no es válido.
 */
function duracionTurnoMin(entrada, salida) {
    const e = toOpMinutes(entrada);
    const s = toOpMinutes(salida);
    if (isNaN(e) || isNaN(s)) return null;
    if (e < 0 || e > DURACION_OP || s < 0 || s > DURACION_OP) return null;
    const dur = s - e;
    return dur > 0 ? dur : null;
}

/**
 * Formatea min en "Hh Mm" (6h 30m).
 */
function formatDur(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
}

// Colores por rol (usados para pintar los tramos de la barra en línea)
const ROL_COLOR = {
    cocina: '#f97316',
    sala:   '#3b82f6',
    mixto:  '#a855f7',
    '':     '#9ca3af',
};
function colorRol(rol) { return ROL_COLOR[rol || ''] || '#9ca3af'; }

const ROLES_CAMBIO = [
    { value: 'cocina', label: 'Cocina' },
    { value: 'sala',   label: 'Sala' },
    { value: 'mixto',  label: 'Mixto' },
];

// ── Helpers de fecha ──────────────────────────────────────────

/**
 * Returns the ISO week string "YYYY-WXX" for a given Date.
 */
function getISOWeek(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const week1 = new Date(d.getFullYear(), 0, 4);
    const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Given a Monday Date, return an array of 7 Date objects (Mon–Sun).
 */
function getDaysOfWeek(monday) {
    return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        return d;
    });
}

/**
 * Format a Date as "DD Mon" in Spanish, e.g. "26 May".
 */
function formatDayMonth(date) {
    return date.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
        .replace('.', '');
}

/**
 * Format a Date as "YYYY-MM-DD".
 */
function formatISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Returns the next Monday on or after a given Date.
 */
function nextMonday(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay(); // 0=Sun, 1=Mon...
    const daysUntilMonday = day === 1 ? 0 : (8 - day) % 7 || 7;
    d.setDate(d.getDate() + daysUntilMonday);
    return d;
}

/**
 * Returns an array of 8 week objects starting from today + 14 days
 * (rounded up to the next Monday).
 * Each object: { value, label, startDate, days }
 */
function getWeeksFromToday() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const minDate = new Date(today);
    minDate.setDate(today.getDate() + 14);

    const firstMonday = nextMonday(minDate);

    return Array.from({ length: 8 }, (_, i) => {
        const monday = new Date(firstMonday);
        monday.setDate(firstMonday.getDate() + i * 7);

        const days = getDaysOfWeek(monday);
        const sunday = days[6];

        const isoWeek = getISOWeek(monday);
        const weekNum = isoWeek.split('-W')[1];

        const startStr = formatDayMonth(monday);
        const endStr = formatDayMonth(sunday);
        const label = `Semana ${weekNum} • ${startStr} – ${endStr}`;

        return { value: isoWeek, label, startDate: monday, days };
    });
}

// ── Semanas disponibles (cached after first call) ─────────────
let weeksCache = null;

function getWeeks() {
    if (!weeksCache) weeksCache = getWeeksFromToday();
    return weeksCache;
}

/**
 * Finds the week object matching a given ISO value string.
 */
function findWeek(value) {
    return getWeeks().find(w => w.value === value) || null;
}

// ── Inicialización ────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    await cargarCentros();
    poblarSemanas();
    configurarEventos();
    if (typeof lucide !== 'undefined') lucide.createIcons();
});

async function cargarCentros() {
    try {
        const res = await fetch('/config.json');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const cfg = await res.json();

        const select = document.getElementById('selectCentro');
        if (Array.isArray(cfg.centros)) {
            cfg.centros.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c;
                opt.textContent = c;
                select.appendChild(opt);
            });
        }
    } catch (err) {
        console.error('Error cargando centros:', err);
        mostrarMensaje('No se pudieron cargar los centros', 'error');
    }
}

function poblarSemanas() {
    const select = document.getElementById('selectSemana');
    getWeeks().forEach(w => {
        const opt = document.createElement('option');
        opt.value = w.value;
        opt.textContent = w.label;
        select.appendChild(opt);
    });
}

function configurarEventos() {
    document.getElementById('selectCentro').addEventListener('change', onCentroChange);
    document.getElementById('selectSemana').addEventListener('change', onSemanaChange);
    document.getElementById('btnVolver').addEventListener('click', () => {
        // Si es admin vuelve a admin.html; si es encargado vuelve al fichaje
        if (sessionStorage.getItem('adminToken') === 'auth-token-fichaje-admin') {
            window.location.href = 'admin.html';
        } else {
            window.location.href = 'index.html';
        }
    });
    document.getElementById('btnLogout').addEventListener('click', () => {
        sessionStorage.removeItem('encargadoToken');
        sessionStorage.removeItem('encargadoNombre');
        sessionStorage.removeItem('adminToken');
        window.location.href = 'login-encargado.html';
    });
    document.getElementById('btnEnviar').addEventListener('click', enviarHorario);
}

async function onCentroChange(e) {
    centroActual = e.target.value;
    if (!centroActual) {
        empleadosList = [];
        mostrarTablaVacia('Selecciona un centro para cargar los empleados');
        document.getElementById('btnEnviar').disabled = true;
        return;
    }
    await cargarEmpleados(centroActual);
    if (semanaActual) {
        await cargarHorarioExistente();
    }
}

async function onSemanaChange(e) {
    semanaActual = e.target.value;

    // Update the week info hint
    const infoEl = document.getElementById('semanaInfo');
    const week = findWeek(semanaActual);
    if (week) {
        infoEl.textContent = `${formatISO(week.startDate)} → ${formatISO(week.days[6])}`;
    } else {
        infoEl.textContent = '';
    }

    if (!centroActual || !semanaActual) return;
    await cargarHorarioExistente();
}

// ── Carga de empleados ─────────────────────────────────────────

async function cargarEmpleados(centro) {
    mostrarMensaje('Cargando empleados...', 'info');
    try {
        const res = await fetch(`/api/empleados?centro=${encodeURIComponent(centro)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        // Normalise a {nombre, rol}
        empleadosList = raw.map(e => typeof e === 'string'
            ? { nombre: e, rol: '' }
            : { nombre: e.nombre, rol: e.rol || '' });
        mostrarMensaje('', '');
        renderTabla();
    } catch (err) {
        console.error('Error cargando empleados:', err);
        mostrarMensaje('Error al cargar empleados', 'error');
        empleadosList = [];
        mostrarTablaVacia('No se pudieron cargar los empleados');
    }
}

// ── Carga de horario existente ────────────────────────────────

async function cargarHorarioExistente() {
    if (!centroActual || !semanaActual) return;

    mostrarMensaje('Cargando horario existente...', 'info');
    try {
        const url = `/api/horarios?centro=${encodeURIComponent(centroActual)}&semana=${encodeURIComponent(semanaActual)}`;
        const res = await fetch(url);

        let horarioExistente = [];
        if (res.ok) {
            horarioExistente = await res.json();
        } else if (res.status !== 404) {
            throw new Error(`HTTP ${res.status}`);
        }

        renderTabla(horarioExistente);

        // Detect validated week
        const estaValidada = horarioExistente.some(
            h => (h.estado || '').toLowerCase() === 'validado'
        );

        mostrarEstadoSemana(horarioExistente);

        if (estaValidada) {
            document.getElementById('btnEnviar').disabled = true;
            mostrarMensaje('Esta semana ya fue validada. No se puede modificar.', 'warning');
        } else {
            document.getElementById('btnEnviar').disabled = false;
            mostrarMensaje('', '');
        }
    } catch (err) {
        console.error('Error cargando horario existente:', err);
        renderTabla([]);
        mostrarMensaje('No se pudo cargar el horario guardado', 'error');
    }
}

function mostrarEstadoSemana(horarioExistente) {
    const wrapper = document.getElementById('estadoSemanaWrapper');
    const badge = document.getElementById('estadoSemana');

    if (!horarioExistente.length) {
        wrapper.style.display = 'none';
        return;
    }

    // Derive overall estado from entries (prioritise validado > rechazado > pendiente)
    const estados = horarioExistente.map(h => (h.estado || 'pendiente').toLowerCase());
    let estado = 'pendiente';
    if (estados.includes('validado')) estado = 'validado';
    else if (estados.includes('rechazado')) estado = 'rechazado';

    const labels = {
        pendiente: 'Pendiente',
        validado: '✓ Semana validada',
        rechazado: '✗ Semana rechazada',
    };

    badge.className = `estado-semana ${estado}`;
    badge.textContent = labels[estado] || estado;
    wrapper.style.display = 'block';
}

// ── Renderizado de la tabla ───────────────────────────────────

function mostrarTablaVacia(mensaje) {
    document.getElementById('tablaHorario').innerHTML = `
        <div class="empty-state">
            <i data-lucide="calendar-x" aria-hidden="true" style="width:40px;height:40px;color:#d1d5db"></i>
            <p>${mensaje}</p>
        </div>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderTabla(horarioExistente = []) {
    const wrapper = document.getElementById('tablaHorario');

    const week = findWeek(semanaActual);

    if (!empleadosList.length) {
        mostrarTablaVacia('No hay empleados en este centro');
        document.getElementById('btnEnviar').disabled = true;
        return;
    }

    if (!week) {
        mostrarTablaVacia('Selecciona una semana para ver el horario');
        document.getElementById('btnEnviar').disabled = true;
        return;
    }

    const diasNombres = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

    // Build a quick lookup: "empleado|YYYY-MM-DD" → entry
    const lookup = {};
    horarioExistente.forEach(h => {
        lookup[`${h.empleado}|${h.fecha}`] = h;
    });

    // Header row
    const headerCols = diasNombres.map((nombre, i) => {
        const day = week.days[i];
        return `<th>${nombre}<br><span style="font-weight:400;font-size:12px">${formatDayMonth(day)}</span></th>`;
    }).join('');

    // Employee rows
    const rows = empleadosList.map(({ nombre: empleado, rol }) => {
        const rolClass = rol ? ` rol-${rol}` : '';
        const cells = week.days.map((day) => {
            const fecha = formatISO(day);
            const entry = lookup[`${empleado}|${fecha}`] || null;
            const esLibre = entry && entry.libre === true;
            // Defaults dentro del rango operativo: 07:30 → 15:00 (turno de día)
            const entrada = entry ? (entry.hora_entrada || '07:30') : '07:30';
            const salida  = entry ? (entry.hora_salida  || '15:00') : '15:00';
            const horaCambio = entry ? (entry.hora_cambio || '') : '';
            const rolSegunda = entry ? (entry.rol_segunda || '') : '';
            const rolPrimera = entry ? (entry.rol_primera || '') : '';
            const tieneCambio = !!(horaCambio && rolSegunda);

            // El rol de la primera parte por defecto es el fijo del empleado;
            // Albert puede cambiarlo por día (p.ej. camarero que empieza en cocina).
            const rol1Actual = rolPrimera || rol || '';
            const opcionesRol1 = ROLES_CAMBIO.map(r =>
                `<option value="${r.value}"${r.value === rol1Actual ? ' selected' : ''}>${r.label}</option>`
            ).join('');
            const opcionesRolSeg = ROLES_CAMBIO.map(r =>
                `<option value="${r.value}"${r.value === rolSegunda ? ' selected' : ''}>${r.label}</option>`
            ).join('');

            return `
                <td>
                    <div class="horario-cell${esLibre ? ' es-libre' : ''}"
                         data-empleado="${escapeAttr(empleado)}"
                         data-fecha="${fecha}"
                         data-rol-emp="${escapeAttr(rol || '')}">
                        <label class="libranza-toggle">
                            <input type="checkbox" class="chk-libre"${esLibre ? ' checked' : ''}> Libre
                        </label>
                        <div class="rol1-row">
                            <span class="rol1-lbl">Rol</span>
                            <select class="sel-rol1" aria-label="Rol de este día">
                                <option value=""${rol1Actual ? '' : ' selected'}>—</option>
                                ${opcionesRol1}
                            </select>
                        </div>
                        <input type="time" class="inp-entrada" step="1800" value="${entrada}" aria-label="Hora entrada">
                        <input type="time" class="inp-salida"  step="1800" value="${salida}"  aria-label="Hora salida">
                        <span class="turno-dur">—</span>
                        <div class="turno-bar" aria-hidden="true">
                            <div class="turno-bar-fill turno-bar-fill--1"></div>
                            <div class="turno-bar-fill turno-bar-fill--2"></div>
                        </div>
                        <button type="button" class="btn-cambio-toggle"${tieneCambio ? ' hidden' : ''}>+ Cambio de rol</button>
                        <div class="cambio-panel"${tieneCambio ? '' : ' hidden'}>
                            <span class="cambio-lbl">→</span>
                            <input type="time" class="inp-cambio" step="1800" value="${horaCambio}" aria-label="Hora del cambio">
                            <select class="sel-rol2" aria-label="Rol segunda parte">
                                <option value=""${rolSegunda ? '' : ' selected'}>—</option>
                                ${opcionesRolSeg}
                            </select>
                            <button type="button" class="btn-cambio-remove" title="Quitar cambio">×</button>
                        </div>
                    </div>
                </td>
            `;
        }).join('');

        return `
            <tr class="${rolClass.trim()}">
                <td class="td-empleado">${escapeHtml(empleado)}</td>
                ${cells}
                <td class="td-total-sem"><span class="turno-total-sem">0h</span></td>
            </tr>
        `;
    }).join('');

    wrapper.innerHTML = `
        <table class="horario-grid" aria-label="Horario semanal">
            <thead>
                <tr>
                    <th class="col-empleado">Empleado</th>
                    ${headerCols}
                    <th class="col-total">Total sem.</th>
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>
    `;

    // Wire up "Libre" toggles
    wrapper.querySelectorAll('.chk-libre').forEach(chk => {
        chk.addEventListener('change', onLibreToggle);
    });
    // Recalcular duración y barra al cambiar horas o roles
    wrapper.querySelectorAll('.inp-entrada, .inp-salida, .inp-cambio, .sel-rol1, .sel-rol2').forEach(inp => {
        inp.addEventListener('change', () => actualizarCelda(inp.closest('.horario-cell')));
    });
    // Botones para añadir/quitar cambio de rol
    wrapper.querySelectorAll('.btn-cambio-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const cell = btn.closest('.horario-cell');
            const panel = cell.querySelector('.cambio-panel');
            const inpC = cell.querySelector('.inp-cambio');
            // Valor por defecto del cambio: punto medio del turno
            const entrada = cell.querySelector('.inp-entrada')?.value || '';
            const salida  = cell.querySelector('.inp-salida')?.value || '';
            const opE = toOpMinutes(entrada);
            const opS = toOpMinutes(salida);
            if (!inpC.value && !isNaN(opE) && !isNaN(opS) && opS > opE) {
                const opMed = Math.round(((opE + opS) / 2) / 30) * 30;
                const abs = ((opMed + APERTURA_MIN) % (24 * 60));
                const h = Math.floor(abs / 60);
                const m = abs % 60;
                inpC.value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            }
            panel.hidden = false;
            btn.hidden = true;
            actualizarCelda(cell);
        });
    });
    wrapper.querySelectorAll('.btn-cambio-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const cell = btn.closest('.horario-cell');
            cell.querySelector('.cambio-panel').hidden = true;
            cell.querySelector('.btn-cambio-toggle').hidden = false;
            cell.querySelector('.inp-cambio').value = '';
            cell.querySelector('.sel-rol2').value = '';
            actualizarCelda(cell);
        });
    });
    // Render inicial de cada celda (aplica colores + barra) y totales semanales
    wrapper.querySelectorAll('.horario-cell').forEach(cell => actualizarCelda(cell));
    wrapper.querySelectorAll('tbody tr').forEach(tr => calcularTotalFila(tr));
    renderResumenSemana();

    document.getElementById('leyendaRoles').style.display = 'flex';
    document.getElementById('btnEnviar').disabled = false;
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function actualizarCelda(cell) {
    if (!cell) return;
    const entrada = cell.querySelector('.inp-entrada')?.value || '';
    const salida  = cell.querySelector('.inp-salida')?.value || '';
    const durEl = cell.querySelector('.turno-dur');
    const fill1 = cell.querySelector('.turno-bar-fill--1');
    const fill2 = cell.querySelector('.turno-bar-fill--2');
    const panel = cell.querySelector('.cambio-panel');
    const inpCambio = cell.querySelector('.inp-cambio');
    const selRol1   = cell.querySelector('.sel-rol1');
    const selRol2   = cell.querySelector('.sel-rol2');
    const rolEmp = cell.dataset.rolEmp || '';
    // Rol del primer tramo: el seleccionado en el día; si no, el fijo del empleado
    const rol1 = (selRol1?.value || rolEmp || '');

    const durMin = duracionTurnoMin(entrada, salida);
    if (durEl) durEl.textContent = durMin != null ? formatDur(durMin) : '—';

    // Reset visual
    if (fill1) { fill1.style.width = '0%'; fill1.style.left = '0%'; fill1.style.background = colorRol(rol1); }
    if (fill2) { fill2.style.width = '0%'; fill2.style.left = '0%'; fill2.style.background = 'transparent'; }
    if (durMin == null) { calcularTotalFila(cell.closest('tr')); renderResumenSemana(); return; }

    const opE = toOpMinutes(entrada);
    const opS = toOpMinutes(salida);
    const hayCambio = panel && !panel.hidden
        && inpCambio && inpCambio.value
        && selRol2 && selRol2.value;

    if (hayCambio) {
        const opC = toOpMinutes(inpCambio.value);
        // Validez: dentro del turno y snap de 30 min
        const dentro = !isNaN(opC) && opC > opE && opC < opS && opC % 30 === 0;
        if (dentro) {
            fill1.style.left  = `${((opE / DURACION_OP) * 100).toFixed(1)}%`;
            fill1.style.width = `${(((opC - opE) / DURACION_OP) * 100).toFixed(1)}%`;
            fill2.style.left  = `${((opC / DURACION_OP) * 100).toFixed(1)}%`;
            fill2.style.width = `${(((opS - opC) / DURACION_OP) * 100).toFixed(1)}%`;
            fill2.style.background = colorRol(selRol2.value);
            calcularTotalFila(cell.closest('tr'));
            renderResumenSemana();
            return;
        }
        // Cambio inválido → pinta el tramo completo como si no hubiera cambio
    }

    fill1.style.left  = `${((opE / DURACION_OP) * 100).toFixed(1)}%`;
    fill1.style.width = `${((durMin / DURACION_OP) * 100).toFixed(1)}%`;
    calcularTotalFila(cell.closest('tr'));
    renderResumenSemana();
}

/**
 * Suma la duración de todos los turnos no-libres de una fila y actualiza
 * la celda "Total sem." de esa fila.
 */
function calcularTotalFila(tr) {
    if (!tr) return;
    let total = 0;
    tr.querySelectorAll('.horario-cell').forEach(cell => {
        if (cell.classList.contains('es-libre')) return;
        const entrada = cell.querySelector('.inp-entrada')?.value || '';
        const salida  = cell.querySelector('.inp-salida')?.value || '';
        const d = duracionTurnoMin(entrada, salida);
        if (d != null) total += d;
    });
    const el = tr.querySelector('.turno-total-sem');
    if (el) el.textContent = total > 0 ? formatDur(total) : '0h';
}

/**
 * Recorre las celdas actualmente en pantalla y pinta el resumen semanal
 * tipo Gantt: un bloque por día, con una fila por empleado que trabaja
 * ese día, mostrando el turno en color(es) según los roles.
 */
function renderResumenSemana() {
    const wrapper = document.getElementById('resumenSemana');
    const cont = document.getElementById('resumenDias');
    if (!wrapper || !cont) return;

    const week = findWeek(semanaActual);
    if (!week) { wrapper.style.display = 'none'; return; }
    wrapper.style.display = 'block';

    // Etiquetas del eje (cada 2h desde 07:30)
    const axisTicks = [];
    for (let op = 0; op <= DURACION_OP; op += 120) {
        const abs = (op + APERTURA_MIN) % (24 * 60);
        const h = Math.floor(abs / 60), m = abs % 60;
        const label = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        const leftPct = (op / DURACION_OP) * 100;
        axisTicks.push(`<span style="left:${leftPct.toFixed(1)}%">${label}</span>`);
    }
    const axisHtml = axisTicks.join('');

    const diasNombres = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

    // Agrupar celdas del día
    const cellsByDate = {};
    document.querySelectorAll('.horario-cell').forEach(cell => {
        (cellsByDate[cell.dataset.fecha] = cellsByDate[cell.dataset.fecha] || []).push(cell);
    });

    cont.innerHTML = week.days.map((day, i) => {
        const fecha = formatISO(day);
        const cells = cellsByDate[fecha] || [];
        const filas = [];
        cells.forEach(cell => {
            if (cell.classList.contains('es-libre')) return;
            const entrada = cell.querySelector('.inp-entrada')?.value || '';
            const salida  = cell.querySelector('.inp-salida')?.value || '';
            const durMin = duracionTurnoMin(entrada, salida);
            if (durMin == null) return;
            const rolEmp = cell.dataset.rolEmp || '';
            const rol1 = (cell.querySelector('.sel-rol1')?.value || rolEmp);
            const panel = cell.querySelector('.cambio-panel');
            const inpCambio = cell.querySelector('.inp-cambio');
            const selRol2 = cell.querySelector('.sel-rol2');
            const opE = toOpMinutes(entrada);
            const opS = toOpMinutes(salida);

            let segs = [];
            const hayCambio = panel && !panel.hidden
                && inpCambio && inpCambio.value
                && selRol2 && selRol2.value;
            if (hayCambio) {
                const opC = toOpMinutes(inpCambio.value);
                if (!isNaN(opC) && opC > opE && opC < opS && opC % 30 === 0) {
                    segs.push({ left: opE, width: opC - opE, color: colorRol(rol1) });
                    segs.push({ left: opC, width: opS - opC, color: colorRol(selRol2.value) });
                }
            }
            if (segs.length === 0) {
                segs.push({ left: opE, width: opS - opE, color: colorRol(rol1) });
            }
            const segsHtml = segs.map(s =>
                `<div class="gantt-seg" style="left:${((s.left / DURACION_OP) * 100).toFixed(1)}%;width:${((s.width / DURACION_OP) * 100).toFixed(1)}%;background:${s.color}"></div>`
            ).join('');
            filas.push({
                nombre: cell.dataset.empleado,
                html: `<div class="gantt-row"><div class="gantt-label">${escapeHtml(cell.dataset.empleado)}</div><div class="gantt-track">${segsHtml}</div></div>`
            });
        });
        filas.sort((a, b) => a.nombre.localeCompare(b.nombre));

        const cabecera = `<div class="gantt-day-title">${diasNombres[i]} ${formatDayMonth(day)}</div><div class="gantt-axis">${axisHtml}</div>`;
        const cuerpo = filas.length
            ? filas.map(f => f.html).join('')
            : '<div class="gantt-empty">Sin turnos</div>';
        return `<div class="gantt-day">${cabecera}${cuerpo}</div>`;
    }).join('');
}

function onLibreToggle(e) {
    const cell = e.target.closest('.horario-cell');
    if (!cell) return;
    if (e.target.checked) {
        cell.classList.add('es-libre');
    } else {
        cell.classList.remove('es-libre');
    }
    calcularTotalFila(cell.closest('tr'));
    renderResumenSemana();
}

// ── Envío del horario ─────────────────────────────────────────

async function enviarHorario() {
    if (!centroActual) {
        mostrarMensaje('Selecciona un centro antes de enviar', 'error');
        return;
    }
    if (!semanaActual) {
        mostrarMensaje('Selecciona una semana antes de enviar', 'error');
        return;
    }

    // Collect all non-libre cells that have both time inputs filled
    const cells = document.querySelectorAll('.horario-cell:not(.es-libre)');
    const turnos = [];
    const invalidos = [];

    cells.forEach(cell => {
        const empleado = cell.dataset.empleado;
        const fecha = cell.dataset.fecha;
        const entrada = cell.querySelector('.inp-entrada')?.value;
        const salida = cell.querySelector('.inp-salida')?.value;

        if (!empleado || !fecha || !entrada || !salida) return;

        // Validar rango operativo 07:30 → 03:00 y pasos de 30 min
        if (!esHoraOperativa(entrada) || !esHoraOperativa(salida)) {
            invalidos.push(`${empleado} (${fecha}): fuera del rango 07:30–03:00 o no es media hora exacta`);
            return;
        }
        const dur = duracionTurnoMin(entrada, salida);
        if (dur == null) {
            invalidos.push(`${empleado} (${fecha}): salida debe ser posterior a entrada`);
            return;
        }

        // Cambio de rol a mitad de turno (opcional)
        const panel = cell.querySelector('.cambio-panel');
        const inpC  = cell.querySelector('.inp-cambio');
        const selR2 = cell.querySelector('.sel-rol2');
        let hora_cambio = '';
        let rol_segunda = '';
        if (panel && !panel.hidden && inpC && inpC.value) {
            const rol2 = (selR2?.value || '').trim();
            if (!rol2) {
                invalidos.push(`${empleado} (${fecha}): elige el rol de la segunda parte o quita el cambio`);
                return;
            }
            if (!esHoraOperativa(inpC.value)) {
                invalidos.push(`${empleado} (${fecha}): hora del cambio inválida (media hora en 07:30–03:00)`);
                return;
            }
            const opE = toOpMinutes(entrada);
            const opS = toOpMinutes(salida);
            const opC = toOpMinutes(inpC.value);
            if (!(opC > opE && opC < opS)) {
                invalidos.push(`${empleado} (${fecha}): la hora del cambio debe estar entre entrada y salida`);
                return;
            }
            hora_cambio = inpC.value;
            rol_segunda = rol2;
        }

        // Rol de la primera parte (opcional): si no se elige, usa el fijo del empleado
        const rol_primera = (cell.querySelector('.sel-rol1')?.value || '').trim();

        turnos.push({
            empleado, centro: centroActual, fecha,
            hora_entrada: entrada, hora_salida: salida,
            semana: semanaActual,
            rol_primera, hora_cambio, rol_segunda
        });
    });

    if (invalidos.length > 0) {
        mostrarMensaje(`Corrige antes de enviar: ${invalidos.join(' | ')}`, 'error');
        return;
    }

    if (turnos.length === 0) {
        mostrarMensaje('No hay turnos para enviar (todos marcados como Libre)', 'error');
        return;
    }

    const btnEnviar = document.getElementById('btnEnviar');
    btnEnviar.disabled = true;

    const errores = [];
    let enviados = 0;
    const total = turnos.length;

    for (const turno of turnos) {
        mostrarMensaje(`Enviando ${enviados + 1} de ${total}...`, 'info');

        try {
            const res = await fetch('/api/horarios', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(turno),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                const msg = data.error || `Error HTTP ${res.status}`;
                errores.push(`${turno.empleado} (${turno.fecha}): ${msg}`);
            } else {
                enviados++;
            }
        } catch (err) {
            errores.push(`${turno.empleado} (${turno.fecha}): Error de red`);
        }
    }

    btnEnviar.disabled = false;

    if (errores.length === 0) {
        mostrarMensaje(`✓ Horario enviado para validación (${enviados} turnos)`, 'success');
    } else if (enviados > 0) {
        mostrarMensaje(
            `✓ ${enviados} turnos enviados. Errores: ${errores.join(' | ')}`,
            'warning'
        );
    } else {
        mostrarMensaje(`✗ Error al enviar: ${errores.join(' | ')}`, 'error');
    }
}

// ── Utilidades ────────────────────────────────────────────────

/**
 * Shows a status message and auto-clears after 4 seconds.
 * tipo: 'success' | 'error' | 'info' | 'warning' | ''
 */
let _msgTimer = null;
function mostrarMensaje(texto, tipo) {
    const msgEl = document.getElementById('message');
    if (_msgTimer) clearTimeout(_msgTimer);

    if (!texto) {
        msgEl.className = 'message';
        msgEl.textContent = '';
        return;
    }

    msgEl.textContent = texto;
    msgEl.className = `message ${tipo}`;

    if (tipo !== 'info') {
        _msgTimer = setTimeout(() => {
            msgEl.className = 'message';
            msgEl.textContent = '';
        }, 4000);
    }
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
