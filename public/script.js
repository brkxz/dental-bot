const socket = io();

// --- DOM ELEMENTS ---
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
//  HELPERS
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
    const logoutStatus = document.getElementById('logoutStatus');
    const logoutConfirm = document.getElementById('logoutConfirm');
    if (logoutStatus) logoutStatus.classList.add('hidden');
    if (logoutConfirm) logoutConfirm.classList.add('hidden');
    connectionStatus.classList.remove('status-loading', 'status-qr', 'status-connected');

    const botStatusRec = document.getElementById('botStatusRecDisplay');

    if (status === 'connected') {
        connectionStatus.classList.add('status-connected'); statusText.textContent = 'Conectado';
        botInfo.classList.remove('hidden'); waStatusDisplay.textContent = 'Conectado'; waStatusDisplay.style.color = '#6EAD8C';
        if (botStatusRec) { botStatusRec.textContent = '✅ WhatsApp conectado'; botStatusRec.style.color = '#16A34A'; }
        // Auto-close QR modal when connected
        const modal = document.getElementById('qrModal');
        if (modal) modal.style.display = 'none';
    } else if (status === 'qr') {
        connectionStatus.classList.add('status-qr'); statusText.textContent = 'Escanear QR';
        qrContainer.classList.remove('hidden'); waStatusDisplay.textContent = 'QR Activo'; waStatusDisplay.style.color = '#fbbf24';
        if (botStatusRec) { botStatusRec.textContent = '📱 Escanea el QR'; botStatusRec.style.color = '#D97706'; }
        // Auto-open QR modal
        const modal = document.getElementById('qrModal');
        if (modal) modal.style.display = 'flex';
    } else if (status === 'closing') {
        connectionStatus.classList.add('status-loading'); statusText.textContent = 'Cerrando...';
        if (logoutStatus) logoutStatus.classList.remove('hidden');
        waStatusDisplay.textContent = 'Cerrando'; waStatusDisplay.style.color = '#DC2626';
        if (botStatusRec) { botStatusRec.textContent = '⏳ Cerrando sesión...'; botStatusRec.style.color = '#DC2626'; }
    } else {
        connectionStatus.classList.add('status-loading'); statusText.textContent = 'Iniciando...';
        loadingStatus.classList.remove('hidden'); waStatusDisplay.textContent = 'Iniciando'; waStatusDisplay.style.color = '#64748b';
        if (botStatusRec) { botStatusRec.textContent = '⏳ Iniciando...'; botStatusRec.style.color = '#64748b'; }
    }
}
function updateAutoStatusDisplay(isEnabled) {
    autoStatusDisplay.textContent = isEnabled ? 'Activo' : 'Pausado';
    autoStatusDisplay.style.color = isEnabled ? '#6EAD8C' : '#f59e0b';
}
function updateCronTime() {
    let h = parseInt(hourInput.value);
    let min = parseInt(minuteInput.value);
    if (isNaN(min) || min < 0) min = 0;
    if (min > 59) min = 59;
    const m = min.toString().padStart(2, '0');
    const period = periodInput.value;
    if (period === 'PM' && h < 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    socket.emit('set_cron_time', `${h.toString().padStart(2,'0')}:${m}`);
    const displayStr = `${hourInput.value.toString().padStart(2,'0')}:${m} ${period}`;
    cronTimeDisplay.textContent = `Diario a las ${displayStr}`;
    nextSendDisplay.textContent = displayStr;
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
        hourInput.value = h12.toString().padStart(2,'0');
        minuteInput.value = parseInt(m);
        periodInput.value = period;
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
        const enviadoBadge = p.enviado
            ? `<span class="badge-enviado" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:600;background:rgba(22,163,74,0.1);color:#16A34A;border:1px solid rgba(22,163,74,0.2);margin-right:6px"><i class="fa-solid fa-check-circle"></i> Enviado</span>`
            : '';
        tr.setAttribute('data-numero', p.numeroWs);
        tr.innerHTML = `<td><span style="font-weight:600">${p.nombre}</span></td><td style="color:#64748b"><i class="fa-brands fa-whatsapp" style="color:#6EAD8C;margin-right:5px"></i>+${p.numeroWs}</td><td><span class="badge-vacuna"><i class="fa-solid fa-tooth" style="font-size:0.7rem"></i> ${p.vacuna}</span></td><td style="color:#64748b">${p.fecha}</td><td class="text-right">${enviadoBadge}<button class="send-single-btn btn btn-ghost btn-sm" style="color:#6EAD8C;border-color:rgba(110,173,140,0.2);background:rgba(110,173,140,0.07)" data-paciente='${pds}'><i class="fa-solid fa-paper-plane"></i> Enviar</button></td>`;
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

// Actualización en tiempo real cuando un paciente es enviado (desde cualquier PC)
socket.on('paciente_enviado', (data) => {
    const row = document.querySelector(`tr[data-numero="${data.numeroWs}"]`);
    if (row) {
        const lastTd = row.querySelector('td:last-child');
        // Solo agregar badge si no existe ya
        if (lastTd && !lastTd.querySelector('.badge-enviado')) {
            const badge = document.createElement('span');
            badge.className = 'badge-enviado';
            badge.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:600;background:rgba(22,163,74,0.1);color:#16A34A;border:1px solid rgba(22,163,74,0.2);margin-right:6px';
            badge.innerHTML = '<i class="fa-solid fa-check-circle"></i> Enviado';
            lastTd.insertBefore(badge, lastTd.firstChild);
        }
    }
});

// ══════════════════════════════════════════════
//  ACTIONS
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
// ── Logout flow with custom confirmation ──
logoutBtn.addEventListener('click', () => {
    const logoutConfirm = document.getElementById('logoutConfirm');
    botInfo.classList.add('hidden');
    logoutConfirm.classList.remove('hidden');
});
document.getElementById('logoutCancelBtn').addEventListener('click', () => {
    document.getElementById('logoutConfirm').classList.add('hidden');
    botInfo.classList.remove('hidden');
});
document.getElementById('logoutConfirmBtn').addEventListener('click', () => {
    document.getElementById('logoutConfirm').classList.add('hidden');
    updateUI('closing');
    socket.emit('logout');
    addLog('Cerrando sesión de WhatsApp...', 'warning');
});
refreshBtn.addEventListener('click', () => { socket.emit('refresh_session'); addLog('Refrescando sesión...', 'system'); });
hourInput.addEventListener('change', updateCronTime);
minuteInput.addEventListener('change', updateCronTime);
periodInput.addEventListener('change', updateCronTime);refreshPacientesBtn.addEventListener('click', () => {
    refreshPacientesBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; refreshPacientesBtn.disabled = true;
    socket.emit('refresh_pacientes');
    setTimeout(() => { refreshPacientesBtn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> Actualizar'; refreshPacientesBtn.disabled = false; }, 1500);
});

// ══════════════════════════════════════════════
//  ENVIAR MENSAJE PERSONALIZADO
// ══════════════════════════════════════════════
const freePatientSelect = document.getElementById('freePatientSelect');
const freePatientInfo   = document.getElementById('freePatientInfo');
const freeMensaje       = document.getElementById('freeMensaje');
const freeSendBtn       = document.getElementById('freeSendBtn');
const freeMsgStatus     = document.getElementById('freeMsgStatus');
const freeMsgCharCount  = document.getElementById('freeMsgCharCount');
let pacientesCache = [];

// Llenar selector cuando llegan pacientes del servidor
socket.on('pacientes_data', (pacientes) => {
    pacientesCache = pacientes;
    freePatientSelect.innerHTML = '';
    if (pacientes.length === 0) {
        freePatientSelect.innerHTML = '<option value="" disabled selected>No hay pacientes para mañana</option>';
        freePatientInfo.textContent = '';
        return;
    }
    freePatientSelect.innerHTML = '<option value="" disabled selected>— Selecciona —</option>';
    pacientes.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `${p.nombre} — ${p.hora}`;
        freePatientSelect.appendChild(opt);
    });
    // Opción "Todos" al final
    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = `📋 Todos los pacientes (${pacientes.length})`;
    freePatientSelect.appendChild(allOpt);
});

// Mostrar info del paciente seleccionado
freePatientSelect.addEventListener('change', () => {
    const val = freePatientSelect.value;
    if (val === 'all') {
        freePatientInfo.innerHTML = `
            <span class="fpi-chip fpi-all"><i class="fa-solid fa-users"></i> ${pacientesCache.length} pacientes</span>
            <span class="fpi-chip fpi-treatment"><i class="fa-solid fa-circle-info"></i> Se enviará a todos</span>`;
    } else {
        const p = pacientesCache[parseInt(val)];
        if (p) {
            freePatientInfo.innerHTML = `
                <span class="fpi-chip fpi-phone"><i class="fa-brands fa-whatsapp"></i> +${p.numeroWs}</span>
                <span class="fpi-chip fpi-treatment"><i class="fa-solid fa-tooth"></i> ${p.vacuna}</span>
                <span class="fpi-chip fpi-time"><i class="fa-regular fa-clock"></i> ${p.fecha} · ${p.hora}</span>`;
        }
    }
});

// Contador de caracteres
freeMensaje.addEventListener('input', () => {
    const len = freeMensaje.value.length;
    freeMsgCharCount.textContent = `${len} carácter${len !== 1 ? 'es' : ''}`;
});

// Enviar con Ctrl+Enter
freeMensaje.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        freeSendBtn.click();
    }
});

// ══════════════════════════════════════════════
//  MODAL DE CONFIRMACIÓN
// ══════════════════════════════════════════════
const fmsgModal       = document.getElementById('fmsgConfirmModal');
const fmsgModalIcon   = document.getElementById('fmsgModalIcon');
const fmsgModalTitle  = document.getElementById('fmsgModalTitle');
const fmsgModalDesc   = document.getElementById('fmsgModalDesc');
const fmsgModalPreview = document.getElementById('fmsgModalPreview');
const fmsgModalCancel = document.getElementById('fmsgModalCancel');
const fmsgModalConfirm = document.getElementById('fmsgModalConfirm');
let modalCallback = null;

function showConfirmModal({ icon, iconClass, title, desc, preview, confirmText, confirmClass, onConfirm }) {
    fmsgModalIcon.innerHTML = `<i class="${icon}"></i>`;
    fmsgModalIcon.className = 'fmsg-modal-icon' + (iconClass ? ' ' + iconClass : '');
    fmsgModalTitle.textContent = title;
    fmsgModalDesc.innerHTML = desc;
    fmsgModalPreview.textContent = preview;
    fmsgModalConfirm.innerHTML = `<i class="fa-solid fa-check"></i> ${confirmText}`;
    fmsgModalConfirm.className = 'btn fmsg-modal-btn-confirm' + (confirmClass ? ' ' + confirmClass : '');
    modalCallback = onConfirm;
    fmsgModal.style.display = 'flex';
}
function closeModal() { fmsgModal.style.display = 'none'; }
fmsgModalCancel.addEventListener('click', () => { modalCallback = null; closeModal(); });
document.querySelector('.fmsg-modal-overlay').addEventListener('click', () => { modalCallback = null; closeModal(); });
fmsgModalConfirm.addEventListener('click', () => {
    const cb = modalCallback;
    modalCallback = null;
    closeModal();
    if (cb) cb();
});

// ══════════════════════════════════════════════
//  BOTÓN ENVIAR (único)
// ══════════════════════════════════════════════
freeSendBtn.addEventListener('click', () => {
    const val = freePatientSelect.value;
    const mensaje = freeMensaje.value.trim();

    if (!val) {
        showFreeStatus('⚠️ Selecciona un destinatario.', 'warning');
        freePatientSelect.focus();
        return;
    }
    if (!mensaje) {
        showFreeStatus('⚠️ Escribe un mensaje.', 'warning');
        freeMensaje.focus();
        return;
    }

    if (val === 'all') {
        // Enviar a todos
        showConfirmModal({
            icon: 'fa-solid fa-users',
            iconClass: 'icon-all',
            title: `Enviar a ${pacientesCache.length} pacientes`,
            desc: `Se enviará el mensaje a <strong>todos los pacientes</strong> de mañana.`,
            preview: mensaje,
            confirmText: 'Enviar a Todos',
            confirmClass: 'btn-purple',
            onConfirm: () => {
                setSending(true);
                socket.emit('send_free_message_all', { mensaje });
            }
        });
    } else {
        // Enviar a uno
        const paciente = pacientesCache[parseInt(val)];
        showConfirmModal({
            icon: 'fa-solid fa-paper-plane',
            title: `Enviar a ${paciente.nombre}`,
            desc: `Se enviará por WhatsApp a <strong>+${paciente.numeroWs}</strong>`,
            preview: mensaje,
            confirmText: 'Enviar',
            onConfirm: () => {
                setSending(true);
                socket.emit('send_free_message', { numero: paciente.numeroWs, mensaje });
            }
        });
    }
});

function setSending(on) {
    freeSendBtn.disabled = on;
    if (on) {
        freeSendBtn.classList.add('sending');
        freeSendBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        showFreeStatus('📤 Enviando...', 'info');
    } else {
        freeSendBtn.classList.remove('sending');
        freeSendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
    }
}

// Respuestas del servidor
socket.on('free_message_sent', (resp) => {
    setSending(false);
    if (resp.ok) {
        showFreeStatus(`✅ Mensaje enviado a +${resp.numero}`, 'success');
        freeMensaje.value = '';
        freeMsgCharCount.textContent = '0 caracteres';
    } else {
        showFreeStatus(`❌ ${resp.error}`, 'error');
    }
});

socket.on('free_message_all_done', (resp) => {
    setSending(false);
    if (resp.ok) {
        showFreeStatus(`✅ Enviado a ${resp.enviados}/${resp.total} pacientes`, 'success');
        freeMensaje.value = '';
        freeMsgCharCount.textContent = '0 caracteres';
    } else {
        showFreeStatus(`❌ ${resp.error}`, 'error');
    }
});

function showFreeStatus(msg, type) {
    freeMsgStatus.classList.remove('hidden', 'free-msg-success', 'free-msg-error', 'free-msg-warning', 'free-msg-info');
    freeMsgStatus.classList.add(`free-msg-${type}`);
    freeMsgStatus.innerHTML = msg;
    if (type === 'success') setTimeout(() => freeMsgStatus.classList.add('hidden'), 5000);
}
