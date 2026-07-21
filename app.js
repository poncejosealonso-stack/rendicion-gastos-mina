// ==== CONFIGURACIÓN ====
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxxZJCZDGtZfvDvu8Bnd_COc7zJsYHJLo7hbX7vN3gOZLsbRqtZOH6uHgn5iCVUYJQHgA/exec';

const CATEGORIAS = [
  ['movilidad', 'Movilidad'],
  ['hidratacion', 'Hidratación'],
  ['comidas_extras', 'Comidas extras'],
  ['salud', 'Salud (mal de altura, malestar general)'],
  ['primeros_auxilios', 'Primeros auxilios'],
  ['consumo_operativo', 'Consumos operativos puntuales'],
  ['otro', 'Otros'],
];
const TIPOS_DOC = [
  ['bv', 'Boleta de Venta (BV)'],
  ['ft', 'Factura (FT)'],
  ['mv', 'Movilidad sin comprobante (MV)'],
  ['yape_plin', 'Yape / Plin (captura de pago)'],
  ['dj', 'Declaración jurada (sin documento tributario)'],
];

let gastos = [];
let pasoActual = 1;

// ---- IndexedDB ----
const DB_NAME = 'gastosMinaDB';
const STORE = 'pendientes';
const STORE_BORRADOR = 'borrador';
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_BORRADOR)) {
        db.createObjectStore(STORE_BORRADOR, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function guardarBorrador(datos) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BORRADOR, 'readwrite');
    tx.objectStore(STORE_BORRADOR).put({ id: 'actual', datos, guardado: new Date().toISOString() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function cargarBorrador() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BORRADOR, 'readonly');
    const req = tx.objectStore(STORE_BORRADOR).get('actual');
    req.onsuccess = () => resolve(req.result ? req.result.datos : null);
    req.onerror = () => reject(req.error);
  });
}
async function borrarBorrador() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BORRADOR, 'readwrite');
    tx.objectStore(STORE_BORRADOR).delete('actual');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function guardarPendiente(payload) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add({ payload, creado: new Date().toISOString() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function listarPendientes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function borrarPendiente(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- GPS ----
function obtenerGPS() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude.toFixed(6), lng: pos.coords.longitude.toFixed(6) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  });
}

// ---- Compresión de fotos ----
function comprimirFoto(file, maxAncho = 1280, calidad = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => { img.src = e.target.result; };
    reader.onerror = reject;
    img.onload = () => {
      const escala = Math.min(1, maxAncho / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = img.width * escala;
      canvas.height = img.height * escala;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', calidad));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---- Navegación entre pasos ----
const SUBTITULOS = {
  1: 'Paso 1 de 3 · Datos del viaje',
  2: 'Paso 2 de 3 · Gastos',
  gasto: 'Paso 2 de 3 · Nuevo gasto',
  3: 'Paso 3 de 3 · Confirmar y enviar',
};

function viajeCompleto() {
  return !!(
    document.getElementById('viaje-jefe').value.trim() &&
    document.getElementById('viaje-destino').value.trim() &&
    document.getElementById('viaje-fecha-salida').value &&
    document.getElementById('viaje-participantes').value.trim()
  );
}

function irAPaso(paso) {
  pasoActual = paso;
  document.querySelectorAll('.pantalla').forEach((p) => p.classList.remove('visible'));
  const idPantalla = paso === 'gasto' ? 'pantalla-gasto' : 'pantalla-' + paso;
  document.getElementById(idPantalla).classList.add('visible');

  let subtitulo = SUBTITULOS[paso] || '';
  if (paso === 2 && gastos.length) subtitulo = `Paso 2 de 3 · Gastos (${gastos.length} registrado${gastos.length === 1 ? '' : 's'})`;
  document.getElementById('subtitulo-paso').textContent = subtitulo;

  const pasoNum = paso === 'gasto' ? 2 : paso;
  [1, 2, 3].forEach((n) => {
    const el = document.getElementById('paso-' + n);
    el.classList.remove('activo', 'completo');
    if (n < pasoNum) el.classList.add('completo');
    else if (n === pasoNum) el.classList.add('activo');
  });
  if (viajeCompleto()) document.getElementById('paso-1').classList.add('completo');
  if (gastos.length > 0) document.getElementById('paso-2').classList.add('completo');

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---- UI: lista de gastos (paso 2) ----
function labelCategoria(v) {
  const found = CATEGORIAS.find((c) => c[0] === v);
  return found ? found[1] : v;
}
function labelTipoDoc(v) {
  const found = TIPOS_DOC.find((c) => c[0] === v);
  return found ? found[1] : v;
}

function renderGastos() {
  const cont = document.getElementById('lista-gastos');
  cont.innerHTML = '';
  if (!gastos.length) {
    cont.innerHTML = '<div class="lista-vacia">Aún no hay gastos registrados.<br>Toca "＋ Agregar gasto" para empezar.</div>';
  }
  gastos.forEach((g, i) => {
    const div = document.createElement('div');
    div.className = 'gasto-card';
    div.innerHTML = `
      <div class="gasto-card-header">
        <strong>${g.concepto}</strong>
        <button type="button" data-i="${i}" class="btn-quitar">✕</button>
      </div>
      <div class="gasto-card-body">
        ${g.fecha_gasto} · <span class="monto">S/ ${Number(g.monto).toFixed(2)}</span> · ${labelCategoria(g.categoria)}
      </div>
    `;
    cont.appendChild(div);
  });
  document.querySelectorAll('.btn-quitar').forEach((btn) => {
    btn.addEventListener('click', () => {
      gastos.splice(Number(btn.dataset.i), 1);
      renderGastos();
      autoguardarBorrador();
      irAPaso(2);
    });
  });
  document.getElementById('btn-ir-paso-3').disabled = gastos.length === 0;
}

// ---- UI: resumen (paso 3) ----
function renderResumen() {
  const v = recopilarViaje();
  const fechas = [v.fecha_salida, v.fecha_retorno].filter(Boolean).join(' – ');
  document.getElementById('resumen-viaje').innerHTML = `
    <div class="resumen-fila"><span class="etiqueta">Jefe de grupo</span><span class="valor">${v.jefe_grupo || '—'}</span></div>
    <div class="resumen-fila"><span class="etiqueta">Destino</span><span class="valor">${v.destino || '—'}</span></div>
    <div class="resumen-fila"><span class="etiqueta">Fechas</span><span class="valor">${fechas || '—'}</span></div>
    <div class="resumen-fila"><span class="etiqueta">Participantes</span><span class="valor">${v.num_participantes || '—'}</span></div>
  `;
  const bolsa = Number(v.bolsa_total || 0);
  const gastado = gastos.reduce((s, g) => s + Number(g.monto || 0), 0);
  const saldo = bolsa - gastado;
  document.getElementById('resumen-bolsa').textContent = 'S/ ' + bolsa.toFixed(2);
  document.getElementById('resumen-num-gastos').textContent = gastos.length;
  document.getElementById('resumen-gastado').textContent = 'S/ ' + gastado.toFixed(2);
  const saldoEl = document.getElementById('resumen-saldo');
  saldoEl.textContent = 'S/ ' + saldo.toFixed(2);
  saldoEl.classList.toggle('saldo-positivo', saldo >= 0);
  saldoEl.classList.toggle('saldo-negativo', saldo < 0);
  document.querySelector('#pantalla-3 .resumen-total .etiqueta').textContent =
    saldo >= 0 ? 'Saldo a devolver' : 'Reembolso al trabajador';

  document.getElementById('resumen-gastos').innerHTML = gastos.map((g) => `
    <div class="resumen-fila"><span class="etiqueta">${g.concepto} · ${labelTipoDoc(g.tipo_documento)}</span><span class="valor">S/ ${Number(g.monto).toFixed(2)}</span></div>
  `).join('') || '<div class="lista-vacia">Sin gastos.</div>';
}

// ---- Viaje: recopilar/restaurar ----
function recopilarViaje() {
  return {
    jefe_grupo: document.getElementById('viaje-jefe').value,
    orden_trabajo: document.getElementById('viaje-orden').value,
    obra_proyecto: document.getElementById('viaje-obra').value,
    destino: document.getElementById('viaje-destino').value,
    centro_costo: document.getElementById('viaje-centro-costo').value,
    fecha_salida: document.getElementById('viaje-fecha-salida').value,
    fecha_retorno: document.getElementById('viaje-fecha-retorno').value,
    participantes: document.getElementById('viaje-participantes').value,
    num_participantes: document.getElementById('viaje-num-participantes').value,
    bolsa_total: document.getElementById('viaje-bolsa').value,
  };
}
function restaurarViaje(viaje) {
  if (!viaje) return;
  document.getElementById('viaje-jefe').value = viaje.jefe_grupo || '';
  document.getElementById('viaje-orden').value = viaje.orden_trabajo || '';
  document.getElementById('viaje-obra').value = viaje.obra_proyecto || '';
  document.getElementById('viaje-destino').value = viaje.destino || '';
  document.getElementById('viaje-centro-costo').value = viaje.centro_costo || '';
  if (viaje.fecha_salida) document.getElementById('viaje-fecha-salida').value = viaje.fecha_salida;
  if (viaje.fecha_retorno) document.getElementById('viaje-fecha-retorno').value = viaje.fecha_retorno;
  document.getElementById('viaje-participantes').value = viaje.participantes || '';
  document.getElementById('viaje-num-participantes').value = viaje.num_participantes || '';
  document.getElementById('viaje-bolsa').value = viaje.bolsa_total || '';
}

let guardarBorradorTimeout = null;
function autoguardarBorrador() {
  clearTimeout(guardarBorradorTimeout);
  guardarBorradorTimeout = setTimeout(() => {
    guardarBorrador({ viaje: recopilarViaje(), gastos });
  }, 500);
}

function llenarSelect(id, opciones) {
  const sel = document.getElementById(id);
  sel.innerHTML = '<option value="">-- Elegir --</option>' +
    opciones.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
}

// ---- Feedback visual ----
function setEstadoSync(texto, tipo) {
  const el = document.getElementById('estado-sync');
  el.textContent = texto;
  el.classList.remove('info', 'exito', 'alerta');
  if (tipo) el.classList.add(tipo);
}
function setOcrStatus(texto, tipo) {
  const el = document.getElementById('ocr-status');
  el.textContent = texto;
  el.classList.remove('leyendo', 'exito', 'info', 'error');
  if (tipo) el.classList.add(tipo);
}
function mostrarConfirmacion(titulo, mensaje) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-titulo').textContent = titulo;
    document.getElementById('modal-mensaje').textContent = mensaje;
    overlay.classList.add('abierto');
    const btnConfirmar = document.getElementById('modal-confirmar');
    const btnCancelar = document.getElementById('modal-cancelar');
    function limpiar(resultado) {
      overlay.classList.remove('abierto');
      btnConfirmar.removeEventListener('click', onConfirmar);
      btnCancelar.removeEventListener('click', onCancelar);
      overlay.removeEventListener('click', onOverlay);
      resolve(resultado);
    }
    function onConfirmar() { limpiar(true); }
    function onCancelar() { limpiar(false); }
    function onOverlay(e) { if (e.target === overlay) limpiar(false); }
    btnConfirmar.addEventListener('click', onConfirmar);
    btnCancelar.addEventListener('click', onCancelar);
    overlay.addEventListener('click', onOverlay);
  });
}

// ---- OCR ----
async function intentarOCR(foto_base64) {
  const resp = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ accion: 'ocr', foto_base64 }),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'OCR falló');
  return data.sugerencias || {};
}

// ---- Envío ----
async function intentarEnviar(payload) {
  const resp = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'Error del servidor');
  return data;
}

async function sincronizarPendientes() {
  const pendientes = await listarPendientes();
  if (!pendientes.length) return;
  setEstadoSync(`Enviando ${pendientes.length} rendición(es) pendiente(s)...`, 'info');
  for (const p of pendientes) {
    try {
      await intentarEnviar(p.payload);
      await borrarPendiente(p.id);
      setEstadoSync('Rendiciones pendientes enviadas correctamente.', 'exito');
    } catch (err) {
      setEstadoSync(`Sin señal aún — quedan ${pendientes.length} rendición(es) guardadas en el celular, se enviarán solas.`, 'alerta');
      return;
    }
  }
}

async function registrarSync() {
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    const reg = await navigator.serviceWorker.ready;
    try { await reg.sync.register('sync-gastos'); } catch (e) { /* fallback activo */ }
  }
}

// ---- Inicialización ----
document.addEventListener('DOMContentLoaded', async () => {
  llenarSelect('gasto-categoria', CATEGORIAS);
  llenarSelect('gasto-tipo-doc', TIPOS_DOC);
  document.getElementById('gasto-fecha').valueAsDate = new Date();
  document.getElementById('viaje-fecha-salida').valueAsDate = new Date();

  let hayBorrador = false;
  try {
    const borrador = await cargarBorrador();
    if (borrador && (borrador.gastos?.length || borrador.viaje?.jefe_grupo)) {
      restaurarViaje(borrador.viaje);
      gastos = borrador.gastos || [];
      hayBorrador = true;
    }
  } catch (err) { /* sin borrador */ }

  renderGastos();
  irAPaso(hayBorrador && viajeCompleto() ? 2 : 1);
  if (hayBorrador) {
    setEstadoSync('📝 Se recuperó un borrador guardado — continúa donde quedaste.', 'info');
  }

  // -- Navegación --
  document.getElementById('btn-ir-paso-2').addEventListener('click', () => {
    const requeridos = ['viaje-jefe', 'viaje-destino', 'viaje-fecha-salida', 'viaje-participantes'];
    let ok = true;
    requeridos.forEach((id) => {
      const el = document.getElementById(id);
      const vacio = !el.value.trim();
      el.classList.toggle('invalido', vacio);
      if (vacio) ok = false;
    });
    if (!ok) {
      alert('Completa los campos obligatorios (*) antes de continuar.');
      return;
    }
    autoguardarBorrador();
    irAPaso(2);
  });
  document.getElementById('btn-volver-paso-1').addEventListener('click', () => irAPaso(1));
  document.getElementById('btn-ir-paso-3').addEventListener('click', () => {
    renderResumen();
    irAPaso(3);
  });
  document.getElementById('btn-volver-paso-2').addEventListener('click', () => irAPaso(2));

  document.querySelectorAll('#progreso .paso').forEach((el) => {
    el.addEventListener('click', () => {
      const destino = Number(el.dataset.paso);
      if (destino === 1) irAPaso(1);
      if (destino === 2 && viajeCompleto()) irAPaso(2);
      if (destino === 3 && viajeCompleto() && gastos.length) { renderResumen(); irAPaso(3); }
    });
  });

  // -- Formulario de gasto --
  let archivoFotoSeleccionado = null;
  let gpsSeleccionado = null;
  let gpsPromesa = null;
  let momentoCapturaSeleccionado = null;
  let ocrSeleccionado = null;

  // mapea lo que detecta el OCR al desplegable "Tipo de documento"
  const MAPA_TIPO_OCR = { boleta: 'bv', ticket: 'bv', factura: 'ft', yape_plin: 'yape_plin' };

  function limpiarFormularioGasto() {
    document.getElementById('gasto-concepto').value = '';
    document.getElementById('gasto-categoria').value = '';
    document.getElementById('gasto-monto').value = '';
    document.getElementById('gasto-tipo-doc').value = '';
    document.getElementById('gasto-foto-camara').value = '';
    document.getElementById('gasto-foto-galeria').value = '';
    document.getElementById('gasto-fecha').valueAsDate = new Date();
    document.getElementById('foto-nombre').textContent = '';
    setOcrStatus('', null);
    document.querySelectorAll('.btn-foto').forEach((b) => b.classList.remove('recien-elegida'));
    archivoFotoSeleccionado = null;
    gpsSeleccionado = null;
    gpsPromesa = null;
    momentoCapturaSeleccionado = null;
    ocrSeleccionado = null;
  }

  document.getElementById('btn-agregar-gasto-grande').addEventListener('click', () => {
    limpiarFormularioGasto();
    irAPaso('gasto');
  });
  document.getElementById('btn-cancelar-gasto').addEventListener('click', () => irAPaso(2));

  document.getElementById('btn-tomar-foto').addEventListener('click', () => {
    document.getElementById('gasto-foto-camara').click();
  });
  document.getElementById('btn-elegir-foto').addEventListener('click', () => {
    document.getElementById('gasto-foto-galeria').click();
  });

  async function manejarFotoSeleccionada(file, origen, btnOrigen) {
    if (!file) return;
    archivoFotoSeleccionado = file;
    momentoCapturaSeleccionado = new Date().toISOString();
    gpsSeleccionado = null;
    gpsPromesa = obtenerGPS().then((gps) => { gpsSeleccionado = gps; return gps; });

    document.querySelectorAll('.btn-foto').forEach((b) => b.classList.remove('recien-elegida'));
    if (btnOrigen) btnOrigen.classList.add('recien-elegida');

    document.getElementById('foto-nombre').textContent = `📎 Foto lista (${origen}): ${file.name || 'sin nombre'}`;
    setOcrStatus('🔍 Leyendo el comprobante...', 'leyendo');
    try {
      const foto_base64 = await comprimirFoto(file);
      const sugerencias = await intentarOCR(foto_base64);
      ocrSeleccionado = sugerencias;
      if (sugerencias.fecha_gasto) document.getElementById('gasto-fecha').value = sugerencias.fecha_gasto;
      if (sugerencias.monto) document.getElementById('gasto-monto').value = sugerencias.monto;
      const tipoSugerido = MAPA_TIPO_OCR[sugerencias.tipo_detectado];
      const selTipo = document.getElementById('gasto-tipo-doc');
      if (tipoSugerido && !selTipo.value) selTipo.value = tipoSugerido;
      const inputConcepto = document.getElementById('gasto-concepto');
      if (sugerencias.comercio && !inputConcepto.value.trim()) inputConcepto.value = sugerencias.comercio;
      if (sugerencias.fecha_gasto || sugerencias.monto) {
        setOcrStatus('✅ Datos detectados automáticamente — verifica que estén correctos antes de guardar.', 'exito');
      } else {
        setOcrStatus('No se pudo leer el comprobante automáticamente, completa los campos a mano.', 'info');
      }
    } catch (err) {
      setOcrStatus('Sin señal para leer automático — completa fecha y monto a mano.', 'error');
    }
  }

  document.getElementById('gasto-foto-camara').addEventListener('change', (e) =>
    manejarFotoSeleccionada(e.target.files[0], 'cámara', document.getElementById('btn-tomar-foto')));
  document.getElementById('gasto-foto-galeria').addEventListener('change', (e) =>
    manejarFotoSeleccionada(e.target.files[0], 'galería', document.getElementById('btn-elegir-foto')));

  document.getElementById('btn-guardar-gasto').addEventListener('click', async () => {
    const fecha_gasto = document.getElementById('gasto-fecha').value;
    const concepto = document.getElementById('gasto-concepto').value.trim();
    const categoria = document.getElementById('gasto-categoria').value;
    const monto = document.getElementById('gasto-monto').value;
    const tipo_documento = document.getElementById('gasto-tipo-doc').value;

    if (!fecha_gasto || !concepto || !categoria || !monto || !tipo_documento || !archivoFotoSeleccionado) {
      alert('Completa todos los campos del gasto, incluida la foto.');
      return;
    }

    const confirmado = await mostrarConfirmacion(
      'Confirmar gasto',
      `¿Añadir el gasto en "${concepto}" con un monto de S/ ${Number(monto).toFixed(2)}?`
    );
    if (!confirmado) return;

    if (!gpsSeleccionado && gpsPromesa) {
      setOcrStatus('📍 Obteniendo ubicación GPS...', 'leyendo');
      await gpsPromesa;
      setOcrStatus('', null);
    }

    const foto_base64 = await comprimirFoto(archivoFotoSeleccionado);
    const ocr = ocrSeleccionado || {};
    gastos.push({
      fecha_gasto, concepto, categoria, monto, tipo_documento, foto_base64,
      gps_lat: gpsSeleccionado ? gpsSeleccionado.lat : '',
      gps_lng: gpsSeleccionado ? gpsSeleccionado.lng : '',
      momento_captura: momentoCapturaSeleccionado || '',
      // lo que leyó el OCR en el comprobante — el backend lo usa para las alertas de auditoría
      ocr_monto: ocr.monto || '',
      ocr_fecha: ocr.fecha_gasto || '',
      ocr_ruc: ocr.ruc || '',
      ocr_num_documento: ocr.num_documento || '',
      ocr_comercio: ocr.comercio || '',
    });
    renderGastos();
    autoguardarBorrador();
    limpiarFormularioGasto();
    irAPaso(2);
  });

  document.querySelectorAll('#pantalla-1 input').forEach((el) => {
    el.addEventListener('input', () => {
      el.classList.remove('invalido');
      autoguardarBorrador();
    });
  });

  // -- Envío final --
  document.getElementById('btn-enviar').addEventListener('click', async () => {
    const v = recopilarViaje();
    const payload = {
      jefe_grupo: v.jefe_grupo.trim(),
      orden_trabajo: v.orden_trabajo.trim(),
      obra_proyecto: v.obra_proyecto.trim(),
      destino: v.destino.trim(),
      centro_costo: v.centro_costo.trim(),
      fecha_salida: v.fecha_salida,
      fecha_retorno: v.fecha_retorno,
      participantes: v.participantes.trim(),
      num_participantes: v.num_participantes,
      bolsa_total: v.bolsa_total,
      gastos,
      enviado_en: new Date().toISOString(),
    };

    if (!payload.jefe_grupo || !payload.destino || !payload.fecha_salida || gastos.length === 0) {
      alert('Faltan datos del viaje o no hay gastos registrados.');
      return;
    }

    const confirmado = await mostrarConfirmacion(
      'Enviar rendición',
      `Se enviará la rendición de ${payload.jefe_grupo} con ${gastos.length} gasto(s). ¿Continuar?`
    );
    if (!confirmado) return;

    const btnEnviar = document.getElementById('btn-enviar');
    btnEnviar.classList.add('cargando');
    try {
      await intentarEnviar(payload);
      setEstadoSync('✅ Rendición enviada correctamente.', 'exito');
    } catch (err) {
      await guardarPendiente(payload);
      await registrarSync();
      setEstadoSync('📴 Sin señal — la rendición quedó guardada en el celular y se enviará sola apenas haya conexión. No cierres la app de forma forzada.', 'alerta');
    } finally {
      btnEnviar.classList.remove('cargando');
      gastos = [];
      renderGastos();
      document.querySelectorAll('#pantalla-1 input').forEach((el) => { el.value = ''; });
      document.getElementById('viaje-fecha-salida').valueAsDate = new Date();
      await borrarBorrador();
    }
  });

  // -- Sincronización de pendientes --
  sincronizarPendientes();
  window.addEventListener('online', sincronizarPendientes);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js');
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'TRY_SYNC') sincronizarPendientes();
    });
  }
});
