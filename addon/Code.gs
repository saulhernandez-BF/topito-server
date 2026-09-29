/**
 * Topito para Google Docs, Sheets y Slides (complemento de editor, dominio B&F).
 *
 * Qué hace:
 *   • Menú Extensiones → Topito: abrir la barra lateral, reescribir / revisar
 *     ortografía / tropicalizar la selección.
 *   • Barra lateral: Crear, Reescribir, Ortografía y Tropicalizar con marca,
 *     país (MX/CO/CL) y formato; Reemplazar selección o Insertar; 👍 ⚪ 👎 con motivo.
 *   • Slides: revisar la ortografía de toda la presentación (con revisión antes de aplicar).
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
  var menu = getUi_()
    .createAddonMenu()
    .addItem('✍️ Abrir Topito', 'abrirTopito')
    .addSeparator()
    .addItem('🔁 Reescribir selección', 'menuReescribir')
    .addItem('🔤 Revisar ortografía de la selección', 'menuOrtografia')
    .addItem('🌎 Tropicalizar selección (CO / CL)', 'menuTropicalizar');
  if (host_() === 'slides') {
    menu.addSeparator().addItem('📑 Revisar ortografía de toda la presentación', 'menuOrtografiaDeck');
  }
  menu.addToUi();
}

function abrirTopito() { abrirSidebar_(null); }
function menuReescribir() { abrirSidebar_('reescribir'); }
function menuOrtografia() { abrirSidebar_('ortografia'); }
function menuTropicalizar() { abrirSidebar_('tropicalizar'); }
function menuOrtografiaDeck() { abrirSidebar_('deck'); }

function abrirSidebar_(accion) {
  var t = HtmlService.createTemplateFromFile('Sidebar');
  t.initial = JSON.stringify({ action: accion, host: host_() });
  getUi_().showSidebar(t.evaluate().setTitle('Topito'));
}

// ---------------------------------------------------------------------------
// Host (Docs, Sheets o Slides)
// ---------------------------------------------------------------------------
// OJO: en onOpen/onInstall (AuthMode.NONE, antes de autorizar en ese archivo)
// DocumentApp.getActiveDocument() truena aunque estemos en Docs, así que el
// host se detecta con getUi(), que sí funciona sin autorización y truena
// ("Cannot call DocumentApp.getUi() from this context") si estamos en Sheets.
function host_() {
  try { DocumentApp.getUi(); return 'docs'; } catch (e) {}
  try { SlidesApp.getUi(); return 'slides'; } catch (e) {}
  return 'sheets';
}

function getUi_() {
  try { return DocumentApp.getUi(); } catch (e) {}
  try { return SlidesApp.getUi(); } catch (e) {}
  return SpreadsheetApp.getUi();
}

// ---------------------------------------------------------------------------
// Selección
// ---------------------------------------------------------------------------
/** Texto seleccionado (Docs: selección; Sheets: celdas; Slides: texto o cuadros). */
function leerSeleccion() {
  if (host_() === 'slides') return slidesLeerSeleccion_();
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
  if (host_() === 'slides') return slidesReemplazar_(texto);
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
  if (host_() === 'slides') return slidesInsertar_(texto);
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


// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------
// Shapes (cuadros de texto) seleccionados, incluyendo los que están dentro de grupos.
function slidesShapesDe_(elements) {
  var out = [];
  (elements || []).forEach(function (el) {
    var t = el.getPageElementType();
    if (t === SlidesApp.PageElementType.SHAPE) out.push(el.asShape());
    else if (t === SlidesApp.PageElementType.GROUP) out = out.concat(slidesShapesDe_(el.asGroup().getChildren()));
  });
  return out.filter(function (sh) { try { return !!sh.getText(); } catch (e) { return false; } });
}

function slidesLeerSeleccion_() {
  var sel = SlidesApp.getActivePresentation().getSelection();
  if (!sel) return '';
  var tipo = sel.getSelectionType();
  if (tipo === SlidesApp.SelectionType.TEXT) {
    var tr = sel.getTextRange();
    return tr ? tr.asString().replace(/\n$/, '') : '';
  }
  if (tipo === SlidesApp.SelectionType.PAGE_ELEMENT) {
    return slidesShapesDe_(sel.getPageElementRange().getPageElements())
      .map(function (sh) { return sh.getText().asString().replace(/\n$/, ''); })
      .filter(function (t) { return t.trim(); }).join('\n');
  }
  if (tipo === SlidesApp.SelectionType.TABLE_CELL) {
    return sel.getTableCellRange().getTableCells()
      .map(function (c) { return c.getText().asString().replace(/\n$/, ''); })
      .filter(function (t) { return t.trim(); }).join('\n');
  }
  return '';
}

function slidesReemplazar_(texto) {
  var sel = SlidesApp.getActivePresentation().getSelection();
  var tipo = sel ? sel.getSelectionType() : null;
  if (tipo === SlidesApp.SelectionType.TEXT && sel.getTextRange()) {
    sel.getTextRange().setText(texto);
    return 'ok';
  }
  if (tipo === SlidesApp.SelectionType.PAGE_ELEMENT) {
    var shapes = slidesShapesDe_(sel.getPageElementRange().getPageElements());
    if (shapes.length) { shapes[0].getText().setText(texto); return 'ok'; }
  }
  if (tipo === SlidesApp.SelectionType.TABLE_CELL) {
    var cells = sel.getTableCellRange().getTableCells();
    if (cells.length) { cells[0].getText().setText(texto); return 'ok'; }
  }
  return slidesInsertar_(texto);
}

/** Inserta en el cursor si hay uno; si no, crea un cuadro de texto en la diapositiva actual. */
function slidesInsertar_(texto) {
  var pres = SlidesApp.getActivePresentation();
  var sel = pres.getSelection();
  if (sel && sel.getSelectionType() === SlidesApp.SelectionType.TEXT) {
    var tr = sel.getTextRange();
    if (tr && tr.isEmpty()) { tr.setText(texto); return 'ok'; }
  }
  var page = sel && sel.getCurrentPage();
  if (!page) page = pres.getSlides()[0];
  if (!page) throw new Error('La presentación no tiene diapositivas.');
  page.insertTextBox(texto, 40, 40, 420, 120);
  return 'ok-cuadro';
}

var MAX_TEXTOS_DECK = 80;

// Todos los textos de la presentación: cuadros, formas, grupos y celdas de tablas.
function slidesTextosDeck_() {
  var out = [];
  SlidesApp.getActivePresentation().getSlides().forEach(function (slide, i) {
    function visitar(el) {
      var t = el.getPageElementType();
      if (t === SlidesApp.PageElementType.GROUP) return el.asGroup().getChildren().forEach(visitar);
      if (t === SlidesApp.PageElementType.SHAPE) {
        var txt;
        try { txt = el.asShape().getText().asString().replace(/\n$/, ''); } catch (e) { return; }
        if (txt.trim()) out.push({ id: slide.getObjectId() + '|' + el.getObjectId(), slide: i + 1, text: txt });
      } else if (t === SlidesApp.PageElementType.TABLE) {
        var tb = el.asTable();
        for (var r = 0; r < tb.getNumRows(); r++) {
          for (var c = 0; c < tb.getNumColumns(); c++) {
            var cell;
            try { cell = tb.getCell(r, c); } catch (e) { continue; } // celdas combinadas
            var ct = cell.getText().asString().replace(/\n$/, '');
            if (ct.trim()) out.push({ id: slide.getObjectId() + '|' + el.getObjectId() + '|' + r + '|' + c, slide: i + 1, text: ct });
          }
        }
      }
    }
    slide.getPageElements().forEach(visitar);
  });
  return out;
}

function mismoTexto_(a, b) {
  var n = function (t) { return String(t || '').normalize('NFC').replace(/[\s ​]+/g, ' ').trim(); };
  return n(a) === n(b);
}

/**
 * Revisa la ortografía de toda la presentación. No cambia nada: devuelve la
 * lista de correcciones para que la persona las revise en la barra lateral.
 */
function revisarPresentacion(req) {
  if (host_() !== 'slides') throw new Error('Solo en Google Slides.');
  var textos = slidesTextosDeck_();
  var cambios = [];
  var revisados = 0;
  var started = Date.now();
  for (var k = 0; k < textos.length; k++) {
    if (revisados >= MAX_TEXTOS_DECK || Date.now() - started > 5 * 60 * 1000) {
      return { cambios: cambios, revisados: revisados, total: textos.length, pendientes: true };
    }
    var t = textos[k];
    try {
      var data = pedirCopy({ action: 'ortografia', text: t.text, brand: req.brand });
      var corr = data.options && data.options[0] ? data.options[0].text : '';
      if (corr && !mismoTexto_(corr, t.text)) cambios.push({ id: t.id, slide: t.slide, original: t.text, corrected: corr });
    } catch (err) {
      cambios.push({ id: t.id, slide: t.slide, original: t.text, error: String(err.message || err).slice(0, 120) });
    }
    revisados++;
  }
  return { cambios: cambios, revisados: revisados, total: textos.length, pendientes: false };
}

/** Aplica las correcciones aceptadas. items: [{id, original, corrected}] */
function aplicarCorreccionesDeck(items) {
  var pres = SlidesApp.getActivePresentation();
  var hechas = 0;
  (items || []).forEach(function (it) {
    var parts = String(it.id).split('|');
    var slide = pres.getSlideById(parts[0]);
    if (!slide) return;
    var el = slide.getPageElementById(parts[1]);
    if (!el) return;
    var tr;
    if (parts.length === 4) tr = el.asTable().getCell(Number(parts[2]), Number(parts[3])).getText();
    else tr = el.asShape().getText();
    // replaceAllText conserva mejor el formato que setText; si el texto cambió
    // desde la revisión y ya no coincide, no se toca.
    var n = tr.replaceAllText(it.original, it.corrected, true);
    if (n === 0 && mismoTexto_(tr.asString(), it.original)) { tr.setText(it.corrected); n = 1; } // textos de varios párrafos
    if (n > 0) hechas++;
  });
  return { hechas: hechas };
}
