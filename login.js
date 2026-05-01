import { auth } from './firebase-config.js';
import { signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";

document.addEventListener('DOMContentLoaded', () => {
    // Si ya tiene sesión válida de Firebase, redirige a admin
    onAuthStateChanged(auth, (user) => {
        if (user) {
            window.location.href = 'admin.html';
        }
    });

    // Configurar form
    document.getElementById('loginForm').addEventListener('submit', (e) => {
        e.preventDefault();
        intentarLogin();
    });
});

async function intentarLogin() {
    const email = document.getElementById('usuario').value.trim();
    const password = document.getElementById('password').value;

    if (!email || !password) {
        mostrarMensaje('⚠️ Completa correo y contraseña', 'error');
        return;
    }

    try {
        deshabilitarBotones(true);
        mostrarMensaje('Autenticando...', 'info');

        await signInWithEmailAndPassword(auth, email, password);
        
        mostrarMensaje('✓ Acceso correcto. Redirigiendo...', 'success');
        // onAuthStateChanged se encargará de la redirección
        
    } catch (error) {
        console.error("Error en login:", error);
        let mensaje = '✗ Credenciales incorrectas o error de conexión';
        
        if (error.code === 'auth/invalid-credential' || error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password') {
            mensaje = '✗ Correo o contraseña incorrectos';
        } else if (error.code === 'auth/too-many-requests') {
            mensaje = '🔒 Demasiados intentos fallidos. Intenta más tarde.';
        }
        
        mostrarMensaje(mensaje, 'error');
        deshabilitarBotones(false);
    }
}

function deshabilitarBotones(deshabilitado) {
    const btn = document.querySelector('.btn-login');
    btn.disabled = deshabilitado;
    btn.style.opacity = deshabilitado ? '0.5' : '1';
    btn.style.cursor = deshabilitado ? 'not-allowed' : 'pointer';
}

function mostrarMensaje(texto, tipo) {
    const msgEl = document.getElementById('message');
    msgEl.textContent = texto;
    msgEl.className = `message ${tipo}`;
}
