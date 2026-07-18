// ==== CONFIGURACIÓN ====
// Reemplazar con la URL del Web App de Apps Script (Implementar > Nueva implementación > Aplicación web)
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

// ---- Borrador: guarda el progreso mientras se llena, para no perderlo si se cierra la app ----
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

// ---- GPS: ubicación al momento de tomar/elegir la foto (no bloquea si se niega el permiso) ----
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

// ---- Compresión de fotos (evita mandar 5-8 MB por foto) ----
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

// ---- UI: render lista de gastos agregados ----
function renderGastos() {
  const cont = document.getElementById('lista-gastos');
  cont.innerHTML = '';
  gastos.forEach((g, i) => {
    const div = document.createElement('div');
    div.className = 'gasto-card';
    div.innerHTML = `
      <div class="gasto-card-header">
        <strong>${g.concepto}</strong>
        <button type="button" data-i="${i}" class="btn-quitar">✕</button>
      </div>
      <div class="gasto-card-body">
        ${g.fecha_gasto} · <span class="monto">S/ ${g.monto}</span> · ${labelCategoria(g.categoria)}
      </div>
    `;
    cont.appendChild(div);
  });
  document.querySelectorAll('.btn-quitar').forEach((btn) => {
    btn.addEventListener('click', () => {
      gastos.splice(Number(btn.dataset.i), 1);
      renderGastos();
      actualizarTotales();
      autoguardarBorrador();
      actualizarProgreso();
    });
  });
  document.getElementById('btn-enviar').disabled = gastos.length === 0;
  actualizarProgreso();
}

function labelCategoria(v) {
  const found = CATEGORIAS.find((c) => c[0] === v);
  return found ? found[1] : v;
}

function actualizarTotales() {
  const total = gastos.reduce((s, g) => s + Number(g.monto || 0), 0);
  document.getElementById('total-gastado').textContent = 'S/ ' + total.toFixed(2);
}

// ---- UI: helpers de feedback visual ----
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

function mostrarConfirmacion(mensaje) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-mensaje').textContent = mensaje;
    overlay.classList.add('abierto');

    function limpiar(resultado) {
      overlay.classList.remove('abierto');
      btnConfirmar.removeEventListener('click', onConfirmar);
      btnCancelar.removeEventListener('click', onCancelar);
      overlay.removeEventListener('click', onOverlay);
      resolve(resultado);
    }
    const btnConfirmar = document.getElementById('modal-confirmar');
    const btnCancelar = document.getElementById('modal-cancelar');
    function onConfirmar() { limpiar(true); }
    function onCancelar() { limpiar(false); }
    function onOverlay(e) { if (e.target === overlay) limpiar(false); }
    btnConfirmar.addEventListener('click', onConfirmar);
    btnCancelar.addEventListener('click', onCancelar);
    overlay.addEventListener('click', onOverlay);
  });
}

function actualizarProgreso() {
  const viajeCompleto = !!(
    document.getElementById('viaje-jefe').value.trim() &&
    document.getElementById('viaje-destino').value.trim() &&
    document.getElementById('viaje-fecha-salida').value
  );
  const pasoViaje = document.getElementById('paso-viaje');
  const pasoGastos = document.getElementById('paso-gastos');
  const pasoEnviar = document.getElementById('paso-enviar');

  pasoViaje.classList.toggle('completo', viajeCompleto);
  pasoViaje.classList.toggle('activo', !viajeCompleto);

  pasoGastos.classList.toggle('completo', viajeCompleto && gastos.length > 0);
  pasoGastos.classList.toggle('activo', viajeCompleto && gastos.length === 0);

  const listoParaEnviar = viajeCompleto && gastos.length > 0;
  pasoEnviar.classList.toggle('activo', listoParaEnviar);
  pasoEnviar.classList.toggle('completo', false);
}

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

// ---- OCR: lee la foto y sugiere fecha/monto (no reemplaza revisión humana) ----
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
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita preflight CORS
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
      return; // deja de intentar, se reintentará después
    }
  }
}

async function registrarSync() {
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    const reg = await navigator.serviceWorker.ready;
    try { await reg.sync.register('sync-gastos'); } catch (e) { /* no soportado, seguimos con fallback */ }
  }
}

// ---- Inicialización ----
document.addEventListener('DOMContentLoaded', async () => {
  llenarSelect('gasto-categoria', CATEGORIAS);
  llenarSelect('gasto-tipo-doc', TIPOS_DOC);
  document.getElementById('gasto-fecha').valueAsDate = new Date();
  document.getElementById('viaje-fecha-salida').valueAsDate = new Date();

  try {
    const borrador = await cargarBorrador();
    if (borrador && (borrador.gastos?.length || borrador.viaje?.jefe_grupo)) {
      restaurarViaje(borrador.viaje);
      gastos = borrador.gastos || [];
      renderGastos();
      actualizarTotales();
      setEstadoSync('📝 Se recuperó un borrador guardado — continúa donde quedaste o revisa antes de enviar.', 'info');
    }
  } catch (err) { /* sin borrador previo, se sigue normal */ }

  actualizarProgreso();

  let archivoFotoSeleccionado = null;
  let gpsSeleccionado = null;
  let momentoCapturaSeleccionado = null;

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
    obtenerGPS().then((gps) => { gpsSeleccionado = gps; });

    document.querySelectorAll('.btn-foto').forEach((b) => b.classList.remove('recien-elegida'));
    if (btnOrigen) btnOrigen.classList.add('recien-elegida');

    document.getElementById('foto-nombre').textContent = `📎 Foto lista (${origen}): ${file.name || 'sin nombre'}`;
    setOcrStatus('🔍 Leyendo el comprobante...', 'leyendo');
    try {
      const foto_base64 = await comprimirFoto(file);
      const sugerencias = await intentarOCR(foto_base64);
      if (sugerencias.fecha_gasto) document.getElementById('gasto-fecha').value = sugerencias.fecha_gasto;
      if (sugerencias.monto) document.getElementById('gasto-monto').value = sugerencias.monto;
      if (sugerencias.fecha_gasto || sugerencias.monto) {
        setOcrStatus('✅ Fecha/monto detectados automáticamente — verifica que estén correctos antes de agregar.', 'exito');
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

  document.getElementById('btn-agregar-gasto').addEventListener('click', async () => {
    const fecha_gasto = document.getElementById('gasto-fecha').value;
    const concepto = document.getElementById('gasto-concepto').value.trim();
    const categoria = document.getElementById('gasto-categoria').value;
    const monto = document.getElementById('gasto-monto').value;
    const tipo_documento = document.getElementById('gasto-tipo-doc').value;

    if (!fecha_gasto || !concepto || !categoria || !monto || !tipo_documento || !archivoFotoSeleccionado) {
      alert('Completa todos los campos del gasto, incluida la foto.');
      return;
    }

    const confirmado = await mostrarConfirmacion(`¿Añadir el gasto en "${concepto}" con un monto de S/ ${Number(monto).toFixed(2)}?`);
    if (!confirmado) return;

    const foto_base64 = await comprimirFoto(archivoFotoSeleccionado);
    gastos.push({
      fecha_gasto, concepto, categoria, monto, tipo_documento, foto_base64,
      gps_lat: gpsSeleccionado ? gpsSeleccionado.lat : '',
      gps_lng: gpsSeleccionado ? gpsSeleccionado.lng : '',
      momento_captura: momentoCapturaSeleccionado || '',
    });
    renderGastos();
    actualizarTotales();
    autoguardarBorrador();
    actualizarProgreso();

    // limpiar mini-formulario
    document.getElementById('gasto-concepto').value = '';
    document.getElementById('gasto-categoria').value = '';
    document.getElementById('gasto-monto').value = '';
    document.getElementById('gasto-tipo-doc').value = '';
    document.getElementById('gasto-foto-camara').value = '';
    document.getElementById('gasto-foto-galeria').value = '';
    document.getElementById('foto-nombre').textContent = '';
    setOcrStatus('', null);
    document.querySelectorAll('.btn-foto').forEach((b) => b.classList.remove('recien-elegida'));
    archivoFotoSeleccionado = null;
    gpsSeleccionado = null;
    momentoCapturaSeleccionado = null;
  });

  document.getElementById('form-viaje').addEventListener('input', () => {
    autoguardarBorrador();
    actualizarProgreso();
  });

  document.getElementById('form-viaje').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      jefe_grupo: document.getElementById('viaje-jefe').value.trim(),
      orden_trabajo: document.getElementById('viaje-orden').value.trim(),
      obra_proyecto: document.getElementById('viaje-obra').value.trim(),
      destino: document.getElementById('viaje-destino').value.trim(),
      centro_costo: document.getElementById('viaje-centro-costo').value.trim(),
      fecha_salida: document.getElementById('viaje-fecha-salida').value,
      fecha_retorno: document.getElementById('viaje-fecha-retorno').value,
      participantes: document.getElementById('viaje-participantes').value.trim(),
      num_participantes: document.getElementById('viaje-num-participantes').value,
      bolsa_total: document.getElementById('viaje-bolsa').value,
      gastos,
      enviado_en: new Date().toISOString(),
    };

    if (!payload.jefe_grupo || !payload.destino || !payload.fecha_salida || gastos.length === 0) {
      alert('Completa los datos del viaje y agrega al menos un gasto.');
      return;
    }

    const btnEnviar = document.getElementById('btn-enviar');
    btnEnviar.classList.add('cargando');
    try {
      await intentarEnviar(payload);
      setEstadoSync('✅ Rendición enviada correctamente.', 'exito');
      gastos = [];
      renderGastos();
      actualizarTotales();
      document.getElementById('form-viaje').reset();
      await borrarBorrador();
    } catch (err) {
      await guardarPendiente(payload);
      await registrarSync();
      setEstadoSync('📴 Sin señal — la rendición quedó guardada en el celular y se enviará sola apenas haya conexión. No cierres la app de forma forzada.', 'alerta');
      gastos = [];
      renderGastos();
      actualizarTotales();
      document.getElementById('form-viaje').reset();
      await borrarBorrador();
    } finally {
      btnEnviar.classList.remove('cargando');
      actualizarProgreso();
    }
  });

  // reintentar pendientes al abrir la app y al recuperar conexión
  sincronizarPendientes();
  window.addEventListener('online', sincronizarPendientes);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js');
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'TRY_SYNC') sincronizarPendientes();
    });
  }
});
