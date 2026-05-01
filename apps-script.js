var HOJA_F = "Fichajes";
var HOJA_R = "Resumen Semanal";

function doPost(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var d = JSON.parse(e.postData.contents);
  grabarFichaje(ss, d);
  actualizarResumen(ss);
  return ContentService.createTextOutput("OK");
}

function tipoLabel(t) {
  if (t == "entrada") return "Entrada";
  if (t == "salida") return "Salida";
  if (t == "inicio_descanso") return "Inicio Descanso";
  if (t == "fin_descanso") return "Fin Descanso";
  return t;
}

function tipoColor(t) {
  if (t == "entrada") return "#d1fae5";
  if (t == "salida") return "#fee2e2";
  if (t == "inicio_descanso") return "#fef3c7";
  if (t == "fin_descanso") return "#dbeafe";
  return "#ffffff";
}

function grabarFichaje(ss, d) {
  var hoja = ss.getSheetByName(HOJA_F);
  if (!hoja) hoja = ss.insertSheet(HOJA_F);
  if (hoja.getLastRow() == 0) {
    hoja.appendRow(["Empleado", "Tipo", "Fecha", "Hora"]);
    var h = hoja.getRange(1, 1, 1, 4);
    h.setBackground("#1e40af");
    h.setFontColor("#ffffff");
    h.setFontWeight("bold");
    hoja.setFrozenRows(1);
    hoja.setColumnWidth(1, 130);
    hoja.setColumnWidth(2, 150);
    hoja.setColumnWidth(3, 110);
    hoja.setColumnWidth(4, 90);
  }
  var fila = hoja.getLastRow() + 1;
  hoja.appendRow([d.empleado, tipoLabel(d.tipo), d.fecha, d.hora]);
  hoja.getRange(fila, 1, 1, 4).setBackground(tipoColor(d.tipo));
}

function actualizarResumen(ss) {
  var hojaF = ss.getSheetByName(HOJA_F);
  if (!hojaF || hojaF.getLastRow() < 2) return;
  var datos = hojaF.getRange(2, 1, hojaF.getLastRow() - 1, 4).getValues();
  var grupos = {};
  for (var i = 0; i < datos.length; i++) {
    var emp = datos[i][0];
    var tipo = datos[i][1];
    var fecha = datos[i][2];
    var hora = datos[i][3];
    if (!emp || !fecha) continue;
    var fs = fecha instanceof Date ? fmtFecha(fecha) : String(fecha);
    var sem = isoSemana(fs);
    var key = sem + "|" + emp;
    if (!grupos[key]) grupos[key] = {emp: emp, sem: sem, dias: {}};
    if (!grupos[key].dias[fs]) grupos[key].dias[fs] = [];
    grupos[key].dias[fs].push({tipo: String(tipo), hora: String(hora)});
  }
  var claves = Object.keys(grupos).sort().reverse();
  var filas = [];
  for (var j = 0; j < claves.length; j++) {
    var g = grupos[claves[j]];
    var c = calcHoras(g.dias);
    filas.push([g.emp, labelSemana(g.sem), c.totales, c.descanso, c.netas, c.primera, c.ultima]);
  }
  var hojaR = ss.getSheetByName(HOJA_R);
  if (!hojaR) hojaR = ss.insertSheet(HOJA_R);
  hojaR.clearContents();
  hojaR.clearFormats();
  hojaR.appendRow(["Empleado", "Semana", "Horas Brutas", "Descanso", "Horas Netas", "1a Entrada", "Ultima Salida"]);
  var rh = hojaR.getRange(1, 1, 1, 7);
  rh.setBackground("#1e40af");
  rh.setFontColor("#ffffff");
  rh.setFontWeight("bold");
  hojaR.setFrozenRows(1);
  if (filas.length > 0) hojaR.getRange(2, 1, filas.length, 7).setValues(filas);
  hojaR.setColumnWidth(1, 130);
  hojaR.setColumnWidth(2, 210);
  hojaR.setColumnWidth(3, 110);
  hojaR.setColumnWidth(4, 100);
  hojaR.setColumnWidth(5, 110);
  hojaR.setColumnWidth(6, 110);
  hojaR.setColumnWidth(7, 110);
}

function calcHoras(dias) {
  var totalMs = 0, descansoMs = 0, entradas = [], salidas = [];
  var fechas = Object.keys(dias);
  for (var i = 0; i < fechas.length; i++) {
    var fics = dias[fechas[i]].slice().sort(function(a, b) { return a.hora > b.hora ? 1 : -1; });
    var entMs = null, desIniMs = null;
    for (var j = 0; j < fics.length; j++) {
      var ms = horaMs(fics[j].hora);
      var t = fics[j].tipo;
      if (t == "Entrada") { entMs = ms; entradas.push(fics[j].hora); }
      else if (t == "Salida") { if (entMs !== null) totalMs += ms - entMs; salidas.push(fics[j].hora); }
      else if (t == "Inicio Descanso") { desIniMs = ms; }
      else if (t == "Fin Descanso") { if (desIniMs !== null) descansoMs += ms - desIniMs; desIniMs = null; }
    }
  }
  entradas.sort();
  salidas.sort();
  return {
    totales: msFmt(totalMs),
    descanso: msFmt(descansoMs),
    netas: msFmt(Math.max(0, totalMs - descansoMs)),
    primera: entradas[0] || "-",
    ultima: salidas[salidas.length - 1] || "-"
  };
}

function horaMs(h) {
  var p = String(h).split(":");
  return (parseInt(p[0]) * 3600 + parseInt(p[1]) * 60 + parseInt(p[2] || 0)) * 1000;
}

function msFmt(ms) {
  var m = Math.round(ms / 60000);
  return Math.floor(m / 60) + "h " + ("0" + (m % 60)).slice(-2) + "m";
}

function fmtFecha(d) {
  return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
}

function isoSemana(fs) {
  var d = new Date(fs + "T12:00:00Z");
  var dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  var ini = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var w = Math.ceil(((d - ini) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + "-W" + ("0" + w).slice(-2);
}

function labelSemana(iso) {
  var p = iso.split("-W");
  var yr = parseInt(p[0]);
  var wk = parseInt(p[1]);
  var d = new Date(Date.UTC(yr, 0, 1 + (wk - 1) * 7));
  var dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - dow + 1);
  var dom = new Date(d);
  dom.setUTCDate(dom.getUTCDate() + 6);
  var f = function(x) { return ("0" + x.getUTCDate()).slice(-2) + "/" + ("0" + (x.getUTCMonth() + 1)).slice(-2); };
  return "Sem." + p[1] + " (" + f(d) + " - " + f(dom) + "/" + yr + ")";
}
