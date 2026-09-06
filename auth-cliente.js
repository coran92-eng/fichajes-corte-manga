/**
 * Sesión de encargado/gerencia en el cliente.
 *
 * El valor guardado en sessionStorage ya no es una cadena fija que se pueda
 * adivinar o copiar del propio código —es una firma que solo el servidor
 * sabe validar—, así que aquí ya no se puede saber con certeza si "vale" o
 * qué nivel es. Solo el servidor lo sabe de verdad.
 *
 * Por eso esto hace dos cosas, y son las dos que puede hacer honestamente:
 *  - exigirSesion(): evita el parpadeo de contenido antes de redirigir si no
 *    hay NADA guardado. No es el control de acceso real.
 *  - siNoAutorizado(): después de cualquier fetch a un endpoint protegido,
 *    si el servidor contesta 401/403 (sesión caducada, contraseña cambiada,
 *    o nunca hubo sesión de verdad), saca de la pantalla.
 */

function exigirSesion(destino) {
    const hay = sessionStorage.getItem('adminToken') || sessionStorage.getItem('encargadoToken');
    if (!hay) window.location.href = destino;
}

/**
 * Para pantallas cuya API exige gerencia y nada menos (mantenimiento.html):
 * si solo hay sesión de encargado, la página cargaría pero cada petición
 * devolvería 403 en silencio. Mejor mandarlo a login directamente.
 */
function exigirSesionAdmin(destino) {
    if (!sessionStorage.getItem('adminToken')) window.location.href = destino;
}

function siNoAutorizado(response, destino) {
    if (response && (response.status === 401 || response.status === 403)) {
        sessionStorage.removeItem('adminToken');
        sessionStorage.removeItem('encargadoToken');
        window.location.href = destino;
        return true;
    }
    return false;
}
