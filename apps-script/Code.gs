/**
 * Topito — puente entre topito-server y este Google Sheet.
 *
 * Pestañas:
 *   • "Banco de copys": espejo de los copys marcados 👍 (lo escribe el server).
 *   • "Glosario": lo edita Content. Columnas: Marca | Tipo | Término | Nota/Reemplazo
 *       Marca: benandfrank, bombavista o todas
 *       Tipo:  prohibida o preferida
 *
 * Instalación (una sola vez):
 *   1. Extensiones → Apps Script, pega este archivo y guarda.
 *   2. Ejecuta la función `configurarTopito` (autoriza los permisos cuando lo pida).
 *      Crea las pestañas y genera el secreto; cópialo del cuadro que aparece en el Sheet.
 *   3. Implementar → Nueva implementación → Tipo "Aplicación web"
 *        Ejecutar como: Yo · Quién tiene acceso: Cualquier persona
 *      Copia la URL que termina en /exec.
 *   4. En Render: TOPITO_SHEET_WEBHOOK_URL = esa URL, TOPITO_SHEET_SECRET = el secreto.
 *
 * Fase 3:
 *   • "Lote": pestaña donde Content pega filas (Acción | Marca | Formato | Texto o
 *     brief) y usa el menú Topito → "Generar copy (filas seleccionadas)". Llama a
 *     topito-server /sheets/copy con el mismo secreto y escribe hasta 4 opciones.
 *   • readDoc: topito-server le pide leer un Google Doc/Sheet que alguien pegó en
 *     Slack. Solo responde si esa persona (correo verificado por Slack) tiene
 *     acceso al archivo: compartido con el dominio/cualquiera, o ella es dueña,
 *     editora o lectora. Así Topito no puede usarse para leer lo que no te
 *     compartieron, aunque el script corra con la cuenta de Zul.
 *
 * Seguridad: "Cualquier persona" solo significa que la URL no pide login de
 * Google; sin el secreto correcto toda petición se rechaza. Permisos mínimos en
 * appsscript.json (lectura de Drive/Docs/Sheets, escritura solo en ESTE Sheet).
 */

var BANK_TAB = 'Banco de copys';
var GLOSSARY_TAB = 'Glosario';
var BANK_HEADERS = ['Fecha', 'Marca', 'Origen', 'Copy', 'Texto original', 'Autor', 'Canal'];
var GLOSSARY_HEADERS = ['Marca', 'Tipo', 'Término', 'Nota / reemplazo'];
var LOTE_TAB = 'Lote';
var LOTE_HEADERS = ['Acción', 'Marca', 'Formato', 'Texto o brief', 'Opción 1', 'Opción 2', 'Opción 3', 'Opción 4', 'Estado'];
var FORMATOS = ['general', 'headline', 'primario', 'caption', 'web', 'email', 'google_ads', 'hook', 'cta'];
var DEFAULT_SERVER_URL = 'https://topito-server.onrender.com';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Topito')
    .addItem('✍️ Generar copy (filas seleccionadas)', 'generarCopySeleccion')
    .addSeparator()
    .addItem('⚙️ Configurar pestañas', 'configurarTopito')
    .addToUi();
}

function configurarTopito() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureTab_(ss, BANK_TAB, BANK_HEADERS);
  var glossary = ensureTab_(ss, GLOSSARY_TAB, GLOSSARY_HEADERS);
  if (glossary.getLastRow() < 2) {
    glossary.getRange(2, 1, 2, 4).setValues([
      ['todas', 'prohibida', 'vos', 'usa "tú"'],
      ['benandfrank', 'preferida', 'Ben & Frank', 'siempre con &'],
    ]);
  }
  // Validación de datos para que Content no se equivoque en Marca/Tipo.
  glossary.getRange('A2:A').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['todas', 'benandfrank', 'bombavista'], true).build());
  glossary.getRange('B2:B').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['prohibida', 'preferida'], true).build());

  var lote = ensureTab_(ss, LOTE_TAB, LOTE_HEADERS);
  lote.getRange('A2:A').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['crear', 'reescribir', 'ortografia'], true).build());
  lote.getRange('B2:B').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['benandfrank', 'bombavista'], true).build());
  lote.getRange('C2:C').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(FORMATOS, true).build());
  lote.setColumnWidth(4, 320);
  for (var c = 5; c <= 8; c++) lote.setColumnWidth(c, 260);
  lote.getRange('D:H').setWrap(true);
  if (lote.getLastRow() < 2) {
    lote.getRange(2, 1, 1, 4).setValues([['crear', 'benandfrank', 'caption', 'Lanzamiento de la colección de lentes de sol de verano']]);
  }

  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('TOPITO_SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TOPITO_SECRET', secret);
  }
  // Se muestra en el Registro de ejecución (getUi() no funciona al ejecutar desde el editor).
  console.log('Topito configurado ✅  Secreto para Render (TOPITO_SHEET_SECRET): ' + secret);
  try { SpreadsheetApp.getUi().alert('Topito configurado ✅\n\nSecreto para Render (TOPITO_SHEET_SECRET):\n\n' + secret); } catch (e) {}
}

// Ejecuta esto una vez desde el editor si el menú dice que falta permiso para
// UrlFetchApp: pide autorizar la conexión con topito-server y la prueba.
function probarConexion() {
  // Con el consentimiento granular de Google se puede autorizar solo una parte de
  // los permisos; esto vuelve a pedir TODOS los de appsscript.json si falta alguno.
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  var url = (PropertiesService.getScriptProperties().getProperty('TOPITO_SERVER_URL') || DEFAULT_SERVER_URL) + '/health';
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  console.log('topito-server respondió ' + res.getResponseCode() + ': ' + res.getContentText());
}

function ensureTab_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    var secret = PropertiesService.getScriptProperties().getProperty('TOPITO_SECRET');
    if (!secret || body.secret !== secret) return json_({ ok: false, error: 'unauthorized' });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (body.action === 'appendBank') {
      var row = (body.row || []).slice(0, BANK_HEADERS.length).map(function (v) { return String(v == null ? '' : v); });
      ss.getSheetByName(BANK_TAB).appendRow(row);
      return json_({ ok: true });
    }
    if (body.action === 'glossary') {
      var sh = ss.getSheetByName(GLOSSARY_TAB);
      var last = sh.getLastRow();
      var rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, 4).getDisplayValues();
      return json_({ ok: true, rows: rows });
    }
    if (body.action === 'readDoc') return json_(readDoc_(body.url, body.requester));
    if (body.action === 'ping') return json_({ ok: true });
    return json_({ ok: false, error: 'acción desconocida' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Fase 3: leer un Doc/Sheet para Slack (con verificación de acceso)
// ---------------------------------------------------------------------------
function readDoc_(url, requester) {
  var m = String(url || '').match(/\/d\/([\w-]+)/);
  if (!m) return { ok: false, error: 'link inválido' };
  var email = String(requester || '').toLowerCase();
  var file;
  try {
    file = DriveApp.getFileById(m[1]);
  } catch (e) {
    return { ok: false, error: 'sin acceso' };
  }
  if (!canAccess_(file, email)) return { ok: false, error: 'sin acceso' };

  var mime = file.getMimeType();
  var text = '';
  if (mime === MimeType.GOOGLE_DOCS) {
    text = DocumentApp.openById(file.getId()).getBody().getText();
  } else if (mime === MimeType.GOOGLE_SHEETS) {
    var ss = SpreadsheetApp.openById(file.getId());
    var gid = (String(url).match(/[#&?]gid=(\d+)/) || [])[1];
    var sheet = null;
    if (gid) ss.getSheets().forEach(function (sh) { if (String(sh.getSheetId()) === gid) sheet = sh; });
    sheet = sheet || ss.getSheets()[0];
    var values = sheet.getDataRange().getDisplayValues().slice(0, 200);
    text = values
      .map(function (r) { return r.filter(function (c) { return String(c).trim(); }).join(' | '); })
      .filter(function (l) { return l; })
      .join('\n');
  } else {
    return { ok: false, error: 'solo Google Docs o Sheets' };
  }
  return { ok: true, title: file.getName(), text: text.slice(0, 20000) };
}

function canAccess_(file, email) {
  if (!email) return false;
  var a = file.getSharingAccess();
  if (a === DriveApp.Access.ANYONE || a === DriveApp.Access.ANYONE_WITH_LINK ||
      a === DriveApp.Access.DOMAIN || a === DriveApp.Access.DOMAIN_WITH_LINK) return true;
  var owner = file.getOwner();
  if (owner && owner.getEmail().toLowerCase() === email) return true;
  return file.getEditors().concat(file.getViewers()).some(function (u) {
    return u.getEmail().toLowerCase() === email;
  });
}

// ---------------------------------------------------------------------------
// Fase 3: menú Topito → generar copy para las filas seleccionadas de "Lote"
// ---------------------------------------------------------------------------
function generarCopySeleccion() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  if (sheet.getName() !== LOTE_TAB) {
    ui.alert('Ve a la pestaña "' + LOTE_TAB + '", selecciona las filas y vuelve a intentar.');
    return;
  }
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('TOPITO_SECRET');
  var serverUrl = props.getProperty('TOPITO_SERVER_URL') || DEFAULT_SERVER_URL;
  var range = sheet.getActiveRange();
  var first = Math.max(2, range.getRow());
  var last = range.getLastRow();
  var started = Date.now();
  var done = 0;

  for (var row = first; row <= last; row++) {
    if (Date.now() - started > 5 * 60 * 1000) {
      ui.alert('Se procesaron ' + done + ' filas. Apps Script tiene un límite de 6 min: selecciona las que faltan y vuelve a correrlo.');
      return;
    }
    var v = sheet.getRange(row, 1, 1, 4).getValues()[0];
    var accion = String(v[0] || 'crear').trim();
    var marca = String(v[1] || 'benandfrank').trim();
    var formato = String(v[2] || 'general').trim();
    var texto = String(v[3] || '').trim();
    if (!texto) continue;
    sheet.getRange(row, 9).setValue('⏳ escribiendo…');
    SpreadsheetApp.flush();
    try {
      var res = UrlFetchApp.fetch(serverUrl + '/sheets/copy', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'X-Topito-Secret': secret },
        payload: JSON.stringify({ action: accion, brand: marca, format: formato, text: texto }),
        muteHttpExceptions: true,
      });
      var data = JSON.parse(res.getContentText() || '{}');
      if (res.getResponseCode() !== 200) throw new Error(data.error || ('HTTP ' + res.getResponseCode()));
      var opts = (data.options || []).slice(0, 4).map(function (o) {
        var warn = o.ok === false ? ' ⚠️' : '';
        return (o.angleLabel ? '[' + o.angleLabel + '] ' : '') + o.text + warn;
      });
      while (opts.length < 4) opts.push('');
      sheet.getRange(row, 5, 1, 4).setValues([opts]);
      sheet.getRange(row, 9).setValue('✅ ' + Utilities.formatDate(new Date(), 'America/Mexico_City', 'dd/MM HH:mm'));
      done++;
    } catch (err) {
      sheet.getRange(row, 9).setValue('⚠️ ' + String(err.message || err).slice(0, 120));
    }
    SpreadsheetApp.flush();
  }
  ss.toast(done + ' fila(s) listas', 'Topito', 5);
}
