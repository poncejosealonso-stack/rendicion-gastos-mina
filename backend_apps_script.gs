// ==== BACKEND — Rendición de Gastos en Mina (PWA) ====
// v10: OCR Claude + Auditoría (F1) + Panel de tesorería (F2) + Ciudad distinta (F3)
const SSID = '1B0JhjDLTxUgi_YTSdoRRLxEKkW7sqVzV0sBDGQ7CXuM';
const CARPETA_FOTOS_NOMBRE = 'Rendicion Gastos Mina - Fotos (PWA)';
const ANTHROPIC_API_KEY = 'PEGA_AQUI_TU_CLAVE_sk-ant-...'; // <-- mantener tu clave real aquí
const PANEL_CLAVE = 'fysem2026'; // clave del panel de tesorería — cámbiala si quieres

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    if (data.accion === 'ocr') {
      return respuestaJson(leerReciboOCR(data.foto_base64));
    }

    const ss = SpreadsheetApp.openById(SSID);
    const hojaViajes = getOrCreateSheet(ss, 'PWA_Viajes', [
      'Timestamp', 'ID Rendición', 'Jefe de grupo', 'Orden de trabajo', 'Obra/Planta/Proyecto',
      'Ciudad/Destino', 'Centro de costo (ERP)', 'Fecha de salida', 'Fecha de retorno',
      'Participantes', 'N° participantes', 'Bolsa entregada (S/)'
    ]);
    const hojaGastos = getOrCreateSheet(ss, 'PWA_Gastos', [
      'Timestamp', 'ID Rendición', 'Jefe de grupo', 'Fecha del gasto', 'Concepto', 'Categoría',
      'Monto (S/)', 'Tipo de documento', 'Evidencia (foto)', 'Estado tesorería',
      'Observación tesorería', 'Subido al ERP', 'GPS (lat, lng)', 'Ver en mapa', 'Momento de captura (foto)',
      'Alertas de auditoría', 'RUC (OCR)', 'N° doc (OCR)', 'Comercio (OCR)', 'Hash foto', 'Ciudad (OCR)'
    ]);
    asegurarColumnasGPS(hojaGastos);
    asegurarColumnasAuditoria(hojaGastos);

    const rendicionId = Utilities.getUuid().slice(0, 8);
    const ahora = new Date();
    const bolsaTotal = Number(data.bolsa_total || 0);
    const numPart = Number(data.num_participantes || 0);

    hojaViajes.appendRow([
      ahora, rendicionId, data.jefe_grupo || '', data.orden_trabajo || '', data.obra_proyecto || '',
      data.destino || '', data.centro_costo || '', data.fecha_salida || '', data.fecha_retorno || '',
      data.participantes || '', numPart, bolsaTotal
    ]);

    // datos existentes para detectar duplicados (hash de foto y RUC+N° doc)
    const existentes = leerDatosAuditoriaExistentes(hojaGastos);

    const carpeta = getOrCreateCarpeta(CARPETA_FOTOS_NOMBRE);
    const gastos = data.gastos || [];
    gastos.forEach(function (g) {
      let urlFoto = '';
      let hashFoto = '';
      if (g.foto_base64) {
        const bytes = base64ABytes(g.foto_base64);
        hashFoto = md5Hex(bytes);
        urlFoto = guardarFotoEnDrive(carpeta, bytes, rendicionId, g.concepto);
      }
      const tieneGps = g.gps_lat && g.gps_lng;
      const gpsTexto = tieneGps ? `${g.gps_lat}, ${g.gps_lng}` : '';
      const gpsLink = tieneGps ? `https://www.google.com/maps?q=${g.gps_lat},${g.gps_lng}` : '';

      const alertas = evaluarAlertas(g, data, hashFoto, existentes);
      // registrar este gasto en "existentes" para detectar duplicados dentro de la misma rendición
      if (hashFoto) existentes.hashes[hashFoto] = true;
      const claveDoc = claveDocumento(g.ocr_ruc, g.ocr_num_documento);
      if (claveDoc) existentes.docs[claveDoc] = true;

      hojaGastos.appendRow([
        ahora, rendicionId, data.jefe_grupo || '', g.fecha_gasto || '', g.concepto || '',
        g.categoria || '', Number(g.monto || 0), g.tipo_documento || '', urlFoto,
        'Pendiente', '', 'No', gpsTexto, gpsLink, g.momento_captura || '',
        alertas.join(', '), g.ocr_ruc || '', g.ocr_num_documento || '', g.ocr_comercio || '', hashFoto, g.ocr_ciudad || ''
      ]);
      if (alertas.length) {
        const fila = hojaGastos.getLastRow();
        hojaGastos.getRange(fila, 16).setBackground('#fdecea').setFontColor('#b71c1c');
      }
    });

    aplicarValidaciones(hojaGastos);

    return respuestaJson({ ok: true, id: rendicionId, gastos_guardados: gastos.length });
  } catch (err) {
    return respuestaJson({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  if (e && e.parameter && e.parameter.vista === 'panel') {
    if (e.parameter.clave !== PANEL_CLAVE) {
      return HtmlService.createHtmlOutput('<h3 style="font-family:sans-serif">Clave incorrecta.</h3>');
    }
    return HtmlService.createHtmlOutput(htmlPanel())
      .setTitle('Panel de Tesorería — FYSEM RindeGastos')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return ContentService.createTextOutput('Backend Rendición de Gastos en Mina activo. v10-panel-ciudad');
}

// ==== AUDITORÍA (F1 + F3) ====
// Reglas que marcan, no bloquean: la tesorera decide.
function evaluarAlertas(g, viaje, hashFoto, existentes) {
  const alertas = [];
  const UN_DIA = 24 * 60 * 60 * 1000;

  // 1) FECHA_FUERA_DE_VIAJE: el gasto está fuera del rango salida–retorno (±1 día de tolerancia)
  const fGasto = parseFechaISO(g.fecha_gasto);
  const fSalida = parseFechaISO(viaje.fecha_salida);
  const fRetorno = parseFechaISO(viaje.fecha_retorno);
  if (fGasto && fSalida && fGasto.getTime() < fSalida.getTime() - UN_DIA) alertas.push('FECHA_FUERA_DE_VIAJE');
  else if (fGasto && fRetorno && fGasto.getTime() > fRetorno.getTime() + UN_DIA) alertas.push('FECHA_FUERA_DE_VIAJE');

  // 2) MONTO_NO_COINCIDE: lo digitado difiere >10% de lo que leyó el OCR en el comprobante
  const montoDigitado = Number(g.monto || 0);
  const montoOcr = Number(g.ocr_monto || 0);
  if (montoDigitado > 0 && montoOcr > 0) {
    const diff = Math.abs(montoDigitado - montoOcr) / montoOcr;
    if (diff > 0.10) alertas.push('MONTO_NO_COINCIDE (OCR: S/' + montoOcr.toFixed(2) + ')');
  }

  // 3) FECHA_NO_COINCIDE: la fecha digitada difiere de la que leyó el OCR en el comprobante
  const fOcr = parseFechaISO(g.ocr_fecha);
  if (fGasto && fOcr && Math.abs(fGasto.getTime() - fOcr.getTime()) > UN_DIA) {
    alertas.push('FECHA_NO_COINCIDE (OCR: ' + g.ocr_fecha + ')');
  }

  // 4) SIN_GPS: la foto se registró sin ubicación
  if (!(g.gps_lat && g.gps_lng)) alertas.push('SIN_GPS');

  // 5) REGISTRO_TARDIO: la foto se tomó/subió más de 2 días después de la fecha declarada del gasto
  const fCaptura = parseFechaISO((g.momento_captura || '').slice(0, 10));
  if (fGasto && fCaptura && fCaptura.getTime() - fGasto.getTime() > 2 * UN_DIA) alertas.push('REGISTRO_TARDIO');

  // 6) FOTO_DUPLICADA: la misma imagen ya fue usada en otro gasto (hash exacto)
  if (hashFoto && existentes.hashes[hashFoto]) alertas.push('FOTO_DUPLICADA');

  // 7) DOC_DUPLICADO: el mismo comprobante (RUC + serie-número del OCR) ya fue rendido antes
  const claveDoc = claveDocumento(g.ocr_ruc, g.ocr_num_documento);
  if (claveDoc && existentes.docs[claveDoc]) alertas.push('DOC_DUPLICADO');

  // 8) CIUDAD_DISTINTA (F3): la ciudad de emisión impresa en el comprobante no coincide con el destino del viaje
  const alertaCiudad = evaluarCiudad(g.ocr_ciudad, viaje.destino);
  if (alertaCiudad) alertas.push(alertaCiudad);

  return alertas;
}

// F3: compara la ciudad leída del comprobante contra el destino del viaje.
// Marca solo si AMBOS textos existen y no comparten ninguna palabra significativa (≥4 letras).
// Ojo: cadenas grandes a veces imprimen la dirección de su sede central (Lima) y no la de la sucursal —
// por eso esta alerta es orientativa y la tesorera decide.
function evaluarCiudad(ciudadOcr, destinoViaje) {
  const ciudad = normalizarTexto(ciudadOcr);
  const destino = normalizarTexto(destinoViaje);
  if (!ciudad || !destino) return '';
  const palabrasCiudad = ciudad.split(/[^a-z]+/).filter(function (p) { return p.length >= 4; });
  const palabrasDestino = destino.split(/[^a-z]+/).filter(function (p) { return p.length >= 4; });
  if (!palabrasCiudad.length || !palabrasDestino.length) return '';
  const hayCoincidencia = palabrasCiudad.some(function (pc) {
    return palabrasDestino.some(function (pd) { return pc.indexOf(pd) !== -1 || pd.indexOf(pc) !== -1; });
  });
  if (hayCoincidencia) return '';
  return 'CIUDAD_DISTINTA (comprobante: ' + String(ciudadOcr).trim() + ')';
}

function normalizarTexto(s) {
  return String(s || '').toLowerCase()
    .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i').replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ñ/g, 'n')
    .trim();
}

function leerDatosAuditoriaExistentes(hoja) {
  const existentes = { hashes: {}, docs: {} };
  const ultimaFila = hoja.getLastRow();
  if (ultimaFila < 2) return existentes;
  const valores = hoja.getRange(2, 17, ultimaFila - 1, 4).getValues(); // cols 17-20: RUC, N° doc, Comercio, Hash
  valores.forEach(function (fila) {
    const clave = claveDocumento(fila[0], fila[1]);
    if (clave) existentes.docs[clave] = true;
    if (fila[3]) existentes.hashes[String(fila[3])] = true;
  });
  return existentes;
}

function claveDocumento(ruc, numDoc) {
  const r = String(ruc || '').trim();
  const n = String(numDoc || '').trim();
  if (!r || !n) return '';
  return r + '|' + n;
}

function parseFechaISO(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}/.test(String(s))) return null;
  const partes = String(s).slice(0, 10).split('-');
  return new Date(Number(partes[0]), Number(partes[1]) - 1, Number(partes[2]));
}

function md5Hex(bytes) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes);
  return digest.map(function (b) {
    const v = (b + 256) % 256;
    return (v < 16 ? '0' : '') + v.toString(16);
  }).join('');
}

function base64ABytes(base64) {
  const contenido = base64.split(',')[1] || base64;
  return Utilities.base64Decode(contenido);
}

function asegurarColumnasGPS(hoja) {
  const headers = ['GPS (lat, lng)', 'Ver en mapa', 'Momento de captura (foto)'];
  const primeraCelda = hoja.getRange(1, 13).getValue();
  if (!primeraCelda) {
    hoja.getRange(1, 13, 1, 3).setValues([headers]);
    hoja.getRange(1, 13, 1, 3).setFontWeight('bold');
  }
}

function asegurarColumnasAuditoria(hoja) {
  const headers = ['Alertas de auditoría', 'RUC (OCR)', 'N° doc (OCR)', 'Comercio (OCR)', 'Hash foto', 'Ciudad (OCR)'];
  const primeraCelda = hoja.getRange(1, 16).getValue();
  if (!primeraCelda) {
    hoja.getRange(1, 16, 1, headers.length).setValues([headers]);
    hoja.getRange(1, 16, 1, headers.length).setFontWeight('bold');
  }
  // v10: agrega "Ciudad (OCR)" (col 21) si la hoja viene de v9
  if (!hoja.getRange(1, 21).getValue()) {
    hoja.getRange(1, 21).setValue('Ciudad (OCR)').setFontWeight('bold');
  }
}

function getOrCreateSheet(ss, nombre, headers) {
  let sheet = ss.getSheetByName(nombre);
  if (!sheet) {
    sheet = ss.insertSheet(nombre);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

function getOrCreateCarpeta(nombre) {
  const it = DriveApp.getFoldersByName(nombre);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(nombre);
}

function guardarFotoEnDrive(carpeta, bytes, rendicionId, concepto) {
  const blob = Utilities.newBlob(bytes, 'image/jpeg', rendicionId + '_' + (concepto || 'gasto').replace(/[^a-zA-Z0-9]/g, '_') + '.jpg');
  const archivo = carpeta.createFile(blob);
  archivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return archivo.getUrl();
}

function aplicarValidaciones(hojaGastos) {
  const numFilas = 500;
  const reglaEstado = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Pendiente', 'Aprobado', 'Rechazado', 'Observado'], true).build();
  const reglaErp = SpreadsheetApp.newDataValidation()
    .requireValueInList(['No', 'Sí'], true).build();
  hojaGastos.getRange(2, 10, numFilas, 1).setDataValidation(reglaEstado);
  hojaGastos.getRange(2, 12, numFilas, 1).setDataValidation(reglaErp);
}

function respuestaJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ==== PANEL DE TESORERÍA (F2) ====

// Datos para el panel: viajes + gastos (sin fotos en base64, solo URLs)
function obtenerDatosPanel(clave) {
  if (clave !== PANEL_CLAVE) throw new Error('Clave incorrecta');
  const ss = SpreadsheetApp.openById(SSID);
  const tz = Session.getScriptTimeZone();

  function fmt(v) {
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    return String(v === null || v === undefined ? '' : v);
  }

  const hojaViajes = ss.getSheetByName('PWA_Viajes');
  const hojaGastos = ss.getSheetByName('PWA_Gastos');
  const viajes = [];
  const gastos = [];

  if (hojaViajes && hojaViajes.getLastRow() > 1) {
    const filas = hojaViajes.getRange(2, 1, hojaViajes.getLastRow() - 1, 12).getValues();
    filas.forEach(function (f) {
      viajes.push({
        id: fmt(f[1]), jefe: fmt(f[2]), orden: fmt(f[3]), obra: fmt(f[4]), destino: fmt(f[5]),
        salida: fmt(f[7]), retorno: fmt(f[8]), participantes: fmt(f[9]), bolsa: Number(f[11] || 0),
        recibido: fmt(f[0])
      });
    });
  }
  if (hojaGastos && hojaGastos.getLastRow() > 1) {
    const filas = hojaGastos.getRange(2, 1, hojaGastos.getLastRow() - 1, 21).getValues();
    filas.forEach(function (f, i) {
      gastos.push({
        fila: i + 2, rendicion: fmt(f[1]), fecha: fmt(f[3]), concepto: fmt(f[4]), categoria: fmt(f[5]),
        monto: Number(f[6] || 0), tipoDoc: fmt(f[7]), foto: fmt(f[8]), estado: fmt(f[9]) || 'Pendiente',
        observacion: fmt(f[10]), erp: fmt(f[11]), mapa: fmt(f[13]), alertas: fmt(f[15]),
        ruc: fmt(f[16]), numDoc: fmt(f[17]), comercio: fmt(f[18]), ciudad: fmt(f[20])
      });
    });
  }
  return { viajes: viajes, gastos: gastos };
}

// Escribe Estado y Observación de tesorería en una fila de PWA_Gastos
function actualizarEstado(clave, fila, estado, observacion) {
  if (clave !== PANEL_CLAVE) throw new Error('Clave incorrecta');
  const permitidos = ['Pendiente', 'Aprobado', 'Rechazado', 'Observado'];
  if (permitidos.indexOf(estado) === -1) throw new Error('Estado inválido');
  const hoja = SpreadsheetApp.openById(SSID).getSheetByName('PWA_Gastos');
  const numFila = Number(fila);
  if (!numFila || numFila < 2 || numFila > hoja.getLastRow()) throw new Error('Fila inválida');
  hoja.getRange(numFila, 10).setValue(estado);
  hoja.getRange(numFila, 11).setValue(String(observacion || ''));
  return { ok: true };
}

function htmlPanel() {
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'body{font-family:system-ui,-apple-system,sans-serif;background:#f4f6f8;color:#212121;padding:16px}' +
'h1{font-size:20px;color:#1565c0;margin-bottom:2px}' +
'.sub{color:#757575;font-size:13px;margin-bottom:16px}' +
'.barra{display:flex;flex-wrap:wrap;gap:10px;align-items:center;background:#fff;border-radius:12px;padding:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:14px}' +
'select,input[type=text]{padding:8px 10px;border:1px solid #cfd8dc;border-radius:8px;font-size:14px}' +
'label.chk{font-size:14px;display:flex;align-items:center;gap:6px;cursor:pointer}' +
'.resumen{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px}' +
'.tarjeta{background:#fff;border-radius:12px;padding:12px 16px;box-shadow:0 1px 3px rgba(0,0,0,.08);min-width:130px}' +
'.tarjeta .et{font-size:12px;color:#757575}.tarjeta .val{font-size:20px;font-weight:700}' +
'.semaforo{display:inline-block;width:14px;height:14px;border-radius:50%;margin-right:6px;vertical-align:middle}' +
'.sem-verde{background:#2e7d32}.sem-ambar{background:#f9a825}.sem-rojo{background:#c62828}' +
'.gasto{background:#fff;border-radius:12px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:10px;border-left:5px solid #2e7d32}' +
'.gasto.con-alerta{border-left-color:#f9a825}.gasto.grave{border-left-color:#c62828}' +
'.g-head{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:6px}' +
'.g-head strong{font-size:15px}.g-monto{font-size:17px;font-weight:700;color:#1565c0}' +
'.g-meta{font-size:13px;color:#616161;margin-bottom:6px}' +
'.chip{display:inline-block;background:#fdecea;color:#b71c1c;border-radius:12px;padding:2px 10px;font-size:12px;font-weight:600;margin:2px 4px 2px 0}' +
'.g-links a{font-size:13px;color:#1565c0;margin-right:14px;text-decoration:none}' +
'.g-acciones{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center}' +
'.g-acciones input[type=text]{flex:1;min-width:160px}' +
'button.guardar{background:#2e7d32;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer}' +
'button.guardar:disabled{background:#9e9e9e}' +
'.estado-pill{font-size:12px;font-weight:700;border-radius:12px;padding:2px 10px}' +
'.est-Pendiente{background:#eceff1;color:#455a64}.est-Aprobado{background:#e8f5e9;color:#1b5e20}' +
'.est-Observado{background:#fff8e1;color:#f57f17}.est-Rechazado{background:#fdecea;color:#b71c1c}' +
'.vacio{color:#757575;text-align:center;padding:30px}' +
'.aviso{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#323232;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;opacity:0;transition:opacity .3s}' +
'.aviso.ver{opacity:1}' +
'</style></head><body>' +
'<h1>Panel de Tesorería</h1><div class="sub">FYSEM RindeGastos — revisión de rendiciones</div>' +
'<div class="barra">' +
'<select id="sel-rendicion"></select>' +
'<select id="sel-estado"><option value="">Todos los estados</option><option>Pendiente</option><option>Aprobado</option><option>Observado</option><option>Rechazado</option></select>' +
'<label class="chk"><input type="checkbox" id="chk-alertas"> Solo con alertas</label>' +
'<span id="cargando" style="font-size:13px;color:#757575">Cargando…</span>' +
'</div>' +
'<div class="resumen" id="resumen"></div>' +
'<div id="lista"></div>' +
'<div class="aviso" id="aviso"></div>' +
'<script>' +
'var CLAVE = new URLSearchParams(location.search).get("clave") || "";' +
'var DATOS = {viajes:[],gastos:[]};' +
'function aviso(t){var a=document.getElementById("aviso");a.textContent=t;a.classList.add("ver");setTimeout(function(){a.classList.remove("ver")},2500)}' +
'function esGrave(al){return al.indexOf("FOTO_DUPLICADA")!==-1||al.indexOf("DOC_DUPLICADO")!==-1}' +
'function semaforoViaje(id){var gs=DATOS.gastos.filter(function(g){return g.rendicion===id});' +
' if(gs.some(function(g){return esGrave(g.alertas)}))return "rojo";' +
' if(gs.some(function(g){return g.alertas}))return "ambar";return "verde"}' +
'function cargar(){google.script.run.withSuccessHandler(function(d){DATOS=d;document.getElementById("cargando").textContent="";llenarSelector();render()})' +
'.withFailureHandler(function(e){document.getElementById("cargando").textContent="Error: "+e.message})' +
'.obtenerDatosPanel(CLAVE)}' +
'function llenarSelector(){var sel=document.getElementById("sel-rendicion");var visto={};var ops="";' +
' for(var i=DATOS.viajes.length-1;i>=0;i--){var v=DATOS.viajes[i];if(visto[v.id])continue;visto[v.id]=1;' +
'  var sem=semaforoViaje(v.id);var icono=sem==="rojo"?"\\uD83D\\uDD34 ":sem==="ambar"?"\\uD83D\\uDFE1 ":"\\uD83D\\uDFE2 ";' +
'  ops+="<option value=\\""+v.id+"\\">"+icono+v.jefe+" · "+v.destino+" · "+v.salida+" ("+v.id+")</option>"}' +
' sel.innerHTML=ops||"<option value=\\"\\">Sin rendiciones</option>"}' +
'function render(){var id=document.getElementById("sel-rendicion").value;' +
' var v=DATOS.viajes.filter(function(x){return x.id===id})[0];' +
' var gs=DATOS.gastos.filter(function(g){return g.rendicion===id});' +
' var fEstado=document.getElementById("sel-estado").value;' +
' var soloAl=document.getElementById("chk-alertas").checked;' +
' var gastado=gs.reduce(function(s,g){return s+g.monto},0);' +
' var aprobado=gs.filter(function(g){return g.estado==="Aprobado"}).reduce(function(s,g){return s+g.monto},0);' +
' var numAlertas=gs.filter(function(g){return g.alertas}).length;' +
' var pend=gs.filter(function(g){return g.estado==="Pendiente"}).length;' +
' var sem=semaforoViaje(id);' +
' var r=document.getElementById("resumen");' +
' if(v){var saldo=v.bolsa-gastado;' +
'  r.innerHTML="<div class=tarjeta><div class=et>Rendición</div><div class=val><span class=\\"semaforo sem-"+sem+"\\"></span>"+v.id+"</div><div class=et>"+v.jefe+" · "+v.destino+"</div><div class=et>"+v.salida+" – "+v.retorno+"</div></div>"' +
'  +"<div class=tarjeta><div class=et>Bolsa entregada</div><div class=val>S/ "+v.bolsa.toFixed(2)+"</div></div>"' +
'  +"<div class=tarjeta><div class=et>Gastado ("+gs.length+" gastos)</div><div class=val>S/ "+gastado.toFixed(2)+"</div><div class=et>Aprobado: S/ "+aprobado.toFixed(2)+"</div></div>"' +
'  +"<div class=tarjeta><div class=et>"+(saldo>=0?"Saldo a devolver":"Reembolso al trabajador")+"</div><div class=val style=color:"+(saldo>=0?"#1b5e20":"#b71c1c")+">S/ "+Math.abs(saldo).toFixed(2)+"</div></div>"' +
'  +"<div class=tarjeta><div class=et>Por revisar</div><div class=val>"+pend+"</div><div class=et>"+numAlertas+" con alerta</div></div>"}' +
' else{r.innerHTML=""}' +
' var filtrados=gs.filter(function(g){if(fEstado&&g.estado!==fEstado)return false;if(soloAl&&!g.alertas)return false;return true});' +
' filtrados.sort(function(a,b){return (b.alertas?1:0)-(a.alertas?1:0)});' +
' var html="";' +
' filtrados.forEach(function(g){' +
'  var clase=g.alertas?(esGrave(g.alertas)?"gasto grave":"gasto con-alerta"):"gasto";' +
'  var chips=g.alertas?g.alertas.split(", ").map(function(a){return "<span class=chip>"+a+"</span>"}).join(""):"";' +
'  var extra=[];if(g.comercio)extra.push(g.comercio);if(g.ruc)extra.push("RUC "+g.ruc);if(g.numDoc)extra.push(g.numDoc);if(g.ciudad)extra.push(g.ciudad);' +
'  html+="<div class=\\""+clase+"\\" id=\\"g-"+g.fila+"\\">"' +
'  +"<div class=g-head><strong>"+g.concepto+"</strong><span class=g-monto>S/ "+g.monto.toFixed(2)+"</span></div>"' +
'  +"<div class=g-meta>"+g.fecha+" · "+g.categoria+" · "+g.tipoDoc.toUpperCase()+(extra.length?" · "+extra.join(" · "):"")+"</div>"' +
'  +(chips?"<div>"+chips+"</div>":"")' +
'  +"<div class=g-links>"+(g.foto?"<a href=\\""+g.foto+"\\" target=_blank>\\uD83D\\uDCF7 Ver foto</a>":"")+(g.mapa?"<a href=\\""+g.mapa+"\\" target=_blank>\\uD83D\\uDCCD Ver mapa</a>":"")+"</div>"' +
'  +"<div class=g-acciones><span class=\\"estado-pill est-"+g.estado+"\\">"+g.estado+"</span>"' +
'  +"<select id=\\"e-"+g.fila+"\\"><option"+(g.estado==="Pendiente"?" selected":"")+">Pendiente</option><option"+(g.estado==="Aprobado"?" selected":"")+">Aprobado</option><option"+(g.estado==="Observado"?" selected":"")+">Observado</option><option"+(g.estado==="Rechazado"?" selected":"")+">Rechazado</option></select>"' +
'  +"<input type=text id=\\"o-"+g.fila+"\\" placeholder=\\"Observación (opcional)\\" value=\\""+g.observacion.replace(/"/g,"&quot;")+"\\">"' +
'  +"<button class=guardar onclick=\\"guardar("+g.fila+")\\">Guardar</button></div></div>"});' +
' document.getElementById("lista").innerHTML=html||"<div class=vacio>No hay gastos con este filtro.</div>"}' +
'function guardar(fila){var est=document.getElementById("e-"+fila).value;var obs=document.getElementById("o-"+fila).value;' +
' var btn=document.querySelector("#g-"+fila+" button");btn.disabled=true;btn.textContent="…";' +
' google.script.run.withSuccessHandler(function(){' +
'  DATOS.gastos.forEach(function(g){if(g.fila===fila){g.estado=est;g.observacion=obs}});' +
'  aviso("Guardado \\u2713");render()})' +
' .withFailureHandler(function(e){btn.disabled=false;btn.textContent="Guardar";aviso("Error: "+e.message)})' +
' .actualizarEstado(CLAVE,fila,est,obs)}' +
'document.getElementById("sel-rendicion").addEventListener("change",render);' +
'document.getElementById("sel-estado").addEventListener("change",render);' +
'document.getElementById("chk-alertas").addEventListener("change",render);' +
'cargar();' +
'</script></body></html>';
}

// ---- OCR con Claude (Anthropic API) ----
function leerReciboOCR(fotoBase64) {
  try {
    if (!fotoBase64) return { ok: false, error: 'Sin foto' };
    const contenido = fotoBase64.split(',')[1] || fotoBase64;

    const body = {
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: contenido } },
          { type: 'text', text: 'Extrae los datos de este comprobante de pago peruano (boleta, factura, ticket, o captura de Yape/Plin). El monto es el IMPORTE TOTAL realmente pagado (no subtotales, no IGV aislado, no vuelto). La fecha es la de emisión del comprobante. La ciudad es el distrito/ciudad de la dirección del emisor impresa en el comprobante (ej. "San Isidro - Lima"). Si un campo no se ve o no existe, usa cadena vacía.' }
        ]
      }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              fecha: { type: 'string', description: 'Fecha de emisión en formato YYYY-MM-DD, o cadena vacía' },
              monto_total: { type: 'string', description: 'Importe total pagado, solo números con punto decimal, ej. 78.70' },
              ruc: { type: 'string', description: 'RUC del emisor (11 dígitos), o cadena vacía' },
              serie_numero: { type: 'string', description: 'Serie y número del comprobante, o número de operación en Yape/Plin' },
              comercio: { type: 'string', description: 'Nombre del comercio o destinatario del pago' },
              ciudad: { type: 'string', description: 'Distrito y/o ciudad de la dirección del emisor impresa en el comprobante, ej. "San Isidro - Lima", o cadena vacía' },
              tipo_detectado: { type: 'string', description: 'Uno de: boleta, factura, ticket, yape_plin, otro' }
            },
            required: ['fecha', 'monto_total', 'ruc', 'serie_numero', 'comercio', 'ciudad', 'tipo_detectado'],
            additionalProperties: false
          }
        }
      }
    };

    const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });

    const codigo = resp.getResponseCode();
    const json = JSON.parse(resp.getContentText());
    if (codigo !== 200) {
      return { ok: false, error: 'Claude API ' + codigo + ': ' + JSON.stringify(json.error || json).slice(0, 200) };
    }
    if (json.stop_reason === 'refusal') {
      return { ok: true, sugerencias: {} };
    }

    const texto = (json.content && json.content[0] && json.content[0].text) ? json.content[0].text : '';
    if (!texto) return { ok: true, sugerencias: {} };

    const datos = JSON.parse(texto);
    const sugerencias = {};
    if (datos.fecha) sugerencias.fecha_gasto = datos.fecha;
    if (datos.monto_total) sugerencias.monto = datos.monto_total;
    if (datos.ruc) sugerencias.ruc = datos.ruc;
    if (datos.serie_numero) sugerencias.num_documento = datos.serie_numero;
    if (datos.comercio) sugerencias.comercio = datos.comercio;
    if (datos.ciudad) sugerencias.ciudad = datos.ciudad;
    if (datos.tipo_detectado) sugerencias.tipo_detectado = datos.tipo_detectado;

    return { ok: true, sugerencias: sugerencias };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
