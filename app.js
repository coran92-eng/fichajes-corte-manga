
// Configuración de empleados (Por defecto, se puede cargar de Firestore luego)
const EMPLEADOS_DEFAULT = [
    'Albert', 'Maikel', 'Carlos', 'Jecko', 
    'Pol', 'Sonia', 'Nacho', 'Claudia'
];

const EMPLEADOS_KEY = 'empleados_list';

// Inicializar
document.addEventListener('DOMContentLoaded', () => {
    inicializar();
    actualizarReloj();
    setInterval(actualizarReloj, 1000);
});

function inicializar() {
    cargarEmpleados();
    configurarNFC();
    configurarBotones();
    
    // Escuchar cambios en el selector para actualizar la última acción
    document.getElementById('empleado').addEventListener('change', actualizarUltimaAccion);
}

function cargarEmpleados() {
    const select = document.getElementById('empleado');
    const empleados = JSON.parse(localStorage.getItem(EMPLEADOS_KEY)) || EMPLEADOS_DEFAULT;

    // Limpiar opciones previas excepto la primera
    select.innerHTML = '<option value="">-- Selecciona tu nombre --</option>';

    empleados.forEach(empleado => {
        const option = document.createElement('option');
        option.value = empleado;
        option.textContent = empleado;
        select.appendChild(option);
    });
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
        ndef.onreading = (event) => {
            mostrarMensaje('✓ NFC detectado', 'info');
            const empleado = document.getElementById('empleado').value;
            if (empleado) {
                document.getElementById('btnEntrada').focus();
            } else {
                mostrarMensaje('Por favor selecciona tu nombre', 'error');
            }
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
}

async function registrarFichaje(tipo) {
    const empleado = document.getElementById('empleado').value;
    const btnElements = document.querySelectorAll('button');

    if (!empleado) {
        mostrarMensaje('Por favor selecciona tu nombre', 'error');
        return;
    }

    try {
        // Deshabilitar botones mientras guarda
        btnElements.forEach(btn => btn.disabled = true);
        
        const now = new Date();
        const fichaje = {
            empleado: empleado,
            tipo: tipo,
            fecha: now.toISOString().split('T')[0],
            hora: now.toTimeString().split(' ')[0],
            timestamp: now.getTime()
        };

        // Guardar via API de Vercel
        const response = await fetch('/api/fichajes', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(fichaje)
        });

        if (!response.ok) {
            throw new Error('Error en la respuesta del servidor');
        }

        // Feedback visual y sonoro
        reproducirSonidoConfirmacion();
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

        const mensajes = {
            'entrada': '✓ Entrada registrada',
            'salida': '✓ Salida registrada',
            'inicio_descanso': '✓ Descanso iniciado',
            'fin_descanso': '✓ Descanso finalizado'
        };

        mostrarMensaje(mensajes[tipo], 'success');
        
    } catch (error) {
        console.error('Error al registrar:', error);
        mostrarMensaje('✗ Error al guardar. Intenta de nuevo.', 'error');
    } finally {
        // Reactivar botones
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
        return;
    }

    lastActionEl.innerHTML = 'Cargando último registro...';

    const fetchUltimaAccion = async () => {
        try {
            const response = await fetch(`/api/fichajes?empleado=${encodeURIComponent(empleado)}&limit=1`);
            if (!response.ok) throw new Error('Error al obtener datos');
            const data = await response.json();
            
            if (data.length > 0) {
                const ultimoFichaje = data[0];
                const tipos = {
                    'entrada': 'Entrada',
                    'salida': 'Salida',
                    'inicio_descanso': 'Inicio de Descanso',
                    'fin_descanso': 'Fin de Descanso'
                };
                lastActionEl.innerHTML = `<strong>Último registro:</strong><br>${tipos[ultimoFichaje.tipo]}<br>${ultimoFichaje.hora}`;
                lastActionEl.className = 'last-action has-data';
            } else {
                lastActionEl.innerHTML = 'No tienes registros aún';
                lastActionEl.className = 'last-action';
            }
        } catch (error) {
            console.error("Error al obtener última acción:", error);
            lastActionEl.innerHTML = 'Error al cargar historial';
        }
    };

    fetchUltimaAccion();
    // Refrescar cada 10 segundos
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
    } catch (e) {}
}

function mostrarMensaje(texto, tipo) {
    const msgEl = document.getElementById('message');
    msgEl.textContent = texto;
    msgEl.className = `message ${tipo}`;
    setTimeout(() => {
        msgEl.className = 'message';
    }, 3000);
}
