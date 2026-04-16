const socket = io();

// --- DOM ELEMENTS (Recordatorios) ---
const connectionStatus  = document.getElementById('connectionStatus');
const statusDot         = connectionStatus.querySelector('.status-dot');
const statusText        = connectionStatus.querySelector('.status-text');
const botInfo           = document.getElementById('botInfo');
const qrContainer       = document.getElementById('qrContainer');
const qrCodeDiv         = document.getElementById('qrCode');
const loadingStatus     = document.getElementById('loadingStatus');
const logsContainer     = document.getElementById('logsContainer');
const manualCheckBtn    = document.getElementById('manualCheckBtn');
const clearLogsBtn      = document.getElementById('clearLogsBtn');
const autoToggle        = document.getElementById('autoToggle');
const logoutBtn         = document.getElementById('logoutBtn');
const refreshBtn        = document.getElementById('refreshBtn');
const hourInput         = document.getElementById('hourInput');
const minuteInput       = document.getElementById('minuteInput');
const periodInput       = document.getElementById('periodInput');
const cronTimeDisplay   = document.getElementById('cronTimeDisplay');
const refreshPacientesBtn = document.getElementById('refreshPacientesBtn');
const pacientesTableBody  = document.getElementById('pacientesTableBody');
const nextSendDisplay   = document.getElementById('nextSendDisplay');
const waStatusDisplay   = document.getElementById('waStatusDisplay');
const patientCountDisplay = document.getElementById('patientCountDisplay');
const autoStatusDisplay = document.getElementById('autoStatusDisplay');
const initTimeEl = document.getElementById('initTime');
if (initTimeEl) initTimeEl.textContent = getTimeString();

// ══════════════════════════════════════════════
//  TAB SWITCHING
// ══════════════════════════════════════════════
function switchTab(tabId) {
    // Hide all tabs
    document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
    const target = document.getElementById('tab-' + tabId);
    if (target) target.style.display = 'block';

    // Toggle headers
    const headerDoc = document.getElementById('headerDoctores');
    const headerRec = document.getElementById('headerRecordatorios');

    if (tabId === 'doctores') {
        if (headerDoc) headerDoc.style.display = 'flex';
        if (headerRec) headerRec.style.display = 'none';
        document.body.style.background = '#0B1120';
        loadBotConfig();
        loadHorariosDelServidor().then(data => { renderPanel(data); cargarEstadisticas(); });
    } else {
        if (headerDoc) headerDoc.style.display = 'none';
        if (headerRec) headerRec.style.display = '';
        document.body.style.background = '';
    }
}

// ══════════════════════════════════════════════
//  RECORDATORIOS HELPERS
// ══════════════════════════════════════════════
function getTimeString() {
    return new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function addLog(message, type = 'info') {
    const logEl = document.createElement('div');
    logEl.className = `log-entry log-${type}`;
    const icons = { success:'<i class="fa-solid fa-check"></i>', error:'<i class="fa-solid fa-xmark"></i>', warning:'<i class="fa-solid fa-triangle-exclamation"></i>', system:'<i class="fa-solid fa-gear"></i>', info:'<span style="color:#1e293b">›</span>' };
    logEl.innerHTML = `<span class="log-icon">${icons[type]||icons.info}</span><span class="log-time">[${getTimeString()}]</span><span class="log-msg">${message}</span>`;
    logsContainer.appendChild(logEl);
    logsContainer.scrollTop = logsContainer.scrollHeight;
}
function updateUI(status) {
    loadingStatus.classList.add('hidden');
    qrContainer.classList.add('hidden');
    botInfo.classList.add('hidden');
    connectionStatus.classList.remove('status-loading', 'status-qr', 'status-connected');

    // Doctor header WA pill
    const docPill = document.getElementById('docWaStatus');
    const docText = document.getElementById('docWaText');
    if (docPill) docPill.classList.remove('wa-connected', 'wa-qr');

    if (status === 'connected') {
        connectionStatus.classList.add('status-connected'); statusText.textContent = 'Conectado';
        botInfo.classList.remove('hidden'); waStatusDisplay.textContent = 'Conectado'; waStatusDisplay.style.color = '#6EAD8C';
        if (docPill) { docPill.classList.add('wa-connected'); }
        if (docText) docText.textContent = 'Conectado';
        // Auto-close QR modal when connected
        const modal = document.getElementById('qrModal');
        if (modal) modal.style.display = 'none';
    } else if (status === 'qr') {
        connectionStatus.classList.add('status-qr'); statusText.textContent = 'Escanear QR';
        qrContainer.classList.remove('hidden'); waStatusDisplay.textContent = 'QR Activo'; waStatusDisplay.style.color = '#fbbf24';
        if (docPill) { docPill.classList.add('wa-qr'); }
        if (docText) docText.textContent = 'Escanear QR';
        // Auto-open QR modal
        const modal = document.getElementById('qrModal');
        if (modal) modal.style.display = 'flex';
    } else {
        connectionStatus.classList.add('status-loading'); statusText.textContent = 'Iniciando...';
        loadingStatus.classList.remove('hidden'); waStatusDisplay.textContent = 'Iniciando'; waStatusDisplay.style.color = '#64748b';
        if (docText) docText.textContent = 'Iniciando...';
    }
}
function updateAutoStatusDisplay(isEnabled) {
    autoStatusDisplay.textContent = isEnabled ? 'Activo' : 'Pausado';
    autoStatusDisplay.style.color = isEnabled ? '#6EAD8C' : '#f59e0b';
}
function updateCronTime() {
    let h = parseInt(hourInput.value); const m = minuteInput.value; const period = periodInput.value;
    if (period === 'PM' && h < 12) h += 12; if (period === 'AM' && h === 12) h = 0;
    socket.emit('set_cron_time', `${h.toString().padStart(2,'0')}:${m}`);
    const displayStr = `${hourInput.value}:${m} ${period}`;
    cronTimeDisplay.textContent = `Diario a las ${displayStr}`; nextSendDisplay.textContent = displayStr;
}

// ══════════════════════════════════════════════
//  SOCKET EVENTS
// ══════════════════════════════════════════════
socket.on('connect', () => { addLog('Conectado al servidor.', 'system'); socket.emit('get_pacientes'); });
socket.on('config', (config) => {
    autoToggle.checked = config.autoRevisarEnabled; updateAutoStatusDisplay(config.autoRevisarEnabled);
    if (config.cronTime) {
        const [h24, m] = config.cronTime.split(':'); let h12 = parseInt(h24); let period = 'AM';
        if (h12 >= 12) { period = 'PM'; if (h12 > 12) h12 -= 12; } else if (h12 === 0) h12 = 12;
        hourInput.value = h12.toString().padStart(2,'0'); minuteInput.value = m; periodInput.value = period;
        const ds = `${h12.toString().padStart(2,'0')}:${m} ${period}`;
        cronTimeDisplay.textContent = `Diario a las ${ds}`; nextSendDisplay.textContent = ds;
    }
});
socket.on('pacientes_data', (pacientes) => {
    pacientesTableBody.innerHTML = ''; patientCountDisplay.textContent = pacientes.length;
    if (pacientes.length === 0) {
        pacientesTableBody.innerHTML = '<tr><td colspan="5" class="empty-cell"><i class="fa-solid fa-tooth"></i> No hay citas programadas para mañana.</td></tr>'; return;
    }
    pacientes.forEach(p => {
        const tr = document.createElement('tr'); const pds = JSON.stringify(p).replace(/'/g, "&apos;");
        tr.innerHTML = `<td><span style="font-weight:600">${p.nombre}</span></td><td style="color:#64748b"><i class="fa-brands fa-whatsapp" style="color:#6EAD8C;margin-right:5px"></i>+${p.numeroWs}</td><td><span class="badge-vacuna"><i class="fa-solid fa-tooth" style="font-size:0.7rem"></i> ${p.vacuna}</span></td><td style="color:#64748b">${p.fecha}</td><td class="text-right"><button class="send-single-btn btn btn-ghost btn-sm" style="color:#6EAD8C;border-color:rgba(110,173,140,0.2);background:rgba(110,173,140,0.07)" data-paciente='${pds}'><i class="fa-solid fa-paper-plane"></i> Enviar</button></td>`;
        pacientesTableBody.appendChild(tr);
    });
    document.querySelectorAll('.send-single-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const paciente = JSON.parse(this.getAttribute('data-paciente').replace(/&apos;/g, "'"));
            if (confirm(`¿Enviar recordatorio a ${paciente.nombre}?`)) {
                this.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; this.disabled = true;
                socket.emit('send_to_patient', paciente);
                setTimeout(() => { this.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Enviar'; this.disabled = false; }, 4000);
            }
        });
    });
});
socket.on('status', (status) => updateUI(status));
socket.on('qr', (qrDataUrl) => { qrCodeDiv.innerHTML = `<img src="${qrDataUrl}" alt="QR">`; });
socket.on('log', (data) => addLog(data.msg, data.type));

// ══════════════════════════════════════════════
//  RECORDATORIOS ACTIONS
// ══════════════════════════════════════════════
clearLogsBtn.addEventListener('click', () => { logsContainer.innerHTML = ''; addLog('Consola limpiada.', 'system'); });
manualCheckBtn.addEventListener('click', () => {
    manualCheckBtn.disabled = true; manualCheckBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Enviando...';
    socket.emit('manual_check'); addLog('Ejecución manual solicitada...', 'system');
    setTimeout(() => { manualCheckBtn.disabled = false; manualCheckBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Enviar Recordatorios Ahora'; }, 2500);
});
autoToggle.addEventListener('change', (e) => {
    socket.emit('toggle_auto', e.target.checked); updateAutoStatusDisplay(e.target.checked);
    addLog(`Auto-envío ${e.target.checked ? 'ENCENDIDO' : 'APAGADO'}.`, e.target.checked ? 'success' : 'warning');
});
logoutBtn.addEventListener('click', () => { if (confirm('¿Cerrar sesión de WhatsApp?')) { socket.emit('logout'); updateUI('loading'); addLog('Cerrando sesión...', 'system'); } });
refreshBtn.addEventListener('click', () => { socket.emit('refresh_session'); addLog('Refrescando sesión...', 'system'); });
hourInput.addEventListener('change', updateCronTime);
minuteInput.addEventListener('change', updateCronTime);
periodInput.addEventListener('change', updateCronTime);
refreshPacientesBtn.addEventListener('click', () => {
    refreshPacientesBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; refreshPacientesBtn.disabled = true;
    socket.emit('get_pacientes');
    setTimeout(() => { refreshPacientesBtn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> Actualizar'; refreshPacientesBtn.disabled = false; }, 1500);
});
// ══════════════════════════════════════════════════════
//  DOCTOR PANEL — Config & State
// ══════════════════════════════════════════════════════
let botActivoState = false;
let modoViernesState = false;
const DOCTORES = [
    'C.D. Manuel Jesús Romani Maldonado',
    'C.D. Elio Elvis Támara Trinidad',
    'C.D. Jimy Aldo Osorio Rosales',
    'C.D. Fernando Fredy Bustamante Tolentino'
];
const DIAS_SEMANA = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
const HORAS_MANANA = ['07:45','08:30','09:15','10:00','10:45','11:30'];
const HORAS_TARDE = ['13:45','14:30','15:15','16:00','16:45','17:30'];
let doctorActual = 0;

function getData() { return JSON.parse(localStorage.getItem('panel_data') || '{}'); }
function saveData(d) { localStorage.setItem('panel_data', JSON.stringify(d)); }

async function loadBotConfig() {
    try {
        const r = await fetch('/config-bot'); if (r.ok) { const c = await r.json(); botActivoState = c.botActivo; modoViernesState = c.modoViernes || false; renderBotStatus(); renderModoViernes(); }
    } catch(e) {}
}
function renderBotStatus() {
    const btn = document.getElementById('btnActivarBot'); const txt = document.getElementById('botEstadoTexto');
    if (botActivoState) { txt.textContent = 'ACTIVO ✅'; txt.style.color = '#6EAD8C'; btn.textContent = '🛑 Desactivar'; btn.className = 'btn btn-danger'; }
    else { txt.textContent = 'INACTIVO ❌'; txt.style.color = '#C97A8A'; btn.textContent = '▶️ Activar'; btn.className = 'btn btn-primary'; }
}
async function toggleBot() {
    const nuevo = !botActivoState; const btn = document.getElementById('btnActivarBot');
    btn.textContent = 'Guardando...'; btn.disabled = true;
    try { const r = await fetch('/config-bot', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({botActivo:nuevo}) }); if (r.ok) { const d = await r.json(); botActivoState = d.botActivo; showDocAlert(botActivoState ? '✅ Bot activado' : '⚠️ Bot desactivado', botActivoState ? 'success' : 'error'); } }
    catch(e) { showDocAlert('❌ Error', 'error'); }
    renderBotStatus(); btn.disabled = false;
}
function renderModoViernes() {
    const btn = document.getElementById('btnModoViernes'); const txt = document.getElementById('viernesEstadoTexto');
    if (modoViernesState) { txt.textContent = 'ACTIVO 🟡'; txt.style.color = '#fbbf24'; btn.textContent = '❌ Desactivar Viernes'; btn.style.background = 'rgba(245,158,11,0.2)'; btn.style.color = '#fbbf24'; }
    else { txt.textContent = 'INACTIVO —'; txt.style.color = '#64748b'; btn.textContent = '📅 Activar Viernes'; btn.style.background = 'rgba(245,158,11,0.08)'; btn.style.color = '#f59e0b'; }
}
async function toggleModoViernes() {
    const nuevo = !modoViernesState; const btn = document.getElementById('btnModoViernes');
    btn.textContent = 'Guardando...'; btn.disabled = true;
    try { const r = await fetch('/config-bot', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({modoViernes:nuevo}) }); if (r.ok) { const d = await r.json(); modoViernesState = d.modoViernes; showDocAlert(modoViernesState ? '📅 Modo Viernes activado' : '✅ Modo Viernes desactivado', modoViernesState ? 'error' : 'success'); } }
    catch(e) { showDocAlert('❌ Error', 'error'); }
    renderModoViernes(); btn.disabled = false;
}

// ══════════════════════════════════════════════════════
//  DOCTOR PANEL — Horarios
// ══════════════════════════════════════════════════════
async function loadHorariosDelServidor() {
    try { const r = await fetch('/horarios-panel'); if (r.ok) { const h = await r.json(); localStorage.setItem('panel_data', JSON.stringify(h)); return h; } } catch(e) {}
    return getData();
}
function getDoctorData(doctor) { const data = getData(); if (!data[doctor]) data[doctor] = { dias:[true,true,true,true,true,false,false], horarios:{} }; return data[doctor]; }
function saveDoctorData(doctor, ddata) { const data = getData(); data[doctor] = ddata; saveData(data); }

function filtrarHoras() {
    const turno = document.getElementById('inputTurno').value;
    let horas; if (turno==='manana') horas=HORAS_MANANA; else if (turno==='tarde') horas=HORAS_TARDE; else horas=[...HORAS_MANANA,...HORAS_TARDE];
    document.getElementById('horasGrid').innerHTML = horas.map(h => `<button class="hora-btn" onclick="toggleHoraBtn(this)" data-hora="${h}">${formatHoraDoc(h)}</button>`).join('');
}
function toggleHoraBtn(btn) { btn.classList.contains('activo') ? (btn.classList.remove('activo'), btn.classList.add('inactivo')) : (btn.classList.remove('inactivo'), btn.classList.add('activo')); }
function seleccionarTodasHoras() { document.querySelectorAll('#horasGrid .hora-btn').forEach(b => { b.classList.remove('inactivo'); b.classList.add('activo'); }); }
function deseleccionarTodasHoras() { document.querySelectorAll('#horasGrid .hora-btn').forEach(b => { b.classList.remove('activo'); b.classList.add('inactivo'); }); }
function formatHoraDoc(h) { const [hh,mm] = h.split(':'); const n = parseInt(hh); return n < 12 ? `${h} AM` : `${n>12?n-12:12}:${mm} PM`; }
function formatFechaDoc(f) { if(!f) return ''; const [y,m,d] = f.split('-'); return `${d}/${m}/${y}`; }

function cambiarDoctor(idx) {
    doctorActual = idx;
    document.querySelectorAll('.doc-tab').forEach((t,i) => t.classList.toggle('active', i===idx));
    loadHorariosDelServidor().then(data => { renderPanel(data); });
}
function toggleDia(idx) {
    const btn = document.querySelectorAll('#diasGrid .dia-btn')[idx];
    btn.classList.contains('activo') ? (btn.classList.remove('activo'), btn.classList.add('inactivo')) : (btn.classList.remove('inactivo'), btn.classList.add('activo'));
}
function guardarDias() {
    const doctor = DOCTORES[doctorActual]; const ddata = getDoctorData(doctor);
    ddata.dias = Array.from(document.querySelectorAll('#diasGrid .dia-btn')).map(b => b.classList.contains('activo'));
    saveDoctorData(doctor, ddata); showDocAlert('✅ Días guardados', 'success');
    fetch('/guardar-horarios', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({doctor,dias:ddata.dias,horarios:ddata.horarios}) })
    .then(() => loadHorariosDelServidor().then(data => renderPanel(data))).catch(() => renderPanel(getData()));
}
function agregarHorario() {
    const fecha = document.getElementById('inputFecha').value;
    if (!fecha) { showDocAlert('⚠️ Selecciona fecha', 'error'); return; }
    const horasSel = []; document.querySelectorAll('#horasGrid .hora-btn.activo').forEach(b => horasSel.push(b.dataset.hora));
    if (!horasSel.length) { showDocAlert('⚠️ Selecciona horas', 'error'); return; }
    const doctor = DOCTORES[doctorActual]; const ddata = getDoctorData(doctor);
    if (!ddata.horarios[fecha]) ddata.horarios[fecha] = [];
    let n = 0; horasSel.forEach(h => { if (!ddata.horarios[fecha].includes(h)) { ddata.horarios[fecha].push(h); n++; } });
    if (!n) { showDocAlert('⚠️ Todas ya registradas', 'error'); return; }
    ddata.horarios[fecha].sort(); saveDoctorData(doctor, ddata);
    fetch('/guardar-horarios', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({doctor,dias:ddata.dias,horarios:ddata.horarios}) })
    .then(() => loadHorariosDelServidor().then(data => renderPanel(data))).catch(() => renderPanel(getData()));
    showDocAlert(`✅ ${n} horario(s) agregado(s)`, 'success'); deseleccionarTodasHoras();
}
function eliminarHorario(fecha, hora) {
    const doctor = DOCTORES[doctorActual]; const ddata = getDoctorData(doctor);
    ddata.horarios[fecha] = ddata.horarios[fecha].filter(h => h !== hora);
    if (!ddata.horarios[fecha].length) delete ddata.horarios[fecha];
    saveDoctorData(doctor, ddata);
    fetch('/guardar-horarios', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({doctor,dias:ddata.dias,horarios:ddata.horarios}) })
    .then(() => { loadHorariosDelServidor().then(data => renderPanel(data)); cargarEstadisticas(); showDocAlert('🗑️ Eliminado', 'success'); })
    .catch(() => { renderPanel(getData()); showDocAlert('🗑️ Eliminado (local)', 'success'); });
}

let confirmCallback = null;
function mostrarConfirmacion(titulo, mensaje, onConfirm) {
    document.getElementById('confirmModalTitle').innerText = titulo;
    document.getElementById('confirmModalText').innerText = mensaje;
    document.getElementById('confirmModal').style.display = 'flex';
    confirmCallback = onConfirm;
}

document.getElementById('confirmBtnNo').addEventListener('click', () => {
    document.getElementById('confirmModal').style.display = 'none';
    confirmCallback = null;
});

document.getElementById('confirmBtnYes').addEventListener('click', () => {
    document.getElementById('confirmModal').style.display = 'none';
    if(confirmCallback) confirmCallback();
    confirmCallback = null;
});

function limpiarPanelActual() {
    mostrarConfirmacion(
        'Limpiar Panel de Horarios', 
        'Vas a eliminar TODOS los horarios visuales del panel actual. Las citas agendadas NO se borrarán de la base de datos.',
        () => {
            const doctor = DOCTORES[doctorActual]; const ddata = getDoctorData(doctor);
            ddata.horarios = {}; // Vaciar todos los horarios
            saveDoctorData(doctor, ddata);
            
            fetch('/guardar-horarios', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doctor, dias: ddata.dias, horarios: ddata.horarios }) })
            .then(() => {
                loadHorariosDelServidor().then(data => renderPanel(data));
                cargarEstadisticas();
                showDocAlert('🗑️ Panel vaciado completamente', 'success');
            })
            .catch(() => {
                renderPanel(getData());
                showDocAlert('🗑️ Panel vaciado (local)', 'success');
            });
        }
    );
}

function renderPanel(dataDelServidor) {
    const data = dataDelServidor || getData(); const doctor = DOCTORES[doctorActual];
    const ddata = data[doctor] || { dias:[true,true,true,true,true,false,false], horarios:{} };
    const sub = document.getElementById('subtitleDoctor'); if (sub) sub.textContent = doctor;
    const diasGrid = document.getElementById('diasGrid');
    diasGrid.innerHTML = DIAS_SEMANA.map((d,i) => `<button class="dia-btn ${ddata.dias[i]?'activo':'inactivo'}" onclick="toggleDia(${i})">${d}</button>`).join('');
    const lista = document.getElementById('listaHorarios');
    const fechas = Object.keys(ddata.horarios).sort();
    if (!fechas.length) { lista.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:24px;font-size:0.85rem">No hay horarios registrados</p>'; return; }
    fetch(`/citas-doctor?doctor=${encodeURIComponent(doctor)}`).then(r=>r.json()).catch(()=>[]).then(citas => {
        const citaMap = {}; citas.forEach(c => { const fk = c.fecha.split('T')[0]; const hk = c.hora.substring(0,5); citaMap[`${fk}|${hk}`] = c; });
        let html = '';
        fechas.forEach(fecha => {
            const horas = ddata.horarios[fecha];
            const manana = horas.filter(h => HORAS_MANANA.includes(h));
            const tarde = horas.filter(h => HORAS_TARDE.includes(h));
            if (manana.length) { html += `<div class="turno-sep">🌅 Mañana — ${formatFechaDoc(fecha)}</div>`; manana.forEach(h => html += horaItem(fecha, h, citaMap[`${fecha}|${h}`])); }
            if (tarde.length) { html += `<div class="turno-sep">🌇 Tarde — ${formatFechaDoc(fecha)}</div>`; tarde.forEach(h => html += horaItem(fecha, h, citaMap[`${fecha}|${h}`])); }
        });
        lista.innerHTML = html;
    });
}
function horaItem(fecha, h, cita) {
    if (cita) {
        return `<div class="horario-item ocupado"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span class="badge-fecha">${formatFechaDoc(fecha)}</span><span class="badge-hora">${formatHoraDoc(h)}</span><span class="badge-ocupado">Ocupado</span><div><span class="paciente-nombre">👤 ${cita.nombre}</span><br><span class="paciente-detalle">DNI: ${cita.dni} · ${cita.edad} · ${cita.consultorio}</span></div></div><button class="btn-elim" onclick="eliminarHorario('${fecha}','${h}')" title="Eliminar horario"><i class="fa-solid fa-trash"></i></button></div>`;
    }
    return `<div class="horario-item"><div style="display:flex;align-items:center;gap:10px"><span class="badge-fecha">${formatFechaDoc(fecha)}</span><span class="badge-hora">${formatHoraDoc(h)}</span><span class="badge-libre">Disponible</span></div><button class="btn-elim" onclick="eliminarHorario('${fecha}','${h}')" title="Eliminar horario"><i class="fa-solid fa-trash"></i></button></div>`;
}

function showDocAlert(msg, tipo) {
    const el = document.getElementById('docAlert');
    el.textContent = msg; el.className = `doc-alert ${tipo}`; el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 3000);
}

// ══════════════════════════════════════════════════════
//  DOCTOR PANEL — Excel Export
// ══════════════════════════════════════════════════════
async function fetchCitasFiltradas() {
    const doctor = document.getElementById('filtroDoctor').value;
    const desde = document.getElementById('filtroDesde').value;
    const hasta = document.getElementById('filtroHasta').value;
    const estado = document.getElementById('filtroEstado').value;
    const docs = doctor ? [doctor] : DOCTORES;
    try {
        const panelData = getData();
        const results = await Promise.all(docs.map(d => fetch(`/citas-doctor?doctor=${encodeURIComponent(d)}`).then(r=>r.json()).catch(()=>[])));
        let citas = results.flat(); if (!Array.isArray(citas)) citas = [];
        // Filtrar solo citas que coincidan con horarios del panel
        citas = citas.filter(c => {
            const doc = c.doctor;
            const fechaKey = (c.fecha || '').split('T')[0];
            const horaKey = (c.hora || '').substring(0, 5);
            if (!panelData[doc] || !panelData[doc].horarios) return false;
            const horasEnPanel = panelData[doc].horarios[fechaKey];
            return horasEnPanel && horasEnPanel.includes(horaKey);
        });
        if (desde) citas = citas.filter(c => { try { return (c.fecha||'').split('T')[0] >= desde; } catch(e) { return false; } });
        if (hasta) citas = citas.filter(c => { try { return (c.fecha||'').split('T')[0] <= hasta; } catch(e) { return false; } });
        if (estado) citas = citas.filter(c => c.estado === estado);
        citas.sort((a,b) => { const fa = ((a.fecha||'').split('T')[0])+(a.hora||''); const fb = ((b.fecha||'').split('T')[0])+(b.hora||''); return fa > fb ? 1 : -1; });
        return citas;
    } catch(e) { return []; }
}
async function cargarEstadisticas() {
    try {
        const panelData = getData();
        const results = await Promise.all(DOCTORES.map(d => fetch(`/citas-doctor?doctor=${encodeURIComponent(d)}`).then(r=>r.json()).catch(()=>[])));
        let all = results.flat(); if (!Array.isArray(all)) all = [];
        // Filtrar solo citas que coincidan con horarios del panel
        all = all.filter(c => {
            const doc = c.doctor;
            const fechaKey = (c.fecha || '').split('T')[0];
            const horaKey = (c.hora || '').substring(0, 5);
            if (!panelData[doc] || !panelData[doc].horarios) return false;
            const horasEnPanel = panelData[doc].horarios[fechaKey];
            return horasEnPanel && horasEnPanel.includes(horaKey);
        });
        const conf = all.filter(c=>c.estado==='confirmada').length; const canc = all.filter(c=>c.estado==='cancelada').length; const comp = all.filter(c=>c.estado==='completada').length;
        document.getElementById('statsExport').innerHTML = `<span class="stat-pill-doc">📋 Total: ${all.length}</span><span class="stat-pill-doc" style="color:#6EAD8C">✅ ${conf}</span><span class="stat-pill-doc" style="color:#C97A8A">❌ ${canc}</span><span class="stat-pill-doc" style="color:#8EC5D0">🏁 ${comp}</span>`;
    } catch(e) {}
}
async function cargarPreviewCitas() {
    const preview = document.getElementById('previewCitas');
    if (preview.innerHTML && !preview.innerHTML.includes('Cargando')) { preview.innerHTML = ''; return; }
    preview.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:16px">Cargando...</p>';
    try {
        const citas = await fetchCitasFiltradas();
        if (!citas || !citas.length) { preview.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:16px">No hay citas</p>'; return; }
        let html = `<p style="font-size:0.78rem;color:var(--text-muted);margin-bottom:8px;font-weight:600">${citas.length} cita(s)</p><div style="overflow-x:auto"><table class="preview-table"><thead><tr><th>#</th><th>Paciente</th><th>DNI</th><th>Edad</th><th>Tel</th><th>Doctor</th><th>Fecha</th><th>Hora</th><th>Estado</th></tr></thead><tbody>`;
        citas.forEach((c,i) => {
            const f = c.fecha ? formatFechaDoc(c.fecha.split('T')[0]) : '-';
            const h = c.hora ? formatHoraDoc(c.hora.substring(0,5)) : '-';
            html += `<tr><td style="color:var(--text-muted)">${i+1}</td><td><strong>${c.nombre||'-'}</strong></td><td>${c.dni||'-'}</td><td>${c.edad||'-'}</td><td>${c.telefono||'-'}</td><td style="font-size:0.72rem">${c.doctor||'-'}</td><td>${f}</td><td>${h}</td><td>${c.estado||'-'}</td></tr>`;
        });
        html += '</tbody></table></div>'; preview.innerHTML = html;
    } catch(e) { preview.innerHTML = '<p style="color:#C97A8A;text-align:center;padding:16px">❌ Error</p>'; }
}
async function exportarExcel() {
    try {
        const citas = await fetchCitasFiltradas();
        if (!citas || !citas.length) { showDocAlert('⚠️ No hay citas', 'error'); return; }
        const filas = citas.map((c,i) => ({ 'N°':i+1, 'Paciente':c.nombre||'-', 'DNI':c.dni||'-', 'Edad':c.edad||'-', 'Teléfono':(() => { let t=(c.telefono||'').replace(/@c\.us/,'').replace(/\D/g,''); if(t.startsWith('51')&&t.length===11)t=t.slice(2); return t||'-'; })(), 'Consultorio':c.consultorio||'-', 'Doctor':c.doctor||'-', 'Servicio':c.servicio||'Consulta general', 'Fecha':c.fecha?formatFechaDoc(c.fecha.split('T')[0]):'-', 'Hora':c.hora?formatHoraDoc(c.hora.substring(0,5)):'-', 'Estado':c.estado||'-' }));
        const wb = XLSX.utils.book_new(); const ws = XLSX.utils.json_to_sheet(filas);
        ws['!cols'] = [{wch:5},{wch:28},{wch:12},{wch:7},{wch:15},{wch:22},{wch:38},{wch:18},{wch:12},{wch:12},{wch:13}];
        XLSX.utils.book_append_sheet(wb, ws, 'Citas');
        const fecha = new Date().toISOString().split('T')[0];
        const filtroDoc = document.getElementById('filtroDoctor').value;
        const sufijo = filtroDoc ? '_' + filtroDoc.split(' ').pop() : '_todos';
        XLSX.writeFile(wb, `citas_odontologia${sufijo}_${fecha}.xlsx`);
        showDocAlert(`✅ Excel exportado (${citas.length} citas)`, 'success');
    } catch(e) { showDocAlert('❌ Error al exportar', 'error'); }
}

// ══════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════
const hoy = new Date().toISOString().split('T')[0];
const inputFecha = document.getElementById('inputFecha');
if (inputFecha) { inputFecha.min = hoy; inputFecha.value = hoy; }
filtrarHoras();
loadBotConfig();
loadHorariosDelServidor().then(data => { renderPanel(data); cargarEstadisticas(); }).catch(() => { renderPanel(); cargarEstadisticas(); });
setInterval(cargarEstadisticas, 15000);

