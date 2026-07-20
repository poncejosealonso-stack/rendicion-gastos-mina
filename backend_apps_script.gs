// ==== BACKEND — Rendición de Gastos en Mina (PWA) ====
// Pegar en script.new, revisar SSID abajo, e Implementar como Aplicación web
// (Ejecutar como: Yo · Quién tiene acceso: Cualquier usuario)

const SSID = '1B0JhjDLTxUgi_YTSdoRRLxEKkW7sqVzV0sBDGQ7CXuM'; // misma hoja "Rendición de Gastos en Mina (Respuestas)"
const CARPETA_FOTOS_NOMBRE = 'Rendicion Gastos Mina - Fotos (PWA)';
const VISION_API_KEY = 'AIzaSyBLEpdfu_vyII9hyo2ZBR_KscuZVT3GXKc';

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
      'Observación tesorería', 'Subido al ERP', 'GPS (lat, lng)', 'Ver en mapa', 'Momento de captura (foto)'
    ]);
    asegurarColumnasGPS(hojaGastos);

    const rendicionId = Utilities.getUuid().slice(0, 8);
    const ahora = new Date();
    const bolsaTotal = Number(data.bolsa_total || 0);
    const numPart = Number(data.num_participantes || 0);

    hojaViajes.appendRow([
      ahora, rendicionId, data.jefe_grupo || '', data.orden_trabajo || '', data.obra_proyecto || '',
      data.destino || '', data.centro_costo || '', data.fecha_salida || '', data.fecha_retorno || '',
      data.participantes || '', numPart, bolsaTotal
    ]);

    const carpeta = getOrCreateCarpeta(CARPETA_FOTOS_NOMBRE);
    const gastos = data.gastos || [];
    gastos.forEach(function (g) {
      let urlFoto = '';
      if (g.foto_base64) {
        urlFoto = guardarFotoEnDrive(carpeta, g.foto_base64, rendicionId, g.concepto);
      }
      const tieneGps = g.gps_lat && g.gps_lng;
      const gpsTexto = tieneGps ? `${g.gps_lat}, ${g.gps_lng}` : '';
      const gpsLink = tieneGps ? `https://www.google.com/maps?q=${g.gps_lat},${g.gps_lng}` : '';
      hojaGastos.appendRow([
        ahora, rendicionId, data.jefe_grupo || '', g.fecha_gasto || '', g.concepto || '',
        g.categoria || '', Number(g.monto || 0), g.tipo_documento || '', urlFoto,
        'Pendiente', '', 'No', gpsTexto, gpsLink, g.momento_captura || ''
      ]);
    });

    // agregar validación de datos (desplegables) en las columnas de tesorería, si no existen aún
    aplicarValidaciones(hojaGastos);

    return respuestaJson({ ok: true, id: rendicionId, gastos_guardados: gastos.length });
  } catch (err) {
    return respuestaJson({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  return ContentService.createTextOutput('Backend Rendición de Gastos en Mina activo.');
}

function asegurarColumnasGPS(hoja) {
  const headers = ['GPS (lat, lng)', 'Ver en mapa', 'Momento de captura (foto)'];
  const primeraCelda = hoja.getRange(1, 13).getValue();
  if (!primeraCelda) {
    hoja.getRange(1, 13, 1, 3).setValues([headers]);
    hoja.getRange(1, 13, 1, 3).setFontWeight('bold');
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

function guardarFotoEnDrive(carpeta, base64, rendicionId, concepto) {
  const partes = base64.split(',');
  const meta = partes[0]; // data:image/jpeg;base64
  const contenido = partes[1] || partes[0];
  const bytes = Utilities.base64Decode(contenido);
  const blob = Utilities.newBlob(bytes, 'image/jpeg', rendicionId + '_' + (concepto || 'gasto').replace(/[^a-zA-Z0-9]/g, '_') + '.jpg');
  const archivo = carpeta.createFile(blob);
  archivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return archivo.getUrl();
}

function aplicarValidaciones(hojaGastos) {
  const numFilas = 500;
  const colEstado = 10; // J: Estado tesorería
  const colErp = 12;    // L: Subido al ERP
  const reglaEstado = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Pendiente', 'Aprobado', 'Rechazado', 'Observado'], true).build();
  const reglaErp = SpreadsheetApp.newDataValidation()
    .requireValueInList(['No', 'Sí'], true).build();
  hojaGastos.getRange(2, colEstado, numFilas, 1).setDataValidation(reglaEstado);
  hojaGastos.getRange(2, colErp, numFilas, 1).setDataValidation(reglaErp);
}

function respuestaJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---- OCR con Google Cloud Vision ----
function leerReciboOCR(fotoBase64) {
  try {
    if (!fotoBase64) return { ok: false, error: 'Sin foto' };
    const contenido = fotoBase64.split(',')[1] || fotoBase64;

    const body = {
      requests: [{
        image: { content: contenido },
        features: [{ type: 'TEXT_DETECTION' }]
      }]
    };
    const resp = UrlFetchApp.fetch(
      'https://vision.googleapis.com/v1/images:annotate?key=' + VISION_API_KEY,
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      }
    );
    const json = JSON.parse(resp.getContentText());
    const texto = (json.responses && json.responses[0] && json.responses[0].fullTextAnnotation)
      ? json.responses[0].fullTextAnnotation.text : '';

    if (!texto) return { ok: true, texto: '', sugerencias: {} };

    return { ok: true, texto: texto, sugerencias: extraerCamposDeTexto(texto) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function extraerCamposDeTexto(texto) {
  const sugerencias = {};
  const lineas = texto.split('\n').map(function (l) { return l.trim(); });

  // ---- Fecha: dd/mm/yyyy, o "16 jul. 2026" (formato Yape/Plin) ----
  const matchFecha = texto.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
  if (matchFecha) {
    let [, d, m, a] = matchFecha;
    if (a.length === 2) a = '20' + a;
    d = d.padStart(2, '0'); m = m.padStart(2, '0');
    sugerencias.fecha_gasto = `${a}-${m}-${d}`;
  } else {
    const MESES = { ene: '01', feb: '02', mar: '03', abr: '04', may: '05', jun: '06',
                     jul: '07', ago: '08', set: '09', sep: '09', oct: '10', nov: '11', dic: '12' };
    const matchMes = texto.match(/\b(\d{1,2})\s+([a-záéíóúñ]{3,4})\.?\s+(\d{4})\b/i);
    if (matchMes) {
      const mesNum = MESES[matchMes[2].toLowerCase().slice(0, 3)];
      if (mesNum) sugerencias.fecha_gasto = `${matchMes[3]}-${mesNum}-${matchMes[1].padStart(2, '0')}`;
    }
  }

  // ---- Monto: busca cerca de la etiqueta "total" (puede estar en línea distinta al número,
  // como pasa en boletas con columnas), y si no hay etiqueta, usa el formato "S/400" de Yape/Plin ----
  const RE_MONTO = /(\d{1,4}(?:[.,]\d{1,2})?)(?!\s*%)/;

  function buscarMontoCercaDe(regexEtiqueta) {
    for (let i = 0; i < lineas.length; i++) {
      if (regexEtiqueta.test(lineas[i])) {
        for (let j = i; j < Math.min(i + 4, lineas.length); j++) {
          const m = lineas[j].match(RE_MONTO);
          if (m) return m[1].replace(',', '.');
        }
      }
    }
    return null;
  }

  let monto = buscarMontoCercaDe(/importe\s*total/i);
  if (!monto) monto = buscarMontoCercaDe(/\btotal\b/i);
  if (!monto) {
    const matchSlash = texto.match(/S\/\s?(\d{1,4}(?:[.,]\d{1,2})?)/);
    if (matchSlash) monto = matchSlash[1].replace(',', '.');
  }
  if (!monto) {
    const montos = [...texto.matchAll(/(\d{1,4}[.,]\d{2})/g)].map((m) => parseFloat(m[1].replace(',', '.')));
    if (montos.length) monto = Math.max(...montos).toFixed(2);
  }
  if (monto) sugerencias.monto = monto;

  return sugerencias;
}
