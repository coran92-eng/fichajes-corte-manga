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

            const durMin = duracionTurnoMin(entrada, salida);
            const durTxt = durMin != null ? formatDur(durMin) : '—';
            const opE = toOpMinutes(entrada);
            const barLeft  = durMin != null ? (opE / DURACION_OP) * 100 : 0;
            const barWidth = durMin != null ? (durMin / DURACION_OP) * 100 : 0;

            return `
                <td>
                    <div class="horario-cell${esLibre ? ' es-libre' : ''}"
                         data-empleado="${escapeAttr(empleado)}"
                         data-fecha="${fecha}">
                        <label class="libranza-toggle">
                            <input type="checkbox" class="chk-libre"${esLibre ? ' checked' : ''}> Libre
                        </label>
                        <input type="time" class="inp-entrada" step="1800" value="${entrada}" aria-label="Hora entrada">
                        <input type="time" class="inp-salida"  step="1800" value="${salida}"  aria-label="Hora salida">
                        <span class="turno-dur">${durTxt}</span>
                        <div class="turno-bar" aria-hidden="true">
                            <div class="turno-bar-fill" style="left:${barLeft.toFixed(1)}%;width:${barWidth.toFixed(1)}%"></div>
                        </div>
                    </div>
                </td>
            `;
        }).join('');

        return `
            <tr class="${rolClass.trim()}">
                <td class="td-empleado">${escapeHtml(empleado)}</td>
                ${cells}
            </tr>
        `;
    }).join('');

    wrapper.innerHTML = `
        <table class="horario-grid" aria-label="Horario semanal">
            <thead>
                <tr>
                    <th class="col-empleado">Empleado</th>
                    ${headerCols}
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
    // Recalcular duración y barra al cambiar horas
    wrapper.querySelectorAll('.inp-entrada, .inp-salida').forEach(inp => {
        inp.addEventListener('change', () => actualizarCelda(inp.closest('.horario-cell')));
    });

    document.getElementById('leyendaRoles').style.display = 'flex';
    document.getElementById('btnEnviar').disabled = false;
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function actualizarCelda(cell) {
    if (!cell) return;
    const entrada = cell.querySelector('.inp-entrada')?.value || '';
    const salida  = cell.querySelector('.inp-salida')?.value || '';
    const durEl = cell.querySelector('.turno-dur');
    const fillEl = cell.querySelector('.turno-bar-fill');
    const durMin = duracionTurnoMin(entrada, salida);
    if (durEl) durEl.textContent = durMin != null ? formatDur(durMin) : '—';
    if (fillEl) {
        if (durMin != null) {
            const opE = toOpMinutes(entrada);
            fillEl.style.left  = `${((opE / DURACION_OP) * 100).toFixed(1)}%`;
            fillEl.style.width = `${((durMin / DURACION_OP) * 100).toFixed(1)}%`;
        } else {
            fillEl.style.width = '0%';
        }
    }
}

function onLibreToggle(e) {
    const cell = e.target.closest('.horario-cell');
    if (!cell) return;
    if (e.target.checked) {
        cell.classList.add('es-libre');
    } else {
        cell.classList.remove('es-libre');
    }
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
        turnos.push({ empleado, centro: centroActual, fecha, hora_entrada: entrada, hora_salida: salida, semana: semanaActual });
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
