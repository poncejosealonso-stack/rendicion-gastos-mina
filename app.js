// ==== CONFIGURACIÓN ====
// Reemplazar con la URL del Web App de Apps Script (Implementar > Nueva implementación > Aplicación web)
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxxZJCZDGtZfvDvu8Bnd_COc7zJsYHJLo7hbX7vN3gOZLsbRqtZOH6uHgn5iCVUYJQHgA/exec';

const CATEGORIAS = [
  ['hidratacion_comida', 'Hidratación / comida extra'],
  ['salud', 'Salud (altura, malestar)'],
  ['consumo_operativo', 'Consumos operativos puntuales'],
  ['higiene', 'Higiene personal'],
  ['otro', 'Otro (no cubierto)'],
];
const TIPOS_DOC = [
  ['bv', 'Boleta de Venta (BV)'],
  ['ft', 'Factura (FT)'],
  ['mv', 'Movilidad sin comprobante (MV)'],
  ['dj', 'Declaración jurada (sin documento tributario)'],
];

let gastos = [];

// ---- IndexedDB ----
const DB_NAME = 'gastosMinaDB';
const STORE = 'pendientes';
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
        ${g.fecha_gasto} · S/ ${g.monto} · ${labelCategoria(g.categoria)}
      </div>
    `;
    cont.appendChild(div);
  });
  document.querySelectorAll('.btn-quitar').forEach((btn) => {
    btn.addEventListener('click', () => {
      gastos.splice(Number(btn.dataset.i), 1);
      renderGastos();
      actualizarTotales();
    });
  });
  document.getElementById('btn-enviar').disabled = gastos.length === 0;
}

function labelCategoria(v) {
  const found = CATEGORIAS.find((c) => c[0] === v);
  return found ? found[1] : v;
}

function actualizarTotales() {
  const total = gastos.reduce((s, g) => s + Number(g.monto || 0), 0);
  document.getElementById('total-gastado').textContent = total.toFixed(2);
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
  const estado = document.getElementById('estado-sync');
  if (!pendientes.length) return;
  estado.textContent = `Enviando ${pendientes.length} rendición(es) pendiente(s)...`;
  for (const p of pendientes) {
    try {
      await intentarEnviar(p.payload);
      await borrarPendiente(p.id);
      estado.textContent = 'Rendiciones pendientes enviadas correctamente.';
    } catch (err) {
      estado.textContent = `Sin señal aún — quedan ${pendientes.length} rendición(es) guardadas en el celular, se enviarán solas.`;
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
document.addEventListener('DOMContentLoaded', () => {
  llenarSelect('gasto-categoria', CATEGORIAS);
  llenarSelect('gasto-tipo-doc', TIPOS_DOC);
  document.getElementById('gasto-fecha').valueAsDate = new Date();
  document.getElementById('viaje-fecha-salida').valueAsDate = new Date();

  let archivoFotoSeleccionado = null;

  document.getElementById('btn-tomar-foto').addEventListener('click', () => {
    document.getElementById('gasto-foto-camara').click();
  });
  document.getElementById('btn-elegir-foto').addEventListener('click', () => {
    document.getElementById('gasto-foto-galeria').click();
  });

  async function manejarFotoSeleccionada(file, origen) {
    const ocrEstado = document.getElementById('ocr-status');
    if (!file) return;
    archivoFotoSeleccionado = file;
    document.getElementById('foto-nombre').textContent = `📎 Foto lista (${origen}): ${file.name || 'sin nombre'}`;
    ocrEstado.textContent = '🔍 Leyendo el comprobante...';
    try {
      const foto_base64 = await comprimirFoto(file);
      const sugerencias = await intentarOCR(foto_base64);
      if (sugerencias.fecha_gasto) document.getElementById('gasto-fecha').value = sugerencias.fecha_gasto;
      if (sugerencias.monto) document.getElementById('gasto-monto').value = sugerencias.monto;
      ocrEstado.textContent = (sugerencias.fecha_gasto || sugerencias.monto)
        ? '✅ Fecha/monto detectados automáticamente — verifica que estén correctos antes de agregar.'
        : 'No se pudo leer el comprobante automáticamente, completa los campos a mano.';
    } catch (err) {
      ocrEstado.textContent = 'Sin señal para leer automático — completa fecha y monto a mano.';
    }
  }

  document.getElementById('gasto-foto-camara').addEventListener('change', (e) => manejarFotoSeleccionada(e.target.files[0], 'cámara'));
  document.getElementById('gasto-foto-galeria').addEventListener('change', (e) => manejarFotoSeleccionada(e.target.files[0], 'galería'));

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

    const confirmado = confirm(`¿Estás seguro de añadir el gasto en "${concepto}" con un monto de S/ ${Number(monto).toFixed(2)}?`);
    if (!confirmado) return;

    const foto_base64 = await comprimirFoto(archivoFotoSeleccionado);
    gastos.push({ fecha_gasto, concepto, categoria, monto, tipo_documento, foto_base64 });
    renderGastos();
    actualizarTotales();

    // limpiar mini-formulario
    document.getElementById('gasto-concepto').value = '';
    document.getElementById('gasto-categoria').value = '';
    document.getElementById('gasto-monto').value = '';
    document.getElementById('gasto-tipo-doc').value = '';
    document.getElementById('gasto-foto-camara').value = '';
    document.getElementById('gasto-foto-galeria').value = '';
    document.getElementById('foto-nombre').textContent = '';
    document.getElementById('ocr-status').textContent = '';
    archivoFotoSeleccionado = null;
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

    const estado = document.getElementById('estado-sync');
    try {
      await intentarEnviar(payload);
      estado.textContent = '✅ Rendición enviada correctamente.';
      gastos = [];
      renderGastos();
      actualizarTotales();
      document.getElementById('form-viaje').reset();
    } catch (err) {
      await guardarPendiente(payload);
      await registrarSync();
      estado.textContent = '📴 Sin señal — la rendición quedó guardada en el celular y se enviará sola apenas haya conexión. No cierres la app de forma forzada.';
      gastos = [];
      renderGastos();
      actualizarTotales();
      document.getElementById('form-viaje').reset();
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
