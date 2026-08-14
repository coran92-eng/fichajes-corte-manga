// Lector del horario semanal de Albert exportado a Excel.
//
// La plantilla es una rejilla por día: una fila de horas (7…3), una fila por
// empleado y una columna final con el total. El trabajo se marca pintando las
// celdas, y ahí está toda la información:
//
//   verde  → vacaciones      gris  → día libre
//   azul   → cocina          amarillo → sala        rosa → extra
//
// Dos detalles de la plantilla que hay que respetar:
//   · Las medias horas se marcan partiendo la celda en dos colores (degradado).
//     Numbers los escribe con degree=180, es decir, de derecha a izquierda: la
//     primera parada del degradado es la MITAD DERECHA de la celda.
//   · Un gris en medio de un turno no es día libre, es el descanso; y las horas
//     que cuenta Albert incluyen ese rato.

export const COLORES = {
  vacaciones: '88f94e',
  libre:      '919191',
  cocina:     '00a1fe',
  sala:       'fff056',
  extra:      'ff42a1',
};
const TRABAJO = new Set(['cocina', 'sala', 'extra']);

// ── Utilidades de color ───────────────────────────────────────
function aRgb(hex) {
  const h = String(hex || '').replace(/^#/, '').slice(-6).toLowerCase();
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Traduce un color a su significado. Se busca el más parecido porque la
 * exportación a Excel desvía algún tono un punto (00a2ff → 00a1fe).
 */
export function significadoColor(hex) {
  if (!hex) return 'vacio';
  const [r, g, b] = aRgb(hex);
  if (r > 245 && g > 245 && b > 245) return 'vacio';

  let mejor = 'vacio', mejorDist = Infinity;
  for (const [nombre, ref] of Object.entries(COLORES)) {
    const [rr, gg, bb] = aRgb(ref);
    const d = (r - rr) ** 2 + (g - gg) ** 2 + (b - bb) ** 2;
    if (d < mejorDist) { mejorDist = d; mejor = nombre; }
  }
  return mejorDist <= 3000 ? mejor : 'vacio';
}

// ── Lectura del XML del libro ─────────────────────────────────
function atributo(tag, nombre) {
  const m = new RegExp(`${nombre}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

/** Paleta indexada propia del archivo (Numbers la escribe con sus colores). */
function leePaleta(stylesXml) {
  const bloque = /<colors>[\s\S]*?<\/colors>/.exec(stylesXml);
  if (!bloque) return [];
  return [...bloque[0].matchAll(/<rgbColor rgb="([0-9a-fA-F]+)"\s*\/>/g)].map(m => m[1]);
}

/** Rellenos: sólidos (un color) y degradados (celda partida en dos). */
function leeRellenos(stylesXml, paleta) {
  const bloque = /<fills[\s\S]*?<\/fills>/.exec(stylesXml);
  if (!bloque) return [];

  return [...bloque[0].matchAll(/<fill>([\s\S]*?)<\/fill>/g)].map(m => {
    const cuerpo = m[1];

    if (cuerpo.includes('<gradientFill')) {
      const grados = Number(atributo(cuerpo, 'degree') || 0);
      const paradas = [...cuerpo.matchAll(/<stop position="([\d.]+)"><color rgb="([0-9a-fA-F]+)"\/><\/stop>/g)]
        .map(s => ({ pos: Number(s[1]), color: s[2] }));
      if (!paradas.length) return { tipo: 'ninguno' };

      // Con degree=180 el degradado va de derecha a izquierda: la primera
      // parada corresponde a la mitad derecha de la celda.
      const inicio = significadoColor(paradas[0].color);
      const final = significadoColor(paradas[paradas.length - 1].color);
      const invertido = Math.abs(grados - 180) < 1;
      return invertido
        ? { tipo: 'partido', primera: final, segunda: inicio }
        : { tipo: 'partido', primera: inicio, segunda: final };
    }

    const patron = /<patternFill[^>]*patternType="([^"]+)"/.exec(cuerpo);
    if (!patron || patron[1] === 'none') return { tipo: 'ninguno' };

    const fg = /<fgColor([^/]*)\/>/.exec(cuerpo);
    if (!fg) return { tipo: 'ninguno' };
    const rgb = atributo(fg[1], 'rgb');
    const idx = atributo(fg[1], 'indexed');
    const hex = rgb || (idx != null ? paleta[Number(idx)] : null);
    const sig = significadoColor(hex);
    return { tipo: 'solido', primera: sig, segunda: sig };
  });
}

/** Estilos de celda → índice de relleno. */
function leeEstilos(stylesXml) {
  const bloque = /<cellXfs[\s\S]*?<\/cellXfs>/.exec(stylesXml);
  if (!bloque) return [];
  return [...bloque[0].matchAll(/<xf\b([^>]*?)\/>|<xf\b([^>]*?)>/g)]
    .map(m => Number(atributo(m[1] ?? m[2] ?? '', 'fillId') || 0));
}

function leeTextos(sharedXml) {
  if (!sharedXml) return [];
  return [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''))
    .map(t => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
}

function refACelda(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { fila: Number(m[2]), col };
}

/** Rejilla de la hoja: para cada celda, su valor y su relleno. */
function leeHoja(sheetXml, textos, estilos, rellenos) {
  const celdas = new Map();
  // Ojo: la mayoría de celdas vienen autocerradas (<c r="C9" s="27"/>). Hay que
  // distinguirlas de las que tienen contenido o se engullen las siguientes.
  for (const m of sheetXml.matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g)) {
    const attrs = m[1] ?? m[2] ?? '';
    const cuerpo = m[3] || '';
    const pos = refACelda(atributo(attrs, 'r') || '');
    if (!pos) continue;

    const tipo = atributo(attrs, 't');
    const s = Number(atributo(attrs, 's') || 0);
    const relleno = rellenos[estilos[s] ?? 0] || { tipo: 'ninguno' };

    let valor = null;
    const v = /<v>([\s\S]*?)<\/v>/.exec(cuerpo);
    if (v) valor = tipo === 's' ? (textos[Number(v[1])] ?? '') : v[1];
    const isTag = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(cuerpo);
    if (isTag) valor = isTag[1];

    celdas.set(`${pos.fila}:${pos.col}`, { valor, relleno });
  }
  return celdas;
}

// ── Localización de los bloques de día ────────────────────────
/**
 * Cada día es un bloque suelto dentro de la hoja. Se localiza buscando la fila
 * de horas (7, 8, 9, 10…), que es inconfundible, en lugar de dar por hecho una
 * posición fija: así sigue funcionando si Albert mueve los bloques.
 */
function localizaBloques(celdas) {
  const bloques = [];
  for (const [clave, celda] of celdas) {
    if (String(celda.valor) !== '7') continue;
    const [fila, col] = clave.split(':').map(Number);

    let seguidas = 0;
    for (let i = 1; i <= 10; i++) {
      const sig = celdas.get(`${fila}:${col + i}`);
      if (sig && Number(sig.valor) === 7 + i) seguidas++;
      else break;
    }
    if (seguidas >= 8) bloques.push({ fila, col });
  }
  return bloques;
}

/**
 * Fecha del bloque. Excel guarda las fechas como número de días desde el
 * 30/12/1899; Albert además escribe alguna a mano ("10/8//2026", con la barra
 * repetida), así que se aceptan las dos formas.
 */
export function normalizaFecha(valor) {
  if (valor == null || valor === '') return null;

  const texto = String(valor).trim();
  if (/^\d+(\.\d+)?$/.test(texto)) {
    const serie = Number(texto);
    if (serie > 20000 && serie < 80000) {
      const ms = Date.UTC(1899, 11, 30) + Math.round(serie) * 86400000;
      const d = new Date(ms);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
    return null;
  }

  const m = /^(\d{1,2})\s*\/+\s*(\d{1,2})\s*\/+\s*(\d{2,4})$/.exec(texto);
  if (!m) return null;
  const [, dia, mes, anyo] = m;
  const a = anyo.length === 2 ? 2000 + Number(anyo) : Number(anyo);
  return `${a}-${String(Number(mes)).padStart(2, '0')}-${String(Number(dia)).padStart(2, '0')}`;
}

function hhmm(h, m) {
  return `${String(((h % 24) + 24) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Convierte la fila de colores de una persona en su turno del día. */
export function interpretaFila(tramos) {
  const idx = tramos.map((t, i) => TRABAJO.has(t.tipo) ? i : -1).filter(i => i >= 0);

  if (!idx.length) {
    const vac = tramos.some(t => t.tipo === 'vacaciones');
    return { estado: vac ? 'vacaciones' : 'libre' };
  }

  const ini = idx[0], fin = idx[idx.length - 1];
  const entrada = hhmm(tramos[ini].hora, tramos[ini].min);
  const finTramo = tramos[fin].min === 0
    ? { h: tramos[fin].hora, m: 30 }
    : { h: tramos[fin].hora + 1, m: 0 };
  const salida = hhmm(finTramo.h, finTramo.m);

  // Gris por dentro = descanso (fuera sería día libre).
  let descanso = null;
  for (let i = ini; i < fin; i++) {
    if (tramos[i].tipo === 'libre') { descanso = hhmm(tramos[i].hora, tramos[i].min); break; }
  }

  // Cambio de puesto a media jornada.
  const rol = tramos[ini].tipo;
  let rolSegunda = null, horaCambio = null;
  for (const i of idx) {
    if (tramos[i].tipo !== rol) {
      rolSegunda = tramos[i].tipo;
      horaCambio = hhmm(tramos[i].hora, tramos[i].min);
      break;
    }
  }

  // Albert cuenta el turno de punta a punta, descanso incluido.
  const horas = (fin - ini + 1) * 0.5;
  return { estado: 'turno', entrada, salida, rol, rol_segunda: rolSegunda, hora_cambio: horaCambio, descanso, horas };
}

/** Lee el libro completo y devuelve los días con sus turnos. */
export function leeLibro({ sheetXml, stylesXml, sharedXml }) {
  const paleta = leePaleta(stylesXml);
  const rellenos = leeRellenos(stylesXml, paleta);
  const estilos = leeEstilos(stylesXml);
  const textos = leeTextos(sharedXml);
  const celdas = leeHoja(sheetXml, textos, estilos, rellenos);

  const dias = [];
  for (const b of localizaBloques(celdas)) {
    const bruto = celdas.get(`${b.fila}:${b.col - 1}`)?.valor ?? null;
    const fecha = normalizaFecha(bruto);

    // Horas de la cabecera: de 7 en adelante hasta que se corta.
    const horas = [];
    for (let c = b.col; c < b.col + 30; c++) {
      const v = celdas.get(`${b.fila}:${c}`)?.valor;
      if (v === null || v === undefined || v === '') break;
      horas.push({ col: c, hora: Number(v) });
    }

    const personas = [];
    for (let f = b.fila + 2; f < b.fila + 20; f++) {
      const nombre = String(celdas.get(`${f}:${b.col - 1}`)?.valor ?? '').trim();
      if (!nombre) continue;

      const tramos = [];
      for (const { col, hora } of horas) {
        const r = celdas.get(`${f}:${col}`)?.relleno || { tipo: 'ninguno' };
        const primera = r.tipo === 'ninguno' ? 'vacio' : r.primera;
        const segunda = r.tipo === 'ninguno' ? 'vacio' : r.segunda;
        tramos.push({ hora, min: 0, tipo: primera });
        tramos.push({ hora, min: 30, tipo: segunda });
      }

      const totalHoja = celdas.get(`${f}:${horas[horas.length - 1].col + 1}`)?.valor;
      personas.push({
        nombre,
        total_hoja: totalHoja == null || totalHoja === '' ? null : Number(totalHoja),
        ...interpretaFila(tramos),
      });
    }

    if (personas.length) dias.push({ fecha, fecha_bruta: bruto, personas });
  }
  return dias;
}

// ── Apertura del archivo .xlsx ────────────────────────────────
// Un .xlsx es un zip con XML dentro. Se abre con DecompressionStream, que ya
// viene en el navegador, para no depender de ninguna librería externa.

function leeUint32(v, off) { return v.getUint32(off, true); }
function leeUint16(v, off) { return v.getUint16(off, true); }

async function inflar(buf, comprimido) {
  if (!comprimido) return buf;
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Extrae del zip solo los archivos que interesan. */
export async function abreXlsx(arrayBuffer, queremos) {
  const datos = new Uint8Array(arrayBuffer);
  const vista = new DataView(arrayBuffer);

  // Fin del directorio central: se busca desde el final.
  let eocd = -1;
  for (let i = datos.length - 22; i >= 0 && i > datos.length - 66000; i--) {
    if (leeUint32(vista, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('El archivo no parece un Excel válido');

  const total = leeUint16(vista, eocd + 10);
  let pos = leeUint32(vista, eocd + 16);
  const salida = {};
  const decodificador = new TextDecoder('utf-8');

  for (let n = 0; n < total; n++) {
    if (leeUint32(vista, pos) !== 0x02014b50) break;
    const metodo = leeUint16(vista, pos + 10);
    const tamComprimido = leeUint32(vista, pos + 20);
    const largoNombre = leeUint16(vista, pos + 28);
    const largoExtra = leeUint16(vista, pos + 30);
    const largoComentario = leeUint16(vista, pos + 32);
    const offsetLocal = leeUint32(vista, pos + 42);
    const nombre = decodificador.decode(datos.subarray(pos + 46, pos + 46 + largoNombre));

    if (queremos.some(q => nombre.endsWith(q))) {
      // La cabecera local repite los tamaños de nombre y extra, y pueden
      // diferir de los del directorio: hay que leerlos de ahí.
      const nombreLocal = leeUint16(vista, offsetLocal + 26);
      const extraLocal = leeUint16(vista, offsetLocal + 28);
      const inicio = offsetLocal + 30 + nombreLocal + extraLocal;
      const crudo = datos.subarray(inicio, inicio + tamComprimido);
      salida[nombre] = decodificador.decode(await inflar(crudo, metodo === 8));
    }

    pos += 46 + largoNombre + largoExtra + largoComentario;
  }
  return salida;
}

/** Lee un .xlsx completo y devuelve los días con sus turnos. */
export async function leeXlsx(arrayBuffer) {
  const partes = await abreXlsx(arrayBuffer, [
    'xl/styles.xml', 'xl/sharedStrings.xml', 'sheet1.xml',
  ]);
  const busca = sufijo => Object.entries(partes).find(([k]) => k.endsWith(sufijo))?.[1] || '';

  const sheetXml = busca('sheet1.xml');
  if (!sheetXml) throw new Error('No se ha encontrado la hoja de cálculo dentro del archivo');

  return leeLibro({
    sheetXml,
    stylesXml: busca('styles.xml'),
    sharedXml: busca('sharedStrings.xml'),
  });
}
