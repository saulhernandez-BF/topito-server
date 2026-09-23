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
 * Seguridad: "Cualquier persona" solo significa que la URL no pide login de
 * Google; sin el secreto correcto toda petición se rechaza. El script solo
 * puede tocar ESTE Sheet.
 */

var BANK_TAB = 'Banco de copys';
var GLOSSARY_TAB = 'Glosario';
var BANK_HEADERS = ['Fecha', 'Marca', 'Origen', 'Copy', 'Texto original', 'Autor', 'Canal'];
var GLOSSARY_HEADERS = ['Marca', 'Tipo', 'Término', 'Nota / reemplazo'];

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
    if (body.action === 'ping') return json_({ ok: true });
    return json_({ ok: false, error: 'acción desconocida' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
