import { db, auth } from './firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { collection, query, orderBy, onSnapshot, getDocs, writeBatch, doc } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

const EMPLEADOS_KEY = 'empleados_list';
const EMPLEADOS_DEFAULT = ['Albert','Maikel','Carlos','Jecko','Pol','Sonia','Nacho','Claudia'];

let callbackModal = null;
let fichajesGlobales = []; // Caché en memoria para filtros y exportación

document.addEventListener('DOMContentLoaded', () => {
    // Proteger ruta
    onAuthStateChanged(auth, (user) => {
        if (!user) {
            window.location.href = 'login.html';
        } else {
            inicializarAdmin();
        }
    });
});

function inicializarAdmin() {
    configurarBotones();
    configurarFiltros();
    configurarModal();
    inicializarEmpleados();
    cargarDatosEnTiempoReal();
    
    // Ocultar panel de webhook (ya no se usa con Firebase)
    const btnConfig = document.getElementById('btnConfig');
    if(btnConfig) btnConfig.style.display = 'none';
}

function cargarDatosEnTiempoReal() {
    mostrarMensaje('Cargando registros...', 'info');
    
    const q = query(collection(db, "fichajes"), orderBy("timestamp", "desc"));
    
    onSnapshot(q, (snapshot) => {
        const fichajes = [];
        snapshot.forEach((doc) => {
            fichajes.push({ id: doc.id, ...doc.data() });
        });
        
        fichajesGlobales = fichajes;
        renderizarTablas(fichajes);
        mostrarMensaje('✓ Registros sincronizados', 'success');
    }, (error) => {
        console.error("Error al obtener datos:", error);
        mostrarMensaje('✗ Error al leer registros de Firebase', 'error');
    });
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
function obtenerListaEmpleados() {
    return JSON.parse(localStorage.getItem(EMPLEADOS_KEY)) || EMPLEADOS_DEFAULT;
}

function guardarListaEmpleados(lista) {
    localStorage.setItem(EMPLEADOS_KEY, JSON.stringify(lista));
}

function inicializarEmpleados() {
    if (!localStorage.getItem(EMPLEADOS_KEY)) {
        guardarListaEmpleados(EMPLEADOS_DEFAULT);
    }
    renderEmpleados();
}

function renderEmpleados() {
    const lista = obtenerListaEmpleados();
    const contenedor = document.getElementById('empleadosLista');
    if (lista.length === 0) {
        contenedor.innerHTML = '<span style="color:#9ca3af;font-size:13px">Sin empleados</span>';
        return;
    }
    contenedor.innerHTML = lista.map(emp => `
        <div class="empleado-tag">
            ${emp}
            <button type="button" title="Eliminar ${emp}" onclick="window.confirmarEliminarEmpleado('${emp.replace(/'/g, "\\'")}')">✕</button>
        </div>
    `).join('');
}

window.confirmarEliminarEmpleado = function(nombre) {
    mostrarModal(
        '👤 Eliminar empleado',
        `¿Eliminar a "${nombre}" de la lista? Sus fichajes anteriores se conservarán.`,
        () => {
            const lista = obtenerListaEmpleados().filter(e => e !== nombre);
            guardarListaEmpleados(lista);
            renderEmpleados();
            mostrarMensaje(`✓ "${nombre}" eliminado`, 'success');
        }
    );
};

function configurarFormEmpleados() {
    document.getElementById('formNuevoEmpleado').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('inputNuevoEmpleado');
        const nombre = input.value.trim();

        if (!nombre) return;

        const lista = obtenerListaEmpleados();
        if (lista.some(e => e.toLowerCase() === nombre.toLowerCase())) {
            mostrarMensaje(`⚠ "${nombre}" ya existe`, 'error');
            return;
        }

        lista.push(nombre);
        guardarListaEmpleados(lista);
        renderEmpleados();
        input.value = '';
        mostrarMensaje(`✓ "${nombre}" añadido`, 'success');
    });
}

function crearContenidoCronologico(fichajes) {
    const filas = fichajes
        .map(f => `
            <tr>
                <td class="fecha">${f.fecha}</td>
                <td class="hora">${f.hora}</td>
                <td><strong>${f.empleado}</strong></td>
                <td>
                    <span class="tipo ${f.tipo}">
                        ${getTipoLabel(f.tipo)}
                    </span>
                </td>
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
    const filtroEmpleado = document.getElementById('filtroEmpleado');
    const filtroDesde = document.getElementById('filtroFechaDesde');
    const filtroHasta = document.getElementById('filtroFechaHasta');
    const btnLimpiar = document.getElementById('btnLimpiarFiltros');

    filtroEmpleado?.addEventListener('input', aplicarFiltros);
    filtroDesde?.addEventListener('change', aplicarFiltros);
    filtroHasta?.addEventListener('change', aplicarFiltros);
    btnLimpiar?.addEventListener('click', limpiarFiltros);
}

function aplicarFiltros() {
    const empleado = (document.getElementById('filtroEmpleado')?.value || '').toLowerCase();
    const desde = document.getElementById('filtroFechaDesde')?.value;
    const hasta = document.getElementById('filtroFechaHasta')?.value;

    const filas = document.querySelectorAll('tbody tr');
    filas.forEach(fila => {
        let mostrar = true;

        if (empleado) {
            // Empleado podría estar en la columna 3 (Cronológico) o no existir (pestañas individuales)
            const celdaEmpleado = fila.querySelector('td:nth-child(3)');
            if (celdaEmpleado && celdaEmpleado.querySelector('.tipo') == null) {
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

    document.getElementById('btnEmpleados').addEventListener('click', () => {
        document.getElementById('panelEmpleados').classList.toggle('visible');
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
            '¿Deseas cerrar tu sesión de Firebase?',
            logoutFirebase
        );
    });
}

async function logoutFirebase() {
    try {
        await signOut(auth);
        window.location.href = 'login.html';
    } catch (error) {
        console.error("Error al hacer logout:", error);
        mostrarMensaje('Error al cerrar sesión', 'error');
    }
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
    mostrarMensaje('⏳ Eliminando datos de Firebase...', 'info');
    
    try {
        const querySnapshot = await getDocs(collection(db, "fichajes"));
        const batch = writeBatch(db);
        
        querySnapshot.forEach((document) => {
            batch.delete(doc(db, "fichajes", document.id));
        });
        
        await batch.commit();
        mostrarMensaje('✓ Todos los registros fueron eliminados', 'success');
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
