// ==== BACKEND — Rendición de Gastos en Mina (PWA) — v9: OCR Claude + Auditoría ====
const SSID = '1B0JhjDLTxUgi_YTSdoRRLxEKkW7sqVzV0sBDGQ7CXuM';
const CARPETA_FOTOS_NOMBRE = 'Rendicion Gastos Mina - Fotos (PWA)';
const ANTHROPIC_API_KEY = 'PEGA_AQUI_TU_CLAVE_sk-ant-...'; // <-- mantener tu clave real aquí

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
      'Alertas de auditoría', 'RUC (OCR)', 'N° doc (OCR)', 'Comercio (OCR)', 'Hash foto'
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
        alertas.join(', '), g.ocr_ruc || '', g.ocr_num_documento || '', g.ocr_comercio || '', hashFoto
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
  return ContentService.createTextOutput('Backend Rendición de Gastos en Mina activo. v9-auditoria');
}

// ==== AUDITORÍA (Fase 1) ====
// Reglas que marcan, no bloquean: la tesorera decide. Cada alerta va en la columna "Alertas de auditoría".
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

  // 7) DOC_DUPLICADO: el mismo comprobante (RUC + serie-número leídos por OCR) ya fue rendido antes
  const claveDoc = claveDocumento(g.ocr_ruc, g.ocr_num_documento);
  if (claveDoc && existentes.docs[claveDoc]) alertas.push('DOC_DUPLICADO');

  return alertas;
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
  const headers = ['Alertas de auditoría', 'RUC (OCR)', 'N° doc (OCR)', 'Comercio (OCR)', 'Hash foto'];
  const primeraCelda = hoja.getRange(1, 16).getValue();
  if (!primeraCelda) {
    hoja.getRange(1, 16, 1, headers.length).setValues([headers]);
    hoja.getRange(1, 16, 1, headers.length).setFontWeight('bold');
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
          { type: 'text', text: 'Extrae los datos de este comprobante de pago peruano (boleta, factura, ticket, o captura de Yape/Plin). El monto es el IMPORTE TOTAL realmente pagado (no subtotales, no IGV aislado, no vuelto). La fecha es la de emisión del comprobante. Si un campo no se ve o no existe, usa cadena vacía.' }
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
              tipo_detectado: { type: 'string', description: 'Uno de: boleta, factura, ticket, yape_plin, otro' }
            },
            required: ['fecha', 'monto_total', 'ruc', 'serie_numero', 'comercio', 'tipo_detectado'],
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
    if (datos.tipo_detectado) sugerencias.tipo_detectado = datos.tipo_detectado;

    return { ok: true, sugerencias: sugerencias };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
