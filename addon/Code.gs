/**
 * Topito para Google Docs y Google Sheets (complemento de editor, dominio B&F).
 *
 * Qué hace:
 *   • Menú Extensiones → Topito: abrir la barra lateral, reescribir / revisar
 *     ortografía / tropicalizar la selección.
 *   • Barra lateral: Crear, Reescribir, Ortografía y Tropicalizar con marca,
 *     país (MX/CO/CL) y formato; Reemplazar selección o Insertar; 👍 ⚪ 👎 con motivo.
 *   • Sheets: "Procesar cada celda" (escribe el resultado en la columna de la
 *     derecha) y fórmulas =TOPITO(), =TOPITO_REESCRIBIR(), =TOPITO_TROPICALIZAR().
 *
 * Usa el MISMO motor que Slack y el plugin de Figma (topito-server): ejemplos
 * reales ★, glosario, tropicalización, límites por formato y lo que el equipo
 * ha corregido.
 *
 * Configuración (una vez, quien administra el proyecto):
 *   Configuración del proyecto → Propiedades de la secuencia de comandos:
 *     TOPITO_SECRET     = el mismo valor que TOPITO_SHEET_SECRET en Render
 *     TOPITO_SERVER_URL = https://topito-server.onrender.com (opcional)
 *   Las Script Properties no las ven los usuarios del complemento.
 *
 * Seguridad: permisos mínimos (solo el Doc/Sheet abierto, ".currentonly");
 * el server valida el secreto y que el correo sea @benandfrank.com.
 */

var DEFAULT_SERVER_URL = 'https://topito-server.onrender.com';
var MAX_CELDAS = 25; // por corrida de "Procesar cada celda" (Apps Script corta a los 6 min)

// ---------------------------------------------------------------------------
// Menú
// ---------------------------------------------------------------------------
function onInstall(e) {
  onOpen(e);
}

function onOpen(e) {
  getUi_()
    .createAddonMenu()
    .addItem('✍️ Abrir Topito', 'abrirTopito')
    .addSeparator()
    .addItem('🔁 Reescribir selección', 'menuReescribir')
    .addItem('🔤 Revisar ortografía de la selección', 'menuOrtografia')
    .addItem('🌎 Tropicalizar selección (CO / CL)', 'menuTropicalizar')
    .addToUi();
}

function abrirTopito() { abrirSidebar_(null); }
function menuReescribir() { abrirSidebar_('reescribir'); }
function menuOrtografia() { abrirSidebar_('ortografia'); }
function menuTropicalizar() { abrirSidebar_('tropicalizar'); }

function abrirSidebar_(accion) {
  var t = HtmlService.createTemplateFromFile('Sidebar');
  t.initial = JSON.stringify({ action: accion, host: host_() });
  getUi_().showSidebar(t.evaluate().setTitle('Topito'));
}

// ---------------------------------------------------------------------------
// Host (Docs o Sheets)
// ---------------------------------------------------------------------------
function host_() {
  try {
    if (DocumentApp.getActiveDocument()) return 'docs';
  } catch (e) {}
  return 'sheets';
}

function getUi_() {
  return host_() === 'docs' ? DocumentApp.getUi() : SpreadsheetApp.getUi();
}

// ---------------------------------------------------------------------------
// Selección
// ---------------------------------------------------------------------------
/** Texto seleccionado (Docs: selección; Sheets: celdas seleccionadas). */
function leerSeleccion() {
  if (host_() === 'docs') {
    var sel = DocumentApp.getActiveDocument().getSelection();
    if (!sel) return '';
    return sel.getRangeElements().map(function (re) {
      var el = re.getElement();
      if (!el.editAsText) return '';
      var txt = el.asText().getText();
      return re.isPartial() ? txt.substring(re.getStartOffset(), re.getEndOffsetInclusive() + 1) : txt;
    }).filter(function (s) { return s; }).join('\n');
  }
  var range = SpreadsheetApp.getActiveRange();
  if (!range) return '';
  return range.getDisplayValues().map(function (r) {
    return r.filter(function (c) { return String(c).trim(); }).join(' ');
  }).filter(function (s) { return s; }).join('\n');
}

/** Reemplaza la selección por el texto (o lo inserta en el cursor / celda activa). */
function reemplazarSeleccion(texto) {
  if (host_() === 'docs') {
    var doc = DocumentApp.getActiveDocument();
    var sel = doc.getSelection();
    if (sel) {
      var els = sel.getRangeElements().filter(function (re) { return re.getElement().editAsText; });
      if (els.length) {
        var first = els[0];
        var t = first.getElement().editAsText();
        if (first.isPartial()) {
          t.deleteText(first.getStartOffset(), first.getEndOffsetInclusive());
          t.insertText(first.getStartOffset(), texto);
        } else {
          t.setText(texto);
        }
        for (var i = 1; i < els.length; i++) {
          var re = els[i];
          var te = re.getElement().editAsText();
          if (re.isPartial()) te.deleteText(re.getStartOffset(), re.getEndOffsetInclusive());
          else te.setText('');
        }
        return 'ok';
      }
    }
    return insertarTexto(texto);
  }
  var cell = SpreadsheetApp.getActiveRange();
  if (!cell) return 'sin-celda';
  cell.getCell(1, 1).setValue(texto);
  return 'ok';
}

/** Inserta sin borrar: Docs en el cursor (o al final); Sheets en la celda a la derecha. */
function insertarTexto(texto) {
  if (host_() === 'docs') {
    var doc = DocumentApp.getActiveDocument();
    var cursor = doc.getCursor();
    if (cursor) {
      var el = cursor.insertText(texto);
      if (el) return 'ok';
    }
    doc.getBody().appendParagraph(texto);
    return 'ok-final';
  }
  var range = SpreadsheetApp.getActiveRange();
  if (!range) return 'sin-celda';
  range.getCell(1, 1).offset(0, range.getNumColumns()).setValue(texto);
  return 'ok';
}

// ---------------------------------------------------------------------------
// Llamadas a topito-server
// ---------------------------------------------------------------------------
function props_() {
  var p = PropertiesService.getScriptProperties();
  return { secret: p.getProperty('TOPITO_SECRET'), url: p.getProperty('TOPITO_SERVER_URL') || DEFAULT_SERVER_URL };
}

function post_(path, body) {
  var cfg = props_();
  if (!cfg.secret) throw new Error('Topito no está configurado (falta TOPITO_SECRET en el proyecto del complemento).');
  var res = UrlFetchApp.fetch(cfg.url + path, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Topito-Secret': cfg.secret },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  var data = {};
  try { data = JSON.parse(res.getContentText() || '{}'); } catch (e) {}
  if (res.getResponseCode() !== 200) throw new Error(data.error || ('Topito respondió ' + res.getResponseCode()));
  return data;
}

function usuario_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}

/** Lo llama la barra lateral. */
function pedirCopy(req) {
  return post_('/addon/copy', {
    action: req.action,
    text: req.text,
    brand: req.brand,
    format: req.format,
    country: req.country,
    user: usuario_(),
    surface: host_(),
  });
}

/** Calificación (y motivo opcional) desde la barra lateral. */
function mandarFeedback(fb) {
  fb.user = usuario_();
  fb.surface = host_();
  return post_('/addon/feedback', fb);
}

/** Catálogos (marcas, países, formatos, motivos) para los selectores. */
function metaTopito() {
  var cfg = props_();
  var res = UrlFetchApp.fetch(cfg.url + '/addon/meta', { muteHttpExceptions: true });
  return JSON.parse(res.getContentText() || '{}');
}

/** Preferencias por persona (marca, país, formato). */
function leerPrefs() {
  var raw = PropertiesService.getUserProperties().getProperty('TOPITO_PREFS');
  return raw ? JSON.parse(raw) : { brand: 'benandfrank', country: 'mx', format: 'general' };
}
function guardarPrefs(p) {
  PropertiesService.getUserProperties().setProperty('TOPITO_PREFS', JSON.stringify(p || {}));
}

// ---------------------------------------------------------------------------
// Sheets: procesar cada celda seleccionada (resultado a la derecha)
// ---------------------------------------------------------------------------
function procesarCeldas(req) {
  if (host_() !== 'sheets') throw new Error('Solo en Google Sheets.');
  var range = SpreadsheetApp.getActiveRange();
  if (!range) throw new Error('Selecciona las celdas a procesar.');
  var values = range.getDisplayValues();
  var outCol = range.getColumn() + range.getNumColumns();
  var sheet = range.getSheet();
  var hechas = 0;
  var started = Date.now();
  for (var r = 0; r < values.length; r++) {
    var texto = values[r].filter(function (c) { return String(c).trim(); }).join(' ');
    if (!texto) continue;
    if (hechas >= MAX_CELDAS || Date.now() - started > 5 * 60 * 1000) {
      return { hechas: hechas, pendientes: true };
    }
    var target = sheet.getRange(range.getRow() + r, outCol);
    try {
      var data = pedirCopy({ action: req.action, text: texto, brand: req.brand, format: req.format, country: req.country });
      var opts = data.options || [];
      if (req.action === 'tropicalizar') {
        // Una columna por país (CO, CL).
        opts.forEach(function (o, k) { sheet.getRange(range.getRow() + r, outCol + k).setValue(o.text); });
      } else {
        target.setValue(opts.length ? opts[0].text : '⚠️ sin opciones');
      }
    } catch (err) {
      target.setValue('⚠️ ' + String(err.message || err).slice(0, 120));
    }
    hechas++;
    SpreadsheetApp.flush();
  }
  return { hechas: hechas, pendientes: false };
}

// ---------------------------------------------------------------------------
// Fórmulas personalizadas (Sheets)
// ---------------------------------------------------------------------------
function formula_(action, texto, formato, marca, pais, opciones) {
  texto = String(texto || '').trim();
  if (!texto) return '';
  var n = Math.max(1, Math.min(4, Number(opciones) || 1));
  var key = Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, [action, texto, formato, marca, pais, n].join('|'), Utilities.Charset.UTF_8));
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  var out;
  if (hit) {
    out = JSON.parse(hit);
  } else {
    var data = post_('/addon/copy', {
      action: action,
      text: texto,
      brand: marca || 'benandfrank',
      format: formato || 'general',
      country: pais || 'mx',
      user: usuario_(),
      surface: 'formula',
    });
    out = (data.options || []).map(function (o) { return o.text; });
    cache.put(key, JSON.stringify(out), 6 * 60 * 60); // 6 h: no se regenera en cada recálculo
  }
  if (!out.length) return '⚠️ sin opciones';
  return n === 1 ? out[0] : out.slice(0, n).map(function (t) { return [t]; });
}

/**
 * Crea copy con Topito (mismo motor que Slack y Figma).
 * @param {string} peticion Qué necesitas. Ej. "headline para lentes de sol, tono divertido".
 * @param {string} formato Opcional: general, headline, primario, caption, web, email, google_ads, hook, cta.
 * @param {string} marca Opcional: benandfrank o bombavista.
 * @param {string} pais Opcional: mx, co o cl.
 * @param {number} opciones Opcional: cuántas opciones (1 a 4, en columna).
 * @return El copy generado.
 * @customfunction
 */
function TOPITO(peticion, formato, marca, pais, opciones) {
  return formula_('crear', peticion, formato, marca, pais, opciones);
}

/**
 * Reescribe un texto con el tono de la marca.
 * @param {string} texto El texto a reescribir.
 * @param {string} formato Opcional: general, headline, primario, caption, web, email, google_ads, hook, cta.
 * @param {string} marca Opcional: benandfrank o bombavista.
 * @param {string} pais Opcional: mx, co o cl.
 * @param {number} opciones Opcional: cuántas opciones (1 a 4, en columna).
 * @return El texto reescrito.
 * @customfunction
 */
function TOPITO_REESCRIBIR(texto, formato, marca, pais, opciones) {
  return formula_('reescribir', texto, formato, marca, pais, opciones);
}

/**
 * Tropicaliza un copy mexicano para Colombia o Chile.
 * @param {string} texto El copy de México.
 * @param {string} pais co o cl.
 * @param {string} marca Opcional: benandfrank o bombavista.
 * @return La versión para ese país.
 * @customfunction
 */
function TOPITO_TROPICALIZAR(texto, pais, marca) {
  return formula_('tropicalizar', texto, 'general', marca, pais || 'co', 1);
}
