document.addEventListener('DOMContentLoaded', () => {
    // Si ya tiene sesión válida, redirige a admin
    const token = sessionStorage.getItem('adminToken');
    if (token) {
        window.location.href = 'admin.html';
    }

    // Configurar form
    document.getElementById('loginForm').addEventListener('submit', (e) => {
        e.preventDefault();
        intentarLogin();
    });

    // Toggle mostrar/ocultar contraseña
    const toggleBtn = document.getElementById('togglePassword');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            const input = document.getElementById('password');
            const icon = document.getElementById('toggleIcon');
            const visible = input.type === 'text';
            input.type = visible ? 'password' : 'text';
            if (icon) icon.setAttribute('data-lucide', visible ? 'eye' : 'eye-off');
            toggleBtn.setAttribute('aria-label', visible ? 'Mostrar contraseña' : 'Ocultar contraseña');
            if (typeof lucide !== 'undefined') lucide.createIcons();
        });
    }
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

        const response = await fetch('/api/auth', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ password })
        });

        if (!response.ok) {
            throw new Error('Credenciales incorrectas');
        }

        const data = await response.json();
        
        // Guardar token en sesión
        sessionStorage.setItem('adminToken', data.token);

        mostrarMensaje('✓ Acceso correcto. Redirigiendo...', 'success');
        setTimeout(() => {
            window.location.href = 'admin.html';
        }, 500);
        
    } catch (error) {
        console.error("Error en login:", error);
        mostrarMensaje('✗ Contraseña incorrecta o error de conexión', 'error');
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
