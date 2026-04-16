// ── Manejadores globales de errores ────────────────────────────────────────
process.on('uncaughtException', (err) => { console.error('❌ [uncaughtException]:', err); });
process.on('unhandledRejection', (reason) => { console.error('❌ [unhandledRejection]:', reason); });

const { Client, LocalAuth } = require('whatsapp-web.js');
const { Pool } = require('pg');
const { google } = require('googleapis');
const cron = require('node-cron');
const credenciales = require('./credenciales.json');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

// ══════════════════════════════════════════════════════════════
//  CONFIGURACIÓN
// ══════════════════════════════════════════════════════════════
const SHEET_ID = '1FY_n_d8xUCjYbashyT4ueOH_id9jpob36yJ9N-Ww-pw';
const RANGO_DATOS = 'Sheet1!A2:D';
const HORARIOS_FILE = path.join(__dirname, 'horarios_panel.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const SUPABASE_URL = 'postgresql://postgres.qqjonozfvojwrenhdnzf:Barderos$1508@aws-0-us-west-2.pooler.supabase.com:5432/postgres';

// ══════════════════════════════════════════════════════════════
//  ESTADO GLOBAL
// ══════════════════════════════════════════════════════════════
const botState = {
    status: 'loading', qrData: null,
    autoRevisarEnabled: true, cronTime: '09:00'
};
let dailyCronJob = null;
let db;

function cargarConfig() {
    try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch (e) { console.error('Error config:', e); }
    return { botActivo: false, modoViernes: false };
}
function guardarConfig(data) {
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8'); }
    catch (e) { console.error('Error guardando config:', e); }
}
let botConfig = cargarConfig();

function cargarHorariosPanel() {
    try { if (fs.existsSync(HORARIOS_FILE)) return JSON.parse(fs.readFileSync(HORARIOS_FILE, 'utf8')); }
    catch (e) { console.error('Error horarios:', e); }
    return {};
}
function guardarHorariosPanel(data) {
    try { fs.writeFileSync(HORARIOS_FILE, JSON.stringify(data, null, 2), 'utf8'); }
    catch (e) { console.error('Error guardando horarios:', e); }
}
let horariosPanel = cargarHorariosPanel();
console.log('📅 Horarios cargados para', Object.keys(horariosPanel).length, 'doctor(es)');

// ══════════════════════════════════════════════════════════════
//  GOOGLE SHEETS (para recordatorios)
// ══════════════════════════════════════════════════════════════
const auth = new google.auth.GoogleAuth({
    credentials: { client_email: credenciales.client_email, private_key: credenciales.private_key },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const sheets = google.sheets({ version: 'v4', auth });

function getFechaManana() {
    const manana = new Date(); manana.setDate(manana.getDate() + 1);
    return `${String(manana.getDate()).padStart(2,'0')}/${String(manana.getMonth()+1).padStart(2,'0')}/${manana.getFullYear()}`;
}

async function obtenerPacientesManana() {
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGO_DATOS });
    const filas = response.data.values;
    if (!filas || filas.length === 0) return [];
    const fechaFiltro = getFechaManana();
    const pacientes = [];
    for (const fila of filas) {
        const [nombre, numRaw, vacuna, fecha] = fila;
        if (!nombre || !numRaw || !vacuna || !fecha) continue;
        if (fecha === fechaFiltro) {
            let numeroWs = String(numRaw).replace(/\D/g, '');
            if (!numeroWs.length) continue;
            if (numeroWs.length === 9) numeroWs = '51' + numeroWs;
            else if (!numeroWs.startsWith('51') && numeroWs.length < 11) numeroWs = '51' + numeroWs;
            pacientes.push({ nombre, numeroWs, vacuna, fecha });
        }
    }
    return pacientes;
}

// ══════════════════════════════════════════════════════════════
//  BASE DE DATOS SUPABASE (PostgreSQL Wrapper)
// ══════════════════════════════════════════════════════════════
async function connectDB() {
    db = new Pool({ connectionString: SUPABASE_URL, ssl: { rejectUnauthorized: false }, max: 20, idleTimeoutMillis: 30000 });
    db.on('error', (err) => console.error('⚠️ [Postgres Pool Error]:', err.message));
    console.log('✅ Conectado a Supabase (PostgreSQL)');
    
    db.execute = async (query, params = []) => {
        let pQuery = query;
        let index = 1;
        while(pQuery.includes('?')) {
            pQuery = pQuery.replace('?', '$' + index);
            index++;
        }
        
        // Traducir sintaxis MySQL a Postgres
        pQuery = pQuery.replace(/"confirmada"/g, "'confirmada'");
        if (pQuery.includes('ADD UNIQUE KEY')) pQuery = 'ALTER TABLE citas ADD CONSTRAINT uk_slot UNIQUE (fecha, hora, doctor)';

        try {
            const res = await db.query(pQuery, params);
            return [res.rows, res.fields];
        } catch (e) {
            if (e.code === '23505') e.code = 'ER_DUP_ENTRY';
            if (e.code === '42P07' || e.code === '42710') e.code = 'ER_DUP_KEYNAME';
            throw e;
        }
    };
    
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS citas (
                id SERIAL PRIMARY KEY,
                telefono VARCHAR(20),
                nombre VARCHAR(100),
                dni VARCHAR(15),
                edad VARCHAR(50),
                consultorio VARCHAR(50),
                doctor VARCHAR(100),
                servicio VARCHAR(100),
                fecha DATE,
                hora VARCHAR(10),
                estado VARCHAR(20),
                creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Tabla citas verificada en Supabase.');
    } catch(e) { console.error('Error creando tabla:', e.message); }

    try {
        await db.execute('ALTER TABLE citas ADD UNIQUE KEY uk_slot (fecha, hora, doctor)');
        console.log('✅ Migración: UNIQUE KEY uk_slot añadida');
    } catch (e) {
        if (e.code === 'ER_DUP_KEYNAME') console.log('ℹ️ UNIQUE KEY uk_slot verificada');
        else if (e.code === 'ER_DUP_ENTRY') console.warn('⚠️ Duplicados en BD ignorados al crear UNIQUE KEY');
        else console.warn('⚠️ Migración uk_slot omitida:', e.message);
    }

    try {
        await db.execute('CREATE INDEX IF NOT EXISTS idx_dni ON citas(dni)');
        console.log('⚡ Indexación masiva: Índice DNI configurado.');
    } catch(e) { console.warn('⚠️ Configuración index DNI:', e.message); }
}

// ══════════════════════════════════════════════════════════════
//  SERVIDOR WEB (Express + Socket.IO)
// ══════════════════════════════════════════════════════════════
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ruta panel de doctores
app.get('/panel', (req, res) => {
    res.redirect('/');
});

// API: Guardar horarios
app.post('/guardar-horarios', (req, res) => {
    try {
        const datos = req.body;
        horariosPanel[datos.doctor] = { dias: datos.dias, horarios: datos.horarios };
        guardarHorariosPanel(horariosPanel);
        res.json({ ok: true });
    } catch (e) { res.json({}); }
});

// API: Citas por doctor
app.get('/citas-doctor', async (req, res) => {
    const doctor = req.query.doctor;
    if (!db) return res.json([]);
    try {
        const [rows] = await db.execute(
            'SELECT telefono,nombre,dni,edad,consultorio,doctor,servicio,fecha,hora,estado,creado_en FROM citas WHERE doctor=? ORDER BY fecha,hora',
            [doctor]
        );
        res.json(rows);
    } catch (e) { res.json([]); }
});

// API: Horarios panel
app.get('/horarios-panel', (req, res) => { res.json(horariosPanel); });

// API: Config bot
app.get('/config-bot', (req, res) => { res.json(botConfig); });
app.post('/config-bot', (req, res) => {
    try {
        const datos = req.body;
        if (datos.botActivo !== undefined) botConfig.botActivo = datos.botActivo;
        if (datos.modoViernes !== undefined) botConfig.modoViernes = datos.modoViernes;
        guardarConfig(botConfig);
        res.json({ ok: true, botActivo: botConfig.botActivo, modoViernes: botConfig.modoViernes });
    } catch (e) { res.json({}); }
});

server.listen(3000, () => {
    console.log('✅ Servidor Web iniciado.');
    console.log('👉 Panel Unificado Administrador: http://localhost:3000');
});

// ══════════════════════════════════════════════════════════════
//  SOCKET.IO (para panel de recordatorios)
// ══════════════════════════════════════════════════════════════
function emitLog(msg, type = 'info') {
    io.emit('log', { msg, type });
    console.log(`[${type.toUpperCase()}] ${msg}`);
}
function updateStatus(newStatus) {
    botState.status = newStatus;
    io.emit('status', newStatus);
}

io.on('connection', (socket) => {
    socket.emit('config', { autoRevisarEnabled: botState.autoRevisarEnabled, cronTime: botState.cronTime });
    socket.emit('status', botState.status);
    if (botState.status === 'qr' && botState.qrData) socket.emit('qr', botState.qrData);

    socket.on('manual_check', () => {
        emitLog('Revisión manual desde el panel.', 'system');
        revisarYEnviarRecordatorios();
    });
    socket.on('toggle_auto', (isEnabled) => {
        botState.autoRevisarEnabled = isEnabled;
        emitLog(`Auto-Envío ${isEnabled ? 'HABILITADO' : 'DESHABILITADO'}.`, isEnabled ? 'success' : 'warning');
    });
    socket.on('set_cron_time', (timeStr) => {
        botState.cronTime = timeStr;
        emitLog(`Hora de envío actualizada a ${timeStr}`, 'success');
        programarCron();
        io.emit('config', { autoRevisarEnabled: botState.autoRevisarEnabled, cronTime: botState.cronTime });
    });
    socket.on('get_pacientes', async () => {
        try {
            const pacientes = await obtenerPacientesManana();
            socket.emit('pacientes_data', pacientes);
        } catch (e) { emitLog('Error al cargar pacientes: ' + e.message, 'error'); }
    });
    socket.on('send_to_patient', async (paciente) => {
        if (botState.status !== 'connected') return emitLog('Bot no conectado.', 'error');
        emitLog(`Enviando recordatorio a ${paciente.nombre}...`, 'info');
        try {
            const mensaje = `Hola *${paciente.nombre}*, le recordamos que tiene una cita odontológica de *${paciente.vacuna}* programada para el día *${paciente.fecha}*. Por favor, acuda puntualmente a nuestra clínica dental. ¡Le esperamos! 🦷`;
            await sendMessageWithRetry(`${paciente.numeroWs}@c.us`, mensaje);
            emitLog(`Recordatorio enviado a ${paciente.nombre}.`, 'success');
        } catch (error) { emitLog(`Error: ${error.message}`, 'error'); }
    });
    socket.on('logout', async () => {
        emitLog('Cerrando sesión de WhatsApp...', 'warning');
        try { await client.logout(); updateStatus('loading'); }
        catch (e) { emitLog('Error: ' + e.message, 'error'); process.exit(0); }
    });
    socket.on('refresh_session', async () => {
        emitLog('Refrescando sesión...', 'system');
        try {
            if (client.pupPage) { await client.pupPage.reload(); emitLog('Sesión refrescada.', 'success'); }
            else emitLog('Página no activa.', 'error');
        } catch (e) { emitLog('Error: ' + e.message, 'error'); }
    });
});

// ══════════════════════════════════════════════════════════════
//  CRON & RECORDATORIOS
// ══════════════════════════════════════════════════════════════
function programarCron() {
    if (dailyCronJob) dailyCronJob.stop();
    const [hour, minute] = botState.cronTime.split(':');
    dailyCronJob = cron.schedule(`${Number(minute)} ${Number(hour)} * * *`, () => {
        if (botState.autoRevisarEnabled) {
            emitLog(`Revisión Diaria Automática (${botState.cronTime})...`, 'system');
            revisarYEnviarRecordatorios();
        }
    });
}

async function sendMessageWithRetry(chatId, mensaje, maxRetries = 2) {
    for (let i = 0; i <= maxRetries; i++) {
        try { await client.sendMessage(chatId, mensaje); return true; }
        catch (error) {
            const isDetached = error.message.includes('detached Frame') || error.message.includes('Execution context');
            if (isDetached && i < maxRetries) {
                emitLog(`Reintento ${i+1}/${maxRetries}...`, 'warning');
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            throw error;
        }
    }
}

async function revisarYEnviarRecordatorios() {
    if (botState.status !== 'connected') return emitLog('Bot no conectado.', 'error');
    emitLog('Buscando citas odontológicas...', 'info');
    try {
        const fechaFiltro = getFechaManana();
        const pacientes = await obtenerPacientesManana();
        if (pacientes.length === 0) return emitLog(`No hay citas para: ${fechaFiltro}`, 'info');
        emitLog(`Citas encontradas para ${fechaFiltro}: ${pacientes.length}`, 'info');
        let envios = 0;
        for (const p of pacientes) {
            const mensaje = `Hola *${p.nombre}*, le recordamos que tiene una cita odontológica de *${p.vacuna}* programada para el día *${p.fecha}*. Por favor, acuda puntualmente. ¡Le esperamos! 🦷`;
            emitLog(`Enviando a: ${p.nombre} (${p.numeroWs})`, 'info');
            await new Promise(r => setTimeout(r, 3000));
            try { await sendMessageWithRetry(`${p.numeroWs}@c.us`, mensaje); emitLog(`Enviado a ${p.nombre}.`, 'success'); envios++; }
            catch (error) { emitLog(`Fallo: ${p.nombre}: ${error.message}`, 'error'); }
        }
        emitLog(`Finalizado. Procesados: ${pacientes.length} | Enviados: ${envios}`, 'system');
    } catch (error) { emitLog('Error grave: ' + error.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
//  CHATBOT — Datos de doctores
// ══════════════════════════════════════════════════════════════
const doctoresGeneral = [
    'C.D. Manuel Jesús Romani Maldonado',
    'C.D. Elio Elvis Támara Trinidad',
    'C.D. Fernando Fredy Bustamante Tolentino'
];
const doctoresPediatria = [
    'C.D. Manuel Jesús Romani Maldonado',
    'C.D. Jimy Aldo Osorio Rosales',
    'C.D. Fernando Fredy Bustamante Tolentino'
];

const userState = {};
const reservasTemp = {};
const userQueues = {};
const mensajesProcesados = new Set();

function claveReserva(fecha, hora, doctor) { return `${fecha}|${hora}|${doctor}`; }
function liberarReserva(clave) {
    if (reservasTemp[clave]) { clearTimeout(reservasTemp[clave].timer); delete reservasTemp[clave]; }
}
function crearReserva(clave, phone, chatId, onVencer) {
    if (reservasTemp[clave] && reservasTemp[clave].phone !== phone) return false;
    if (reservasTemp[clave]) clearTimeout(reservasTemp[clave].timer);
    const timer = setTimeout(() => { delete reservasTemp[clave]; onVencer(); }, 60000);
    reservasTemp[clave] = { phone, chatId, timer };
    return true;
}
function encolar(phone, fn) {
    if (!userQueues[phone]) userQueues[phone] = Promise.resolve();
    const cola = userQueues[phone].then(fn).catch(e => console.error(`[Queue ${phone}]:`, e))
        .finally(() => { if (userQueues[phone] === cola) delete userQueues[phone]; });
    userQueues[phone] = cola;
}
function replyConTimeout(msg, text, timeoutMs = 15000) {
    if (!text) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        msg.reply(text).then(r => { clearTimeout(timer); resolve(r); }).catch(e => { clearTimeout(timer); reject(e); });
    });
}

// ══════════════════════════════════════════════════════════════
//  CHATBOT — Funciones auxiliares
// ══════════════════════════════════════════════════════════════
function formatFechaBot(f) {
    if (!f) return '';
    if (f instanceof Date) {
        return `${String(f.getDate()).padStart(2,'0')}/${String(f.getMonth()+1).padStart(2,'0')}/${f.getFullYear()}`;
    }
    const str = String(f).split('T')[0];
    const [y, m, d] = str.split('-');
    return `${d}/${m}/${y}`;
}
function formatHoraBot(h) {
    if (!h) return '';
    const horaStr = String(h).substring(0, 5);
    const [hh, mm] = horaStr.split(':');
    const n = parseInt(hh);
    return n < 12 ? `${horaStr} AM` : `${n > 12 ? n - 12 : 12}:${mm} PM`;
}

async function getFechasDisponibles(doctor) {
    if (!db) return { fechas: [], texto: '' };
    const panel = horariosPanel[doctor];
    if (!panel || !panel.horarios || !Object.keys(panel.horarios).length) return { fechas: [], texto: '' };
    const ahoraUtc = new Date();
    const ahoraLima = new Date(ahoraUtc.getTime() - 5 * 60 * 60 * 1000);
    const hoyLima = ahoraLima.toISOString().split('T')[0];
    const horaAhoraLima = String(ahoraLima.getUTCHours()).padStart(2,'0') + ':' + String(ahoraLima.getUTCMinutes()).padStart(2,'0');
    const mapDia = [1,2,3,4,5,6,0];
    const todasFechas = Object.keys(panel.horarios).filter(f => {
        if (f < hoyLima) return false;
        if (!panel.horarios[f] || !panel.horarios[f].length) return false;
        if (panel.dias) {
            const diaSemana = new Date(f + 'T12:00:00').getDay();
            const idxPanel = mapDia.indexOf(diaSemana);
            if (idxPanel !== -1 && !panel.dias[idxPanel]) return false;
        }
        return true;
    }).sort();
    const fechasConLibres = [];
    for (const fecha of todasFechas) {
        const horasPanel = panel.horarios[fecha];
        const [ocupadas] = await db.execute('SELECT hora FROM citas WHERE fecha=? AND doctor=? AND estado="confirmada"', [fecha, doctor]);
        const ocupadasList = ocupadas.map(r => r.hora.substring(0, 5));
        const libres = horasPanel.filter(h => {
            if (ocupadasList.includes(h)) return false;
            if (fecha === hoyLima && h <= horaAhoraLima) return false;
            return true;
        });
        if (libres.length > 0) fechasConLibres.push(fecha);
    }
    let texto = '';
    fechasConLibres.forEach((f, i) => { texto += `${i + 1}. ${formatFechaBot(f)}\n`; });
    return { fechas: fechasConLibres, texto };
}

async function getHorasDisponiblesPanel(fecha, doctor) {
    if (!db) return { horas: [], texto: '' };
    const panel = horariosPanel[doctor];
    if (!panel || !panel.horarios || !panel.horarios[fecha]) return { horas: [], texto: '' };
    const todasHoras = panel.horarios[fecha];
    const [ocupadas] = await db.execute('SELECT hora FROM citas WHERE fecha=? AND doctor=? AND estado="confirmada"', [fecha, doctor]);
    const ocupadasList = ocupadas.map(r => r.hora.substring(0, 5));
    const _ahoraUtc = new Date();
    const _ahoraLima = new Date(_ahoraUtc.getTime() - 5 * 60 * 60 * 1000);
    const _hoyLima = _ahoraLima.toISOString().split('T')[0];
    const _horaAhoraLima = String(_ahoraLima.getUTCHours()).padStart(2,'0') + ':' + String(_ahoraLima.getUTCMinutes()).padStart(2,'0');
    const HORAS_M = ['07:45','08:30','09:15','10:00','10:45','11:30'];
    const manana = todasHoras.filter(h => HORAS_M.includes(h) && !ocupadasList.includes(h) && !(fecha === _hoyLima && h <= _horaAhoraLima));
    const tarde = todasHoras.filter(h => !HORAS_M.includes(h) && !ocupadasList.includes(h) && !(fecha === _hoyLima && h <= _horaAhoraLima));
    const horas = [...manana, ...tarde];
    let textoFinal = ''; let idx = 1;
    if (manana.length) { textoFinal += `🌅 *Turno Mañana*\n`; manana.forEach(h => { textoFinal += ` ${idx++}. ${formatHoraBot(h)} ✅\n`; }); }
    if (tarde.length) { textoFinal += `\n🌇 *Turno Tarde*\n`; tarde.forEach(h => { textoFinal += ` ${idx++}. ${formatHoraBot(h)} ✅\n`; }); }
    return { horas, texto: textoFinal };
}

async function getBienvenida(botActivoOverride = true) {
    let avisos = ''; let hayAlgunasCitas = false;
    if (botActivoOverride) {
        let hayGeneral = false;
        for (const doc of doctoresGeneral) { const fm = await getFechasDisponibles(doc); if (fm.fechas.length > 0) { hayGeneral = true; break; } }
        avisos += hayGeneral ? `\n\n✅ *Hay citas disponibles para Odontología General.*` : `\n\n⚠️ *No hay citas disponibles para Odontología General.*`;
        if (hayGeneral) hayAlgunasCitas = true;
        let hayPediatria = false;
        for (const doc of doctoresPediatria) { const fm = await getFechasDisponibles(doc); if (fm.fechas.length > 0) { hayPediatria = true; break; } }
        avisos += hayPediatria ? `\n\n✅ *Hay citas disponibles para Odontopediatría.*` : `\n\n⚠️ *No hay citas disponibles para Odontopediatría.*`;
        if (hayPediatria) hayAlgunasCitas = true;
    }
    if (!botActivoOverride || !hayAlgunasCitas) {
        if (!botActivoOverride && botConfig.modoViernes) {
            return `🦷 *Bienvenido al servicio de Odontología* 🦷\n\n👋 Hola, gracias por escribirnos.\n\n🕐 El bot está *desactivado* por el momento. Las citas se habilitan los *viernes a las 7:30 a.m.*\n\n⏳ ¡Escríbenos *hoy mismo a las 7:30 a.m.* para reservar tu cita!\n\n*Gracias por tu paciencia.*`;
        }
        return `🦷 *Bienvenido al servicio de Odontología* 🦷\n\n👋 Hola, lo sentimos mucho pero ya no contamos con citas.${avisos}\n\n📞 *¡Escríbanos por favor el próximo viernes a las 7:30!*\n\n*Gracias por su comprensión.*`;
    }
    return `🦷 *Bienvenido al servicio de Odontología* 🦷\n\n👋 ¡Hola! Nos alegra atenderte.${avisos}\n\nPara registrar tu cita escribe los *nombres y apellidos* del paciente:`;
}

async function agendarCita(telefono, nombre, dni, edad, consultorio, doctor, servicio, fecha, hora) {
    let telLimpio = telefono.replace('@c.us', '').replace(/\D/g, '');
    if (telLimpio.startsWith('51') && telLimpio.length === 11) telLimpio = telLimpio.slice(2);
    await db.execute('INSERT INTO citas (telefono,nombre,dni,edad,consultorio,doctor,servicio,fecha,hora,estado) VALUES (?,?,?,?,?,?,?,?,?,"confirmada")',
        [telLimpio, nombre, dni, edad, consultorio, doctor, servicio || 'Consulta general', fecha, hora]);
}

async function verificarDisponibilidad(fecha, hora, doctor, phoneActual) {
    const [r] = await db.execute('SELECT id FROM citas WHERE fecha=? AND hora=? AND doctor=? AND estado="confirmada"', [fecha, hora, doctor]);
    if (r.length > 0) return false;
    const clave = claveReserva(fecha, hora, doctor);
    if (reservasTemp[clave] && reservasTemp[clave].phone !== phoneActual) return false;
    return true;
}

// ══════════════════════════════════════════════════════════════
//  WHATSAPP BOT (único para chatbot + recordatorios)
// ══════════════════════════════════════════════════════════════
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        headless: true, 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions'
        ] 
    }
});

let lastQrTime = 0;

client.on('qr', async (qr) => {
    // Prevent QR spam if it's restarting too fast
    const now = Date.now();
    if (now - lastQrTime < 10000) return; // Only process QR every 10s max
    lastQrTime = now;

    try {
        const qrImage = await qrcode.toDataURL(qr);
        botState.qrData = qrImage;
        updateStatus('qr');
        io.emit('qr', qrImage);
        emitLog('Nuevo QR generado. Escanéalo en el Panel.', 'warning');
        qrcodeTerminal.generate(qr, { small: true });
    } catch (err) { console.error('Error QR:', err); }
});

client.on('ready', () => {
    updateStatus('connected');
    emitLog('¡WhatsApp Bot vinculado y Listo!', 'success');
    botState.qrData = null;
    programarCron();
});

client.on('disconnected', async (reason) => {
    emitLog(`WhatsApp desconectado: ${reason}`, 'error');
    updateStatus('loading');
    try { await client.destroy(); } catch(e) {}
    
    setTimeout(() => {
        emitLog('Reconectando después de desconexión...', 'system');
        client.initialize().catch(e => console.error('Error re-inicializando:', e));
    }, 5000);
});

client.on('auth_failure', () => {
    emitLog('Error de autenticación.', 'error');
    updateStatus('loading');
    const sessionPath = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════
//  CHATBOT — Manejo de mensajes (flujo completo de citas)
//  Archivo separado para mantener limpio: chatbot_handler.js
// ══════════════════════════════════════════════════════════════
client.on('message', (msg) => {
    if (msg.from === 'status@broadcast') return;
    if (msg.isGroupMsg) return;

    const msgId = msg.id._serialized || msg.id.id || JSON.stringify(msg.id);
    if (mensajesProcesados.has(msgId)) return;
    mensajesProcesados.add(msgId);
    setTimeout(() => mensajesProcesados.delete(msgId), 30000);

    const phone = msg.from.replace(/@.*$/, '');

    encolar(phone, async () => {
        try {
            const text = (msg.body || '').trim();
            if (!text && msg.hasMedia) return; // Ignorar archivos multimedia sin texto
            console.log(`📩 ${phone}: ${text}`);

            // Detección de "adicional"
            const textNorm = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            if (textNorm.includes('adicional')) {
                await msg.reply(`🚨 *Cupos Adicionales - Servicio de Odontología*\n\n📍 Los cupos adicionales se entregan de manera *presencial* todos los días en el consultorio de Odontología, a las *7:00 a.m.*, a las *dos primeras personas* en llegar.\n\n⚠️ *Ten en cuenta:*\n• Estos pacientes serán atendidos *después* de los pacientes con cita previa.\n\n🙏 Agradecemos mucho tu comprensión.`);
                return;
            }

            let esNuevo = !userState[phone];
            if (!userState[phone]) userState[phone] = { step: 'pedir_nombre', data: {} };
            const state = userState[phone];
            let response = '';

            // Bot desactivado
            if (!botConfig.botActivo && state.step !== 'sin_citas' && !['menu','0','cancelar','hola','cita'].includes(text.toLowerCase())) {
                userState[phone] = { step: 'sin_citas', data: {} };
                const msgB = await getBienvenida(false);
                await msg.reply(msgB);
                await msg.reply(`🚨 *Para casos de URGENCIA, sugerimos solicitar un cupo adicional.*\n\n📍 Los cupos adicionales se entregan de manera presencial todos los días en el consultorio de Odontología, a las *7:00 a.m.*, a las dos primeras personas en llegar.\n\n⚠️ *Ten en cuenta:*\n• Estos pacientes serán atendidos después de los pacientes con cita previa.\n\n🙏 Agradecemos mucho tu comprensión.`);
                return;
            }

            if (botConfig.botActivo && state.step === 'sin_citas') {
                userState[phone] = { step: 'pedir_nombre', data: {} };
                state.step = 'pedir_nombre';
                esNuevo = true;
            }

            if (state.step === 'sin_citas') {
                const msgB = botConfig.modoViernes
                    ? `🦷 *Bienvenido al servicio de Odontología* 🦷\n\n👋 Hola, gracias por escribirnos.\n\n🕐 El bot está *desactivado* por el momento. Las citas se habilitan los *viernes a las 7:30 a.m.*\n\n⏳ ¡Escríbenos *hoy mismo a las 7:30 a.m.* para reservar tu cita!\n\n*Gracias por tu paciencia.*`
                    : `🦷 *Bienvenido al servicio de Odontología* 🦷\n\n👋 Hola, lo sentimos mucho pero *ya no contamos con citas disponibles.*\n\n📞 *¡Escríbenos por favor el próximo viernes a las 7:30 a.m.!*\n\n*Gracias por su comprensión.*`;
                await msg.reply(msgB);
                response = `🚨 *Para casos de URGENCIA, sugerimos solicitar un cupo adicional.*\n\n📍 Los cupos adicionales se entregan de manera presencial todos los días en el consultorio de Odontología, a las *7:00 a.m.*, a las dos primeras personas en llegar.\n\n⚠️ *Ten en cuenta:*\n• Estos pacientes serán atendidos después de los pacientes con cita previa.\n\n🙏 Agradecemos mucho tu comprensión.`;
            }
            else if (state.step === 'completado' && !['menu','0','cita'].includes(text.toLowerCase())) {
                response = `✨ *¡Gracias por confiar en servicio de Odontología!* ✨\n\nNos sentimos felices de cuidar tu sonrisa. Tu cita ya está agendada y registrada en nuestro sistema.\n\n👨‍⚕️ Nos vemos el día de tu consulta. ¡Que tengas un excelente día!\n\n_(Si deseas agendar otra cita, escribe *CITA* para empezar de nuevo)_`;
            }
            else if (text.toUpperCase() === 'CANCELAR') {
                response = `❌ *Se ha cancelado el registro de cita.*\n\nEscribe *CITA* para comenzar nuevamente o *MENU* para ver todas las opciones.`;
                userState[phone] = { step: 'pedir_nombre', data: {} };
            }
            else if (esNuevo || ['menu','0','hola','cita','buenas','buenos dias','buenas tardes','buenas noches'].includes(text.toLowerCase())) {
                let hayAlgunasCitas = false;
                if (botConfig.botActivo) {
                    for (const doc of doctoresGeneral) { const fm = await getFechasDisponibles(doc); if (fm.fechas.length > 0) { hayAlgunasCitas = true; break; } }
                    if (!hayAlgunasCitas) { for (const doc of doctoresPediatria) { const fm = await getFechasDisponibles(doc); if (fm.fechas.length > 0) { hayAlgunasCitas = true; break; } } }
                }
                userState[phone] = hayAlgunasCitas ? { step: 'pedir_nombre', data: {} } : { step: 'sin_citas', data: {} };
                response = await getBienvenida(botConfig.botActivo);
            }
            else if (state.step === 'pedir_nombre') {
                const soloLetras = /^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\s.]+$/;
                if (!soloLetras.test(text)) {
                    response = '❌ El nombre solo debe contener *letras*, sin números ni caracteres especiales.\n\n📝 *Ejemplo correcto:* Juan Pérez García\n❌ *Ejemplo incorrecto:* Ju4n P3rez 123\n\nPor favor, escribe tu *Nombre y Apellido* nuevamente:';
                } else if (text.length < 5 || !text.trim().includes(' ')) {
                    response = '❌ Por favor, escribe tu *Nombre y Apellido* completo:\n\n*Ejemplo:* Juan Pérez García';
                } else {
                    userState[phone].data.nombre = text;
                    response = `Hola *${text}* 😊\n\n🪪 Escribe tu *DNI* (8 dígitos):`;
                    userState[phone].step = 'pedir_dni';
                }
            }
            else if (state.step === 'pedir_dni') {
                if (!/^\d{8}$/.test(text)) {
                    response = '❌ El *DNI* debe tener exactamente *8 números*.\n\nPor favor, inténtalo de nuevo:';
                } else if (!db) {
                    response = '❌ *Error de conexión con el sistema.* Por favor inténtalo de nuevo más tarde.';
                    userState[phone] = { step: 'pedir_nombre', data: {} };
                } else {
                    const [citaExistente] = await db.execute('SELECT nombre, doctor, fecha, hora FROM citas WHERE dni=? AND estado="confirmada" LIMIT 1', [text]);
                    if (citaExistente.length > 0) {
                        const cita = citaExistente[0];
                        response = `⚠️ *El paciente con DNI ${text} ya tiene una cita registrada:*\n\n👤 *Paciente:* ${cita.nombre}\n👨‍⚕️ *Doctor:* ${cita.doctor}\n📅 *Fecha:* ${formatFechaBot(cita.fecha)}\n⏰ *Hora:* ${formatHoraBot(cita.hora)}\n\nNo es posible registrar otra cita con el mismo DNI.\n\n👉 Escribe *CITA* para agendar con otro paciente.`;
                        userState[phone] = { step: 'pedir_nombre', data: {} };
                    } else {
                        userState[phone].data.dni = text;
                        response = `✅ ¡Anotado!\n\n🎂 ¿Cuántos años tiene el paciente?`;
                        userState[phone].step = 'pedir_edad';
                    }
                }
            }
            else if (state.step === 'pedir_edad') {
                let textLow = text.toLowerCase().trim();
                let ageYears = 0;
                let ageStr = text.trim();
                let valid = true;

                if (/^\d+$/.test(textLow)) {
                    ageYears = parseInt(textLow);
                    ageStr = ageYears + " años";
                    if (ageYears <= 0 || ageYears > 120) valid = false;
                } else {
                    let matchM = textLow.match(/(\d+)\s*(mes)/);
                    let matchA = textLow.match(/(\d+)\s*(año|ano)/);
                    let m = matchM ? parseInt(matchM[1]) : 0;
                    let a = matchA ? parseInt(matchA[1]) : 0;
                    
                    if (m === 0 && a === 0) {
                        let num = textLow.match(/(\d+)/);
                        if (num) {
                             ageYears = parseInt(num[1]);
                             ageStr = ageYears + " años";
                             if (ageYears <= 0 || ageYears > 120) valid = false;
                        } else {
                             valid = false;
                        }
                    } else {
                        ageYears = a;
                        if (ageYears > 120) valid = false;
                        let partes = [];
                        if (a > 0) partes.push(a + (a === 1 ? ' año' : ' años'));
                        if (m > 0) partes.push(m + (m === 1 ? ' mes' : ' meses'));
                        ageStr = partes.join(' y ');
                    }
                }

                if (!valid) {
                    response = '❌ Por favor, escribe una *edad válida* (ej. "11 meses", "1 año y 2 meses", o solo el número en años):';
                } else {
                    userState[phone].data.edad = ageStr;
                    const esPediatria = ageYears <= 11;
                    const consultorio = esPediatria ? 'Odontopediatría' : 'Odontología General';
                    const doctoresCons = esPediatria ? doctoresPediatria : doctoresGeneral;
                    const emoji = esPediatria ? '👶' : '🦷';
                    const doctoresDisponibles = [];
                    for (const doc of doctoresCons) { const fm = await getFechasDisponibles(doc); if (fm.fechas.length > 0) doctoresDisponibles.push(doc); }
                    userState[phone].data.consultorio = consultorio;
                    userState[phone].data.doctores = doctoresDisponibles;
                    if (doctoresDisponibles.length === 0) {
                        response = `Con *${ageStr}*, te atendemos en:\n\n${emoji} *Consultorio de ${consultorio}*\n\n😔 Lo sentimos, *ya no contamos con citas disponibles*.\n\n📞 ¡Escríbenos el próximo *viernes a las 7:30 a.m.*!`;
                        userState[phone] = { step: 'sin_citas', data: {} };
                    } else if (doctoresDisponibles.length === 1) {
                        const docUnico = doctoresDisponibles[0];
                        userState[phone].data.doctor = docUnico;
                        userState[phone].data.servicio = 'Consulta general';
                        const fechasMsg = await getFechasDisponibles(docUnico);
                        userState[phone].data.fechasOpciones = fechasMsg.fechas;
                        response = `Con *${ageStr}*, te atendemos en:\n\n${emoji} *Consultorio de ${consultorio}*\n\n👨‍⚕️ Doctor: *${docUnico}*\n\n📅 *Fechas Disponibles:*\n\n${fechasMsg.texto}\n👉 *Escribe el número* de la fecha elegida:`;
                        userState[phone].step = 'elegir_fecha';
                    } else {
                        const lista = doctoresDisponibles.map((d, i) => `${i + 1}️⃣ ${d}`).join('\n');
                        response = `Con *${ageStr}*, te atendemos en:\n\n${emoji} *Consultorio de ${consultorio}*\n\n👨‍⚕️ ¿Con qué doctor prefieres tu cita?\n\n${lista}\n\n👉 *Escribe el número:*`;
                        userState[phone].step = 'elegir_doctor';
                    }
                }
            }
            else if (state.step === 'elegir_doctor') {
                const doctores = userState[phone].data.doctores;
                const textLower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                const numElegido = parseInt(text);
                if (!isNaN(numElegido) && numElegido >= 1 && numElegido <= doctores.length) {
                    userState[phone].data.doctor = doctores[numElegido - 1];
                } else {
                    const encontrado = doctores.find(d => { const n = d.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); return textLower.split(' ').some(p => p.length >= 3 && n.includes(p)); });
                    if (encontrado) userState[phone].data.doctor = encontrado;
                    else { const lista = doctores.map((d, i) => `${i + 1}️⃣ ${d}`).join('\n'); await msg.reply(`❌ No encontré ese doctor.\n\n${lista}`); return; }
                }
                userState[phone].data.servicio = 'Consulta general';
                const fechasMsg = await getFechasDisponibles(userState[phone].data.doctor);
                if (!fechasMsg.fechas.length) {
                    let hayCupos = false;
                    for (const doc of doctores) { if (doc !== userState[phone].data.doctor) { const fm = await getFechasDisponibles(doc); if (fm.fechas.length > 0) { hayCupos = true; break; } } }
                    if (hayCupos) { const lista = doctores.map((d, i) => `${i + 1}️⃣ ${d}`).join('\n'); response = `😔 Ese doctor no tiene fechas.\n\n${lista}\n\n👉 *Escribe 1 o 2:*`; }
                    else { response = `😔 *Ya no contamos con citas disponibles.*\n\n📞 ¡Escríbenos el próximo *viernes a las 7:30 a.m.*!`; userState[phone] = { step: 'sin_citas', data: {} }; }
                } else {
                    userState[phone].data.fechasOpciones = fechasMsg.fechas;
                    response = `📅 *Fechas Disponibles:*\n\n${fechasMsg.texto}\n👉 *Escribe el número* de la fecha elegida:`;
                    userState[phone].step = 'elegir_fecha';
                }
            }
            else if (state.step === 'elegir_fecha') {
                const opciones = userState[phone].data.fechasOpciones || [];
                const idx = parseInt(text) - 1;
                if (isNaN(idx) || idx < 0 || idx >= opciones.length) { response = `❌ Escribe un número del 1 al ${opciones.length}:`; }
                else {
                    const fechaElegida = opciones[idx];
                    userState[phone].data.fecha = fechaElegida;
                    const horasMsg = await getHorasDisponiblesPanel(fechaElegida, userState[phone].data.doctor);
                    if (!horasMsg.horas.length) {
                        const otrasFechas = await getFechasDisponibles(userState[phone].data.doctor);
                        const otrasFiltradas = otrasFechas.fechas.filter(f => f !== fechaElegida);
                        if (otrasFiltradas.length) {
                            let t = ''; otrasFiltradas.forEach((f, i) => { t += `${i + 1}. ${formatFechaBot(f)}\n`; });
                            userState[phone].data.fechasOpciones = otrasFiltradas;
                            response = `😔 No hay horarios para *${formatFechaBot(fechaElegida)}*.\n\n📅 *Otras fechas:*\n\n${t}\nEscribe el número:`;
                        } else {
                            let hayCupos = false; const doctores2 = userState[phone].data.doctores;
                            for (const doc of doctores2) { if (doc !== userState[phone].data.doctor) { const fm = await getFechasDisponibles(doc); if (fm.fechas.length > 0) { hayCupos = true; break; } } }
                            if (hayCupos) { const lista = doctores2.map((d, i) => `${i + 1}️⃣ ${d}`).join('\n'); response = `😔 No hay más fechas con ese doctor.\n\n${lista}\n\n👉 *Escribe 1 o 2:*`; userState[phone].step = 'elegir_doctor'; }
                            else { response = `😔 *Ya no contamos con citas disponibles.*\n\n📞 ¡El próximo *viernes a las 7:30 a.m.*!`; userState[phone] = { step: 'sin_citas', data: {} }; }
                        }
                    } else {
                        userState[phone].data.horasOpciones = horasMsg.horas;
                        response = `⏰ *Horarios para el ${formatFechaBot(fechaElegida)}:*\n\n${horasMsg.texto}\n👉 *Escribe el número* del horario elegido:`;
                        userState[phone].step = 'cita_hora';
                    }
                }
            }
            else if (state.step === 'cita_hora') {
                const horasOpciones = userState[phone].data.horasOpciones || [];
                const idx = parseInt(text) - 1;
                if (isNaN(idx) || idx < 0 || idx >= horasOpciones.length) { response = `❌ Escribe un número del 1 al ${horasOpciones.length}:`; }
                else {
                    const horaElegida = horasOpciones[idx];
                    const disponible = await verificarDisponibilidad(userState[phone].data.fecha, horaElegida, userState[phone].data.doctor, phone);
                    if (!disponible) {
                        const horasMsg = await getHorasDisponiblesPanel(userState[phone].data.fecha, userState[phone].data.doctor);
                        if (horasMsg.horas.length) { response = `⛔ Horario *ocupado*.\n\n⏰ *Disponibles:*\n\n${horasMsg.texto}\nEscribe el número:`; userState[phone].data.horasOpciones = horasMsg.horas; }
                        else { response = `⛔ No quedan horarios.\n\nEscribe el *nombre del paciente* para reintentar.`; userState[phone] = { step: 'pedir_nombre', data: {} }; }
                    } else {
                        const clave = claveReserva(userState[phone].data.fecha, horaElegida, userState[phone].data.doctor);
                        const chatIdR = msg.from;
                        const reservado = crearReserva(clave, phone, chatIdR, async () => {
                            if (userState[phone] && userState[phone].step === 'pedir_telefono') {
                                userState[phone] = { step: 'pedir_nombre', data: {} };
                                try { await client.sendMessage(chatIdR, `❌ *SU CITA HA SIDO CANCELADA.*\n\n⏱️ El tiempo de *1 minuto* se agotó.\n\n👉 Escribe tu *Nombre y Apellidos* para reintentar.`); } catch (e) {}
                            }
                        });
                        if (!reservado) { response = `⛔ Horario reservado por otro paciente.\n\nEscribe *CITA* para reintentar.`; userState[phone] = { step: 'pedir_nombre', data: {} }; }
                        else {
                            userState[phone].data.hora = horaElegida;
                            userState[phone].data.claveReserva = clave;
                            const d = userState[phone].data;
                            response = `✅ *¡Horario reservado por 1 minuto!*\n\n📋 *Resumen de tu cita:*\n\n👤 *Paciente:* ${d.nombre}\n🪪 *DNI:* ${d.dni}\n🏥 *Consultorio:* ${d.consultorio}\n👨‍⚕️ *Doctor:* ${d.doctor}\n📅 *Fecha:* ${formatFechaBot(d.fecha)}\n⏰ *Hora:* ${formatHoraBot(d.hora)}\n\n⏳ Tienes *1 minuto* para confirmar.\n\n📱 Para *CONFIRMAR*, escribe tu *número de celular* peruano (9 dígitos):`;
                            userState[phone].step = 'pedir_telefono';
                        }
                    }
                }
            }
            else if (state.step === 'pedir_telefono') {
                if (text.toUpperCase() === 'CANCELAR') {
                    const claveActual = userState[phone]?.data?.claveReserva;
                    if (claveActual) liberarReserva(claveActual);
                    response = `❌ *Se ha cancelado el registro de cita.*\n\nEscribe *CITA* para comenzar nuevamente.`;
                    userState[phone] = { step: 'pedir_nombre', data: {} };
                }
                if (!/^9\d{8}$/.test(text)) {
                    response = '❌ El celular debe tener *9 dígitos* y empezar con 9.\n\n*Ejemplo:* 987654321, o escribe *CANCELAR*.';
                } else {
                    userState[phone].data.telefono = text;
                    const d = userState[phone].data;
                    const clave = d.claveReserva || claveReserva(d.fecha, d.hora, d.doctor);
                    if (reservasTemp[clave] && reservasTemp[clave].phone !== phone) {
                        liberarReserva(clave);
                        response = `⛔ Horario tomado por otra persona.\n\n👉 Escribe *CITA* para reintentar.`;
                        userState[phone] = { step: 'pedir_nombre', data: {} };
                    } else if (!reservasTemp[clave]) {
                        response = `❌ *SU CITA HA SIDO CANCELADA.*\n\n⏱️ Tiempo agotado.\n\n👉 Escribe tu *Nombre y Apellidos* para reintentar.`;
                        userState[phone] = { step: 'pedir_nombre', data: {} };
                    } else {
                        liberarReserva(clave);
                        try {
                            await agendarCita(d.telefono, d.nombre, d.dni, d.edad, d.consultorio, d.doctor, d.servicio, d.fecha, d.hora);
                            response = `✅ *¡Cita registrada exitosamente!*\n\n👤 *Paciente:* ${d.nombre}\n🪪 *DNI:* ${d.dni}\n🏥 *Consultorio:* ${d.consultorio}\n👨‍⚕️ *Doctor:* ${d.doctor}\n📅 *Fecha:* ${formatFechaBot(d.fecha)}\n⏰ *Hora:* ${formatHoraBot(d.hora)}\n\n⚠️ *Recuerda llegar 10 minutos antes.*\n\n🧻 Para tu comodidad traer papel higiénico o servilletas.`;
                            const fechaCitaObj = new Date(d.fecha + 'T12:00:00');
                            if (fechaCitaObj.getDay() === 0) response += `\n\n🚪 *IMPORTANTE:* Por ser domingo, el ingreso es por la puerta de emergencia.`;
                            userState[phone] = { step: 'completado', data: {} };
                        } catch (error) {
                            if (error.code === 'ER_DUP_ENTRY' && error.message?.includes('uk_slot')) {
                                const horasMsg2 = await getHorasDisponiblesPanel(d.fecha, d.doctor);
                                if (horasMsg2.horas.length) { response = `⛔ Horario tomado.\n\n${horasMsg2.texto}\n👉 Escribe el número:`; userState[phone].step = 'cita_hora'; userState[phone].data.horasOpciones = horasMsg2.horas; }
                                else { response = `⛔ No quedan horarios.\n\n📞 ¡El próximo *viernes a las 7:30 a.m.*!`; userState[phone] = { step: 'sin_citas', data: {} }; }
                            } else if (error.code === 'ER_DUP_ENTRY') {
                                response = `❌ El DNI *${d.dni}* ya tiene cita registrada.\n\n👉 Escribe *CITA* para empezar de nuevo.`;
                                userState[phone] = { step: 'pedir_nombre', data: {} };
                            } else {
                                response = `❌ *Error en el sistema.* Inténtalo más tarde o escribe *CITA*.`;
                                console.error('Error cita:', error);
                            }
                        }
                    }
                }
            }
            else {
                const step = state.step; const d = state.data;
                if (step === 'pedir_nombre') response = '❌ Escribe tu *Nombre y Apellido* completo:\n\n*Ejemplo:* Juan Pérez García';
                else if (step === 'pedir_dni') response = '❌ El *DNI* debe tener *8 números*.';
                else if (step === 'pedir_edad') response = '❌ Escribe una *edad válida* (ej. "11 meses", "1 año y 2 meses", o solo el número en años):';
                else if (step === 'elegir_doctor') { const lista = (d.doctores||[]).map((doc,i)=>`${i+1}️⃣ ${doc}`).join('\n'); response = `❌ Opción no válida.\n\n${lista}`; }
                else if (step === 'elegir_fecha') { let t=''; (d.fechasOpciones||[]).forEach((f,i)=>{t+=`${i+1}. ${formatFechaBot(f)}\n`;}); response = `❌ Escribe un número del 1 al ${(d.fechasOpciones||[]).length}:\n\n${t}`; }
                else if (step === 'cita_hora') response = `❌ Escribe un número del 1 al ${(d.horasOpciones||[]).length}:`;
                else if (step === 'pedir_telefono') response = '❌ Escribe tu *número de celular* (9 dígitos, empieza con 9), o *CANCELAR*.';
                else { userState[phone] = { step: 'pedir_nombre', data: {} }; response = await getBienvenida(botConfig.botActivo); }
            }

            await replyConTimeout(msg, response);
        } catch (innerErr) { console.error('Error procesando:', phone, innerErr); }
    });
});

// ══════════════════════════════════════════════════════════════
//  ARRANQUE
// ══════════════════════════════════════════════════════════════
async function start() {
    try { await connectDB(); }
    catch (e) { console.error('❌ Error Supabase:', e.message); console.warn('⚠️ El bot funcionará sin BD.'); }
    try {
        emitLog('Iniciando DentalBot — Sistema Unificado...', 'system');
        await client.initialize();
    } catch (e) {
        console.error('❌ Error WhatsApp en inicialización:', e.message);
        
        // Destruir cliente actual si quedó a medias
        try { await client.destroy(); } catch (err) {}
        
        const sessionPath = path.join(__dirname, '.wwebjs_auth');
        const cachePath = path.join(__dirname, '.wwebjs_cache');
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        if (fs.existsSync(cachePath)) fs.rmSync(cachePath, { recursive: true, force: true });
        console.log('🔄 Reintentando iniciar en 5s...');
        
        // Reintentamos inicializar después de limpiar y destruir proceso previo
        setTimeout(() => {
            client.initialize().catch(err => {
                console.error('❌ Error fatal en reintento de inicialización:', err.message);
            });
        }, 5000);
    }
}

start();
