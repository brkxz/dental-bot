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
const SHEET_ID = '1NbAtoy6opm-iVfWUp2-ucDOXyPRSFIoHferhib7DTKU';
const HORARIOS_FILE = path.join(__dirname, 'horarios_panel.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const SUPABASE_URL = 'postgresql://postgres.qqjonozfvojwrenhdnzf:Barderos$1508@aws-0-us-west-2.pooler.supabase.com:6543/postgres';

// ══════════════════════════════════════════════════════════════
//  ESTADO GLOBAL
// ══════════════════════════════════════════════════════════════
const botState = {
    status: 'loading', qrData: null
};
let dailyCronJob = null;
let db;

function cargarConfig() {
    try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch (e) { console.error('Error config:', e); }
    return { botActivo: false, modoViernes: false, autoRevisarEnabled: true, cronTime: '09:00', botSilenciado: false };
}
function guardarConfig(data) {
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8'); }
    catch (e) { console.error('Error guardando config:', e); }
}
let botConfig = cargarConfig();
if (botConfig.autoRevisarEnabled === undefined) botConfig.autoRevisarEnabled = true;
if (botConfig.cronTime === undefined) botConfig.cronTime = '09:00';
if (botConfig.botSilenciado === undefined) botConfig.botSilenciado = false;

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

const MESES_ES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

function getFechaManana() {
    const manana = new Date(); manana.setDate(manana.getDate() + 1);
    return `${String(manana.getDate()).padStart(2, '0')}/${String(manana.getMonth() + 1).padStart(2, '0')}/${manana.getFullYear()}`;
}

function getTabManana() {
    const manana = new Date(); manana.setDate(manana.getDate() + 1);
    const dia = String(manana.getDate()).padStart(2, '0');
    const mes = MESES_ES[manana.getMonth()];
    const anio = manana.getFullYear();
    return `${dia} DE ${mes} ${anio}`;
}

async function obtenerPacientesManana() {
    const tabName = getTabManana();
    const fechaDisplay = getFechaManana();
    console.log(`[Recordatorios] Buscando pestaña: "${tabName}"`);

    try {
        // Read rows 6-60, columns A-AH (covers all doctor blocks including new layout)
        const range = `'${tabName}'!A6:AH60`;
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: range,
            valueRenderOption: 'FORMATTED_VALUE'
        });
        const filas = response.data.values;
        if (!filas || filas.length === 0) {
            console.log('[Recordatorios] No hay datos en la pestaña');
            return [];
        }

        // La hoja puede tener MÚLTIPLES bloques de doctores en distintas filas.
        // Estrategia: recorrer todas las filas buscando filas de cabecera (contienen "C.D.")
        // y registrar qué doctores están activos en cada bloque.

        // Mapa: rowIndex → lista de doctores detectados en esa fila
        const bloques = []; // { filaInicio: número, doctores: [{nombre, colInicio}] }

        for (let r = 0; r < filas.length; r++) {
            const fila = filas[r] || [];
            const docsEnFila = [];
            for (let col = 0; col < fila.length; col++) {
                const cell = (fila[col] || '').toString().trim();
                if (cell.toUpperCase().startsWith('C.D.') || cell.toUpperCase().startsWith('ESP. C.D.')) {
                    docsEnFila.push({ nombre: cell, colInicio: col });
                }
            }
            if (docsEnFila.length > 0) {
                // Esta es una fila de cabecera de doctor — los datos empiezan 2 filas después
                bloques.push({ filaHeaderIdx: r, doctores: docsEnFila });
                console.log(`[Recordatorios] Bloque en fila ${r + 6}: ${docsEnFila.map(d => `${d.nombre}(col${d.colInicio})`).join(', ')}`);
            }
        }

        if (bloques.length === 0) {
            console.log('[Recordatorios] No se detectaron doctores en ninguna fila de la hoja');
            return [];
        }

        const pacientes = [];

        // Para cada bloque, procesar filas de datos hasta el siguiente bloque (o fin)
        for (let b = 0; b < bloques.length; b++) {
            const bloque = bloques[b];
            const dataStart = bloque.filaHeaderIdx + 2; // saltar cabecera y fila de columnas
            const dataEnd = (b + 1 < bloques.length) ? bloques[b + 1].filaHeaderIdx : filas.length;

            for (let i = dataStart; i < dataEnd; i++) {
                const fila = filas[i];
                if (!fila || !fila[0]) continue;

                const hora = fila[0].toString().trim();
                // Saltar filas separadoras (MAÑANA, TARDE, TURNO, etc.)
                if (hora === '' || /^(MA[ÑN]ANA|TARDE|TURNO|HORARIO)/i.test(hora)) continue;
                // Verificar que tenga formato de hora (HH:MM)
                if (!/^\d{1,2}:\d{2}/.test(hora)) continue;

                for (const doc of bloque.doctores) {
                    const colNombre  = doc.colInicio;       // Nombre
                    const colDNI     = doc.colInicio + 1;   // DNI
                    const colEdad    = doc.colInicio + 2;   // Edad
                    const colCelular = doc.colInicio + 3;   // Celular

                    const nombre  = (fila[colNombre]  || '').toString().trim();
                    const celular = (fila[colCelular] || '').toString().trim();

                    // DEBUG: mostrar qué se está leyendo
                    if (nombre || celular) {
                        console.log(`   [DEBUG] ${hora} | ${doc.nombre.split(' ')[2]} col${doc.colInicio} → nombre="${nombre}" cel="${celular}"`);
                    }

                    if (!nombre || !celular) continue;
                    if (nombre.toUpperCase().includes('CUPO ADICIONAL')) continue;
                    if (nombre.toUpperCase().includes('ADICIONAL')) continue;

                    let numeroWs = celular.replace(/\D/g, '');
                    if (!numeroWs.length || numeroWs.length < 7) continue;
                    if (numeroWs.length === 9) numeroWs = '51' + numeroWs;
                    else if (!numeroWs.startsWith('51') && numeroWs.length < 11) numeroWs = '51' + numeroWs;

                    const docCorto = doc.nombre.split(' ').slice(0, 4).join(' ');

                    const edadRaw = (fila[colEdad] || '').toString().trim();
                    const edadNum = parseInt(edadRaw);
                    const consultorio = (!isNaN(edadNum) && edadNum <= 11) ? 'Odontopediatría' : 'Odontología General';

                    pacientes.push({
                        nombre,
                        numeroWs,
                        vacuna: `consulta con ${docCorto}`,
                        fecha: fechaDisplay,
                        hora,
                        consultorio
                    });
                }
            }
        }

        console.log(`[Recordatorios] ${pacientes.length} paciente(s) encontrado(s) para mañana`);
        return pacientes;

    } catch (e) {
        if (e.message && e.message.includes('Unable to parse range')) {
            console.log(`[Recordatorios] La pestaña "${tabName}" no existe en la hoja`);
        } else {
            console.error('[Recordatorios] Error:', e.message);
        }
        return [];
    }
}

// ══════════════════════════════════════════════════════════════
//  BASE DE DATOS SUPABASE (PostgreSQL Wrapper)
// ══════════════════════════════════════════════════════════════
async function connectDB() {
    db = new Pool({ connectionString: SUPABASE_URL, ssl: { rejectUnauthorized: false }, max: 10, idleTimeoutMillis: 30000 });
    db.on('error', (err) => console.error('⚠️ [Postgres Pool Error]:', err.message));
    console.log('✅ Conectado a Supabase (PostgreSQL)');

    db.execute = async (query, params = []) => {
        let pQuery = query;
        let index = 1;
        while (pQuery.includes('?')) {
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
    } catch (e) { console.error('Error creando tabla:', e.message); }

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
    } catch (e) { console.warn('⚠️ Configuración index DNI:', e.message); }

    try {
        await db.query(`ALTER TABLE citas ADD COLUMN IF NOT EXISTS synced_drive BOOLEAN DEFAULT FALSE`);
        console.log('✅ Migración: columna synced_drive verificada.');
    } catch (e) { console.warn('⚠️ Migración synced_drive:', e.message); }
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
        if (datos.botSilenciado !== undefined) botConfig.botSilenciado = datos.botSilenciado;
        if (datos.anuncioGeneral !== undefined) botConfig.anuncioGeneral = datos.anuncioGeneral || '';
        guardarConfig(botConfig);
        res.json({ ok: true, botActivo: botConfig.botActivo, modoViernes: botConfig.modoViernes, botSilenciado: botConfig.botSilenciado, anuncioGeneral: botConfig.anuncioGeneral });
    } catch (e) { res.json({}); }
});

// ══════════════════════════════════════════════════════════════
//  API: Sincronizar citas confirmadas → Google Apps Script (Drive)
// ══════════════════════════════════════════════════════════════
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx94ygh3CwwVVo7fkxc6jQfeXpN8uv8uKneE9d88w_b8P6WC6WwVWIM4bdQkzbHnEGZfQ/exec';

const MESES_SHEET = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];

// Cache de nombres reales de pestañas del Google Sheet
let _sheetTabNames = null;
let _sheetTabNamesExpiry = 0;

async function getSheetTabNames() {
    const now = Date.now();
    if (_sheetTabNames && now < _sheetTabNamesExpiry) return _sheetTabNames;
    try {
        const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
        _sheetTabNames = new Set(res.data.sheets.map(s => s.properties.title));
        _sheetTabNamesExpiry = now + 10 * 60 * 1000; // cache 10 min
        console.log(`📋 [tabs] ${_sheetTabNames.size} pestañas cacheadas`);
    } catch (e) {
        console.error('⚠️ Error obteniendo pestañas:', e.message);
        if (!_sheetTabNames) _sheetTabNames = new Set();
    }
    return _sheetTabNames;
}

function formatFechaSheet(fecha) {
    let d;
    if (fecha instanceof Date) {
        d = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
    } else {
        const parts = String(fecha).split('T')[0].split('-');
        d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    }
    const dia = String(d.getDate()).padStart(2, '0');
    const mes = MESES_SHEET[d.getMonth()];
    // Devolver ambas variantes para que el caller elija la correcta
    return { conAnio: `${dia} DE ${mes} ${d.getFullYear()}`, sinAnio: `${dia} DE ${mes}` };
}

function formatFechaSheetSimple(fecha) {
    const { conAnio } = formatFechaSheet(fecha);
    return conAnio;
}

function formatDoctorSheet(doctor) {
    if (!doctor) return '';
    const lower = doctor.toLowerCase();
    // Mapeo por palabra clave única del doctor → nombre EXACTO en la hoja (incluyendo espacios extra)
    if (lower.includes('manuel'))   return 'C.D. MANUEL JESUIS ROMANI MALDONADO';
    if (lower.includes('elio'))     return 'C.D. ELIO ELVIS T\u00c0MARA TRINIDAD';
    if (lower.includes('jimy'))     return 'ESP. C.D. JIMY ALDO OSORIO ROSALES';
    if (lower.includes('fernando')) return 'C.D. FERNANDO FREDY  BUSTAMANTE TOLENTINO';
    if (lower.includes('yolanda'))  return 'C.D.  YOLANDA  GUADALUPE ALIAGA KRIETE';
    return doctor.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function formatHoraSheet(hora) {
    if (!hora) return '';
    const h = String(hora).substring(0, 5);
    const [hh, mm] = h.split(':');
    let n = parseInt(hh);
    // La hoja usa formato 12h para la tarde (13:00 → 1:00, 14:30 → 2:30)
    if (n >= 13) n = n - 12;
    return `${n}:${mm}`;
}

// Helper: POST al Apps Script con parámetros en URL
// (el body se pierde en el redirect 302 de GAS, pero los params de URL persisten)
async function postToAppsScript(url, payload) {
    const params = new URLSearchParams(payload);
    const fullUrl = `${url}?${params.toString()}`;
    const res = await fetch(fullUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
        redirect: 'follow',
        signal:  AbortSignal.timeout(15000)
    });
    return res;
}

app.post('/sync-drive', async (req, res) => {
    if (!db) return res.json({ ok: false, error: 'DB no disponible' });
    try {
        // Obtener nombres reales de pestañas del Google Sheet
        const tabNames = await getSheetTabNames();

        // Extraer todas las fechas configuradas en el panel
        const fechasPanel = new Set();
        for (const doctor of Object.keys(horariosPanel)) {
            const horarios = horariosPanel[doctor]?.horarios || {};
            for (const fecha of Object.keys(horarios)) {
                fechasPanel.add(fecha); // formato "2026-04-27"
            }
        }

        if (fechasPanel.size === 0) {
            return res.json({ ok: true, synced: 0, total: 0, msg: 'No hay fechas configuradas en el panel' });
        }

        const fechasArr = [...fechasPanel];
        const placeholders = fechasArr.map((_, i) => `$${i + 1}`).join(',');

        const [rows] = await db.execute(
            `SELECT id, nombre, dni, edad, telefono, doctor, fecha, hora
             FROM citas
             WHERE estado='confirmada'
               AND (synced_drive IS NULL OR synced_drive = FALSE)
               AND fecha IN (${placeholders})
             ORDER BY fecha, hora`,
            fechasArr
        );

        console.log(`📋 [sync-drive] ${rows.length} citas en fechas del panel (${fechasArr.join(', ')})`);

        if (rows.length === 0) {
            return res.json({ ok: true, synced: 0, total: 0, msg: 'Sin registros nuevos para sincronizar' });
        }

        let count = 0;
        const errores = [];

        for (const c of rows) {
            // Elegir el nombre de pestaña correcto (con o sin año)
            const { conAnio, sinAnio } = formatFechaSheet(c.fecha);
            const fechaReal = tabNames.has(conAnio) ? conAnio : tabNames.has(sinAnio) ? sinAnio : conAnio;

            const payload = {
                fecha:    fechaReal,
                doctor:   formatDoctorSheet(c.doctor),
                hora:     formatHoraSheet(c.hora),
                nombre:   c.nombre   || '',
                dni:      c.dni      || '',
                edad:     c.edad     || '',
                telefono: c.telefono || ''
            };
            try {
                console.log(`📤 [sync-drive] ${c.nombre} | ${payload.fecha} | ${payload.hora}`);
                const r = await postToAppsScript(APPS_SCRIPT_URL, payload);
                const responseText = await r.text().catch(() => '');
                console.log(`   → HTTP ${r.status} | Body: ${responseText.substring(0, 120)}`);

                // Detectar si GAS devolvió página de error HTML (deployment roto/expirado)
                const isHtmlError = responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html');
                if (isHtmlError) {
                    console.error(`   ❌ GAS devolvió HTML de error — deployment inválido`);
                    errores.push(`${c.nombre}: GAS deployment error (HTML response)`);
                    continue; // NO marcar como synced
                }

                // El Apps Script devuelve JSON con {ok: true/false}
                let gasOk = r.ok;
                try {
                    const gasJson = JSON.parse(responseText);
                    if (gasJson.ok === false) {
                        gasOk = false;
                        errores.push(`${c.nombre}: GAS error — ${gasJson.error || 'desconocido'}`);
                        continue;
                    }
                } catch (_) { /* respuesta no es JSON, confiar en HTTP status */ }

                if (gasOk) {
                    await db.execute('UPDATE citas SET synced_drive = TRUE WHERE id = ?', [c.id]);
                    count++;
                } else {
                    errores.push(`${c.nombre}: HTTP ${r.status}`);
                }
            } catch (e) {
                console.error(`   ❌ ${c.nombre}:`, e.message);
                errores.push(`${c.nombre}: ${e.message}`);
            }
        }

        console.log(`✅ [sync-drive] ${count}/${rows.length} sincronizados`);
        res.json({ ok: true, synced: count, total: rows.length, errores });
    } catch (e) {
        console.error('❌ [sync-drive]', e.message);
        res.json({ ok: false, error: e.message });
    }
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
    socket.emit('config', { autoRevisarEnabled: botConfig.autoRevisarEnabled, cronTime: botConfig.cronTime });
    socket.emit('status', botState.status);
    if (botState.status === 'qr' && botState.qrData) socket.emit('qr', botState.qrData);

    socket.on('manual_check', () => {
        emitLog('Revisión manual desde el panel.', 'system');
        revisarYEnviarRecordatorios();
    });
    socket.on('toggle_auto', (isEnabled) => {
        botConfig.autoRevisarEnabled = isEnabled;
        guardarConfig(botConfig);
        emitLog(`Auto-Envío ${isEnabled ? 'HABILITADO' : 'DESHABILITADO'}.`, isEnabled ? 'success' : 'warning');
    });
    socket.on('set_cron_time', (timeStr) => {
        botConfig.cronTime = timeStr;
        guardarConfig(botConfig);
        emitLog(`Hora de envío actualizada a ${timeStr}`, 'success');
        programarCron();
        io.emit('config', { autoRevisarEnabled: botConfig.autoRevisarEnabled, cronTime: botConfig.cronTime });
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
            const consultorioP = paciente.consultorio || 'Odontología General';
            const mensaje = `Hola *${paciente.nombre}* 👋, le recordamos que tiene una cita odontológica de *${paciente.vacuna}* programada para *mañana ${paciente.fecha}* a las *${paciente.hora}* 🕐.\n\n🏥 *Consultorio:* ${consultorioP}\n\n⚠️ *Por favor, llegue 10 minutos antes* de su cita.\n\n¡Le esperamos! 🦷`;
            await sendMessageWithRetry(`${paciente.numeroWs}@c.us`, mensaje);
            emitLog(`Recordatorio enviado a ${paciente.nombre}.`, 'success');
        } catch (error) { emitLog(`Error: ${error.message}`, 'error'); }
    });
    socket.on('logout', async () => {
        emitLog('Cerrando sesión de WhatsApp...', 'warning');
        updateStatus('closing');
        try {
            await client.logout();
            emitLog('Sesión cerrada. Reiniciando para generar QR...', 'system');
        } catch (e) {
            emitLog('Forzando cierre: ' + e.message, 'warning');
        }
        try { await client.destroy(); } catch (e) { }
        const sessionPath = path.join(__dirname, '.wwebjs_auth');
        try { if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (e) { }
        updateStatus('loading');
        setTimeout(() => {
            client.initialize().catch(e => console.error('Error reinicializando:', e));
        }, 2000);
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
    const [hour, minute] = botConfig.cronTime.split(':');
    dailyCronJob = cron.schedule(`${Number(minute)} ${Number(hour)} * * *`, () => {
        if (botConfig.autoRevisarEnabled) {
            emitLog(`Revisión Diaria Automática (${botConfig.cronTime})...`, 'system');
            revisarYEnviarRecordatorios();
        }
    });
}

async function sendMessageWithRetry(chatId, mensaje, maxRetries = 2) {
    // Anti-ban: delay humano antes de enviar recordatorios
    await humanDelay(3000, 6000);
    mensajesEnviadosHora++;
    for (let i = 0; i <= maxRetries; i++) {
        try { await client.sendMessage(chatId, mensaje); return true; }
        catch (error) {
            const isDetached = error.message.includes('detached Frame') || error.message.includes('Execution context');
            if (isDetached && i < maxRetries) {
                emitLog(`Reintento ${i + 1}/${maxRetries}...`, 'warning');
                await new Promise(r => setTimeout(r, 3000));
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
            const consultorioA = p.consultorio || 'Odontología General';
            const mensaje = `Hola *${p.nombre}* 👋, le recordamos que tiene una cita odontológica de *${p.vacuna}* programada para *mañana ${p.fecha}* a las *${p.hora}* 🕐.\n\n🏥 *Consultorio:* ${consultorioA}\n\n⚠️ *Por favor, llegue 10 minutos antes* de su cita.\n\n¡Le esperamos! 🦷`;
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
    'C.D. Fernando Fredy Bustamante Tolentino',
    'C.D. Yolanda Guadalupe Aliaga Kriete'
];

const userState = {};
const reservasTemp = {};
const userQueues = {};
const mensajesProcesados = new Set();

// ══════════════════════════════════════════════════════════════
//  ANTI-BAN: Delays humanos + Rate Limiting
// ══════════════════════════════════════════════════════════════
function humanDelay(minMs = 2000, maxMs = 5000) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise(r => setTimeout(r, delay));
}

// Rate limiter: máximo 12 mensajes por minuto por teléfono
const rateLimiter = {};
function checkRateLimit(phone) {
    const now = Date.now();
    if (!rateLimiter[phone]) rateLimiter[phone] = [];
    rateLimiter[phone] = rateLimiter[phone].filter(t => now - t < 60000);
    if (rateLimiter[phone].length >= 12) return false; // límite alcanzado
    rateLimiter[phone].push(now);
    return true;
}

// Simular "escribiendo..." antes de responder (anti-bot detection)
async function simularEscritura(msg) {
    try {
        const chat = await msg.getChat();
        await chat.sendStateTyping();
    } catch (e) { /* ignorar si falla */ }
}

// Contador global de mensajes por hora (protección extra)
let mensajesEnviadosHora = 0;
setInterval(() => { mensajesEnviadosHora = 0; }, 60 * 60 * 1000); // reset cada hora
const LIMITE_MENSAJES_HORA = 200;

console.log('🛡️ Protecciones anti-ban activadas (delays 2-5s, rate limit 12/min, typing simulado)');

// Cache de disponibilidad (30 segundos)
const availCache = { data: {}, ts: 0 };
const CACHE_TTL = 5000;
function invalidateCache() { availCache.ts = 0; availCache.data = {}; }
function getCachedAvail(key) { return (Date.now() - availCache.ts < CACHE_TTL) ? availCache.data[key] : null; }
function setCachedAvail(key, val) { availCache.data[key] = val; availCache.ts = Date.now(); }

function claveReserva(fecha, hora, doctor) { return `${fecha}|${hora}|${doctor}`; }
function liberarReserva(clave) {
    if (reservasTemp[clave]) { clearTimeout(reservasTemp[clave].timer); delete reservasTemp[clave]; }
}
function crearReserva(clave, phone, chatId, onVencer) {
    if (reservasTemp[clave] && reservasTemp[clave].phone !== phone) return false;
    if (reservasTemp[clave]) clearTimeout(reservasTemp[clave].timer);
    const timer = setTimeout(() => { delete reservasTemp[clave]; onVencer(); }, 60000);
    reservasTemp[clave] = { phone, chatId, timer };
    invalidateCache();
    return true;
}
function encolar(phone, fn) {
    if (!userQueues[phone]) userQueues[phone] = Promise.resolve();
    const cola = userQueues[phone].then(fn).catch(e => console.error(`[Queue ${phone}]:`, e))
        .finally(() => { if (userQueues[phone] === cola) delete userQueues[phone]; });
    userQueues[phone] = cola;
}
async function replyConTimeout(msg, text, timeoutMs = 15000) {
    if (!text) return Promise.resolve();
    // Anti-ban: simular escritura + delay humano
    await simularEscritura(msg);
    await humanDelay(2000, 4000);
    mensajesEnviadosHora++;
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
        return `${String(f.getDate()).padStart(2, '0')}/${String(f.getMonth() + 1).padStart(2, '0')}/${f.getFullYear()}`;
    }
    const str = String(f).split('T')[0];
    const [y, m, d] = str.split('-');
    return `${d}/${m}/${y}`;
}
function parseFechaBD(fecha) {
    if (fecha instanceof Date) return fecha.toISOString().split('T')[0];
    const s = String(fecha);
    if (s.includes('T')) return s.split('T')[0];
    const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return s;
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
    const cacheKey = `fechas_${doctor}`;
    const cached = getCachedAvail(cacheKey);
    if (cached) return cached;
    const panel = horariosPanel[doctor];
    if (!panel || !panel.horarios || !Object.keys(panel.horarios).length) return { fechas: [], texto: '' };
    const ahoraUtc = new Date();
    const ahoraLima = new Date(ahoraUtc.getTime() - 5 * 60 * 60 * 1000);
    const hoyLima = ahoraLima.toISOString().split('T')[0];
    const horaAhoraLima = String(ahoraLima.getUTCHours()).padStart(2, '0') + ':' + String(ahoraLima.getUTCMinutes()).padStart(2, '0');
    const mapDia = [1, 2, 3, 4, 5, 6, 0];
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
    if (!todasFechas.length) return { fechas: [], texto: '' };
    // UNA SOLA consulta para TODAS las fechas del doctor
    const [ocupadas] = await db.execute(
        `SELECT fecha, hora FROM citas WHERE doctor=? AND estado='confirmada' AND fecha >= ?`,
        [doctor, hoyLima]
    );
    const ocupadasSet = new Set(ocupadas.map(r => `${parseFechaBD(r.fecha)}|${r.hora.substring(0, 5)}`));
    const fechasConLibres = [];
    for (const fecha of todasFechas) {
        const horasPanel = panel.horarios[fecha];
        const libres = horasPanel.filter(h => {
            if (ocupadasSet.has(`${fecha}|${h}`)) return false;
            if (fecha === hoyLima && h <= horaAhoraLima) return false;
            if (reservasTemp[claveReserva(fecha, h, doctor)]) return false;
            return true;
        });
        if (libres.length > 0) fechasConLibres.push(fecha);
    }
    let texto = '';
    fechasConLibres.forEach((f, i) => { texto += `${i + 1}. ${formatFechaBot(f)}\n`; });
    const result = { fechas: fechasConLibres, texto };
    setCachedAvail(cacheKey, result);
    return result;
}

async function getHorasDisponiblesPanel(fecha, doctor) {
    if (!db) return { horas: [], texto: '' };
    const cacheKey = `horas_${doctor}_${fecha}`;
    const cached = getCachedAvail(cacheKey);
    if (cached) return cached;
    const panel = horariosPanel[doctor];
    if (!panel || !panel.horarios || !panel.horarios[fecha]) return { horas: [], texto: '' };
    const todasHoras = panel.horarios[fecha];
    const [ocupadas] = await db.execute(`SELECT hora FROM citas WHERE fecha=? AND doctor=? AND estado='confirmada'`, [fecha, doctor]);
    const ocupadasList = ocupadas.map(r => r.hora.substring(0, 5));
    const _ahoraUtc = new Date();
    const _ahoraLima = new Date(_ahoraUtc.getTime() - 5 * 60 * 60 * 1000);
    const _hoyLima = _ahoraLima.toISOString().split('T')[0];
    const _horaAhoraLima = String(_ahoraLima.getUTCHours()).padStart(2, '0') + ':' + String(_ahoraLima.getUTCMinutes()).padStart(2, '0');
    const HORAS_M = ['07:15', '07:45', '08:30', '09:15', '10:00', '10:45', '11:30', '12:15'];
    const manana = todasHoras.filter(h => HORAS_M.includes(h) && !ocupadasList.includes(h) && !(fecha === _hoyLima && h <= _horaAhoraLima) && !reservasTemp[claveReserva(fecha, h, doctor)]);
    const tarde = todasHoras.filter(h => !HORAS_M.includes(h) && !ocupadasList.includes(h) && !(fecha === _hoyLima && h <= _horaAhoraLima) && !reservasTemp[claveReserva(fecha, h, doctor)]);
    const horas = [...manana, ...tarde];
    let textoFinal = ''; let idx = 1;
    if (manana.length) { textoFinal += `🌅 *Turno Mañana*\n`; manana.forEach(h => { textoFinal += ` ${idx++}. ${formatHoraBot(h)} ✅\n`; }); }
    if (tarde.length) { textoFinal += `\n🌇 *Turno Tarde*\n`; tarde.forEach(h => { textoFinal += ` ${idx++}. ${formatHoraBot(h)} ✅\n`; }); }
    const result = { horas, texto: textoFinal };
    setCachedAvail(cacheKey, result);
    return result;
}

async function getBienvenida(botActivoOverride = true) {
    let avisos = ''; let hayAlgunasCitas = false;
    if (botActivoOverride) {
        // Consultar doctores de forma secuencial para evitar agotar el pool de conexiones
        const generalResults = [];
        for (const d of doctoresGeneral) { generalResults.push(await getFechasDisponibles(d)); }
        const pediatriaResults = [];
        for (const d of doctoresPediatria) { pediatriaResults.push(await getFechasDisponibles(d)); }
        const hayGeneral = generalResults.some(fm => fm.fechas.length > 0);
        const hayPediatria = pediatriaResults.some(fm => fm.fechas.length > 0);
        // Si hay anuncio de mantenimiento para General, mostrar el aviso en vez de disponibilidad
        if (botConfig.anuncioGeneral) {
            avisos += `\n\n🔧 *Odontología General:* Por motivos de mantenimiento de equipos e infraestructura, la próxima semana no habrá atención. Por favor comuníquese el próximo *viernes 19* para solicitar una cita.`;
        } else {
            avisos += hayGeneral ? `\n\n✅ *Hay citas disponibles para Odontología General.*` : `\n\n⚠️ *No hay citas disponibles para Odontología General.*`;
        }
        avisos += hayPediatria ? `\n\n✅ *Hay citas disponibles para Odontopediatría.*` : `\n\n⚠️ *No hay citas disponibles para Odontopediatría.*`;
        if (hayPediatria || (hayGeneral && !botConfig.anuncioGeneral)) hayAlgunasCitas = true;
    }
    if (!botActivoOverride || !hayAlgunasCitas) {
        if (!botActivoOverride && botConfig.modoViernes) {
            return { msg: `🦷 *Bienvenido al servicio de Odontología* 🦷\n\n👋 Hola, gracias por escribirnos.\n\n🕐 El bot está *desactivado* por el momento. Las citas se habilitan los *viernes a las 7:30 a.m.*\n\n⏳ ¡Escríbenos *hoy mismo a las 7:30 a.m.* para reservar tu cita!\n\n*Gracias por tu paciencia.*`, hayAlgunasCitas: false };
        }
        return { msg: `🦷 *Bienvenido al servicio de Odontología* 🦷\n\n👋 Hola, lo sentimos mucho pero ya no contamos con citas.${avisos}\n\n📞 *¡Escríbanos por favor el próximo viernes a las 7:30!*\n\n*Gracias por su comprensión.*`, hayAlgunasCitas: false };
    }
    return { msg: `🦷 *Bienvenido al servicio de Odontología* 🦷\n\n👋 ¡Hola! Nos alegra atenderte.${avisos}\n\nPara registrar tu cita escribe los *nombres y apellidos* del paciente:`, hayAlgunasCitas: true };
}

async function agendarCita(telefono, nombre, dni, edad, consultorio, doctor, servicio, fecha, hora) {
    let telLimpio = telefono.replace('@c.us', '').replace(/\D/g, '');
    if (telLimpio.startsWith('51') && telLimpio.length === 11) telLimpio = telLimpio.slice(2);
    await db.execute(`INSERT INTO citas (telefono,nombre,dni,edad,consultorio,doctor,servicio,fecha,hora,estado) VALUES (?,?,?,?,?,?,?,?,?,'confirmada')`,
        [telLimpio, nombre, dni, edad, consultorio, doctor, servicio || 'Consulta general', fecha, hora]);
    invalidateCache(); // Limpiar cache al agendar
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
    restartOnAuthFail: true,
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
            '--disable-extensions',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI',
            '--disable-ipc-flooding-protection',
            '--max-old-space-size=512',
            '--js-flags=--max-old-space-size=512'
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

// ── Heartbeat: verifica cada 5 min que Chrome/WhatsApp siga vivo ──
let heartbeatInterval = null;
function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(async () => {
        if (botState.status !== 'connected') return;
        try {
            // Verificar que la página de Puppeteer siga respondiendo
            if (client.pupPage) {
                const alive = await Promise.race([
                    client.pupPage.evaluate(() => document.title).then(() => true),
                    new Promise(r => setTimeout(() => r(false), 10000))
                ]);
                if (!alive) {
                    console.warn('⚠️ [Heartbeat] Chrome no responde — refrescando página...');
                    emitLog('⚠️ Heartbeat: Chrome no responde, refrescando...', 'warning');
                    try { await client.pupPage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); }
                    catch (e) { console.error('❌ [Heartbeat] Error al refrescar:', e.message); }
                }
            }
            // Verificar estado del cliente WhatsApp
            const state = await Promise.race([
                client.getState().catch(() => null),
                new Promise(r => setTimeout(() => r(null), 10000))
            ]);
            if (state && state !== 'CONNECTED') {
                console.warn(`⚠️ [Heartbeat] Estado WhatsApp: ${state}`);
            }
        } catch (e) {
            console.warn('⚠️ [Heartbeat] Error en verificación:', e.message);
        }
    }, 5 * 60 * 1000); // Cada 5 minutos
}
function stopHeartbeat() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

client.on('ready', () => {
    updateStatus('connected');
    emitLog('¡WhatsApp Bot vinculado y Listo!', 'success');
    botState.qrData = null;
    botState.readyTimestamp = Math.floor(Date.now() / 1000); // Anti-ban: registrar momento de conexión
    console.log(`🛡️ [Anti-ban] Solo se responderán mensajes recibidos después de las ${new Date().toLocaleTimeString()}`);
    programarCron();
    startHeartbeat();

    // Manejar crash de la página de Chrome
    if (client.pupPage) {
        client.pupPage.on('error', (err) => {
            console.error('❌ [Chrome] Página crasheó:', err.message);
            emitLog('❌ Chrome crasheó. Reiniciando...', 'error');
            stopHeartbeat();
            updateStatus('loading');
            client.destroy().catch(() => {}).then(() => {
                setTimeout(() => {
                    emitLog('Reconectando tras crash de Chrome...', 'system');
                    client.initialize().catch(e => console.error('Error re-init:', e));
                }, 5000);
            });
        });
        client.pupPage.on('close', () => {
            if (botState.status === 'connected') {
                console.error('❌ [Chrome] Página cerrada inesperadamente');
                emitLog('❌ Chrome se cerró. Reiniciando...', 'error');
                stopHeartbeat();
                updateStatus('loading');
                setTimeout(() => {
                    client.initialize().catch(e => console.error('Error re-init:', e));
                }, 5000);
            }
        });
    }
});

client.on('disconnected', async (reason) => {
    emitLog(`WhatsApp desconectado: ${reason}`, 'error');
    updateStatus('loading');
    stopHeartbeat();
    try { await client.destroy(); } catch (e) { }

    // Si la razón es LOGOUT, la sesión es inválida — hay que limpiarla
    if (reason === 'LOGOUT' || reason === 'CONFLICT' || reason === 'UNPAIRED') {
        emitLog('Sesión invalidada. Limpiando datos para generar nuevo QR...', 'warning');
        await killOrphanedChrome();
        await new Promise(r => setTimeout(r, 2000));
        const sessionPath = path.join(__dirname, '.wwebjs_auth');
        const cachePath = path.join(__dirname, '.wwebjs_cache');
        safeRemoveDir(sessionPath);
        safeRemoveDir(cachePath);
    }

    setTimeout(() => {
        emitLog('Reconectando después de desconexión...', 'system');
        client.initialize().catch(e => console.error('Error re-inicializando:', e));
    }, 5000);
});

client.on('auth_failure', async () => {
    emitLog('Error de autenticación. Limpiando sesión...', 'error');
    updateStatus('loading');
    try { await client.destroy(); } catch (e) { }
    await killOrphanedChrome();
    await new Promise(r => setTimeout(r, 2000));
    const sessionPath = path.join(__dirname, '.wwebjs_auth');
    const cachePath = path.join(__dirname, '.wwebjs_cache');
    safeRemoveDir(sessionPath);
    safeRemoveDir(cachePath);
    emitLog('Reiniciando para generar nuevo QR...', 'system');
    setTimeout(() => {
        client.initialize().catch(e => console.error('Error re-inicializando tras auth_failure:', e));
    }, 5000);
});

// ══════════════════════════════════════════════════════════════
//  CHATBOT — Manejo de mensajes (flujo completo de citas)
//  Archivo separado para mantener limpio: chatbot_handler.js
// ══════════════════════════════════════════════════════════════
client.on('message', (msg) => {
    if (msg.from === 'status@broadcast') return;
    if (msg.isGroupMsg) return;
    if (botConfig.botSilenciado) return; // Bot silenciado: ignorar todos los mensajes

    // ═══ ANTI-BAN: Ignorar mensajes viejos (anteriores a la conexión del bot) ═══
    const msgTimestamp = msg.timestamp || 0;
    const ahora = Math.floor(Date.now() / 1000);
    const edadMensaje = ahora - msgTimestamp;
    if (edadMensaje > 120) { // Ignorar mensajes de más de 2 minutos
        console.log(`🛡️ [Anti-ban] Mensaje viejo ignorado (${edadMensaje}s) de ${msg.from.replace(/@.*$/, '')}`);
        return;
    }
    if (botState.readyTimestamp && msgTimestamp < botState.readyTimestamp) {
        console.log(`🛡️ [Anti-ban] Mensaje pre-conexión ignorado de ${msg.from.replace(/@.*$/, '')}`);
        return;
    }

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

            // Anti-ban: verificar rate limit y límite por hora
            if (!checkRateLimit(phone)) {
                console.log(`🛡️ Rate limit alcanzado para ${phone}, ignorando`);
                return;
            }
            if (mensajesEnviadosHora >= LIMITE_MENSAJES_HORA) {
                console.log(`🛡️ Límite de mensajes por hora alcanzado (${LIMITE_MENSAJES_HORA}), ignorando`);
                return;
            }

            // Detección de "adicional"
            const textNorm = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            if (textNorm.includes('adicional')) {
                await simularEscritura(msg);
                await humanDelay(2000, 4000);
                mensajesEnviadosHora++;
                await msg.reply(`🚨 *Cupos Adicionales - Servicio de Odontología*\n\n📍 Los cupos adicionales se entregan de manera *presencial* todos los días en el consultorio de Odontología, a las *7:00 a.m.*, a las *dos primeras personas* en llegar.\n\n⚠️ *Ten en cuenta:*\n• Estos pacientes serán atendidos *después* de los pacientes con cita previa.\n\n🙏 Agradecemos mucho tu comprensión.`);
                return;
            }

            let esNuevo = !userState[phone];
            if (!userState[phone]) userState[phone] = { step: 'pedir_nombre', data: {} };
            const state = userState[phone];
            let response = '';

            // Normalizar texto para detección de saludos (quitar tildes y signos de puntuación)
            const textNormSaludo = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, '').trim();
            const SALUDOS = ['menu', '0', 'hola', 'cita', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches'];
            const esSaludo = SALUDOS.some(s => textNormSaludo === s || textNormSaludo.startsWith(s + ' ') || textNormSaludo.endsWith(' ' + s));

            // Bot desactivado
            if (!botConfig.botActivo && state.step !== 'sin_citas' && !['cancelar'].includes(textNormSaludo) && !esSaludo) {
                userState[phone] = { step: 'sin_citas', data: {} };
                const bienvenida = await getBienvenida(false);
                await msg.reply(bienvenida.msg);
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
            else if (state.step === 'completado' && !['menu', '0', 'cita'].includes(text.toLowerCase())) {
                response = `✨ *¡Gracias por confiar en servicio de Odontología!* ✨\n\nNos sentimos felices de cuidar tu sonrisa. Tu cita ya está agendada y registrada en nuestro sistema.\n\n👨‍⚕️ Nos vemos el día de tu consulta. ¡Que tengas un excelente día!\n\n_(Si deseas agendar otra cita, escribe *CITA* para empezar de nuevo)_`;
            }
            else if (text.toUpperCase() === 'CANCELAR') {
                response = `❌ *Se ha cancelado el registro de cita.*\n\nEscribe *CITA* para comenzar nuevamente o *MENU* para ver todas las opciones.`;
                userState[phone] = { step: 'pedir_nombre', data: {} };
            }
            else if (esNuevo || esSaludo) {
                const bienvenida = await getBienvenida(botConfig.botActivo);
                userState[phone] = bienvenida.hayAlgunasCitas ? { step: 'pedir_nombre', data: {} } : { step: 'sin_citas', data: {} };
                response = bienvenida.msg;
            }
            else if (state.step === 'pedir_nombre') {
                const textLower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
                const palabrasInput = textLower.split(/\s+/);
                // Palabras prohibidas: se comparan como PALABRAS COMPLETAS (no substrings)
                const palabrasProhibidas = new Set([
                    // Frases de pedido
                    'cita', 'quiero', 'necesito', 'agendar', 'turno', 'sacar', 'hola', 'buenas', 'buenos', 'ayuda',
                    // Saludos y despedidas
                    'dias', 'tardes', 'noches', 'gracias',
                    // Servicios / especialidades médicas
                    'odontologia', 'pediatria', 'dental', 'dentista', 'consulta', 'servicio', 'atencion',
                    // Palabras genéricas
                    'paciente', 'usuario', 'persona', 'apellido', 'favor', 'doctor'
                ]);
                // Frases prohibidas multi-palabra (se buscan como substring)
                const frasesProhibidas = ['por favor', 'buenos dias', 'buenas tardes', 'buenas noches', 'una cita', 'me da', 'deseo una'];
                const contieneProhibida = palabrasInput.some(w => palabrasProhibidas.has(w)) || frasesProhibidas.some(f => textLower.includes(f));
                const numPalabras = text.trim().split(/\s+/).length;

                const soloLetras = /^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\s.]+$/;
                if (!soloLetras.test(text)) {
                    response = '❌ El nombre solo debe contener *letras*, sin números ni caracteres especiales.\n\n📝 *Ejemplo correcto:* Juan Pérez García\n❌ *Ejemplo incorrecto:* Ju4n P3rez 123\n\nPor favor, escribe tu *Nombre y Apellido* nuevamente:';
                } else if (contieneProhibida) {
                    response = '❌ Por favor, escribe *únicamente* el Nombre y Apellido del paciente.\n\nEvita usar frases como "quiero una cita", "por favor", saludos, etc.\n\n📝 *Ejemplo:* Juan Pérez García';
                } else if (text.length < 5 || numPalabras < 2 || numPalabras > 5) {
                    response = '❌ Por favor, escribe un *Nombre y Apellido* válido (completo, entre 2 y 5 palabras):\n\n*Ejemplo:* Juan Pérez García';
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
                    // Guardar DNI, la restricción se valida después según la edad
                    userState[phone].data.dni = text;
                    response = `✅ ¡Anotado!\n\n🎂 ¿Cuántos años tiene el paciente?`;
                    userState[phone].step = 'pedir_edad';
                }
            }
            else if (state.step === 'pedir_edad') {
                let textLow = text.toLowerCase().trim();
                let ageYears = 0;
                let ageStr = text.trim();
                let valid = true;

                if (/^\d+$/.test(textLow)) {
                    ageYears = parseInt(textLow);
                    ageStr = String(ageYears);
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
                            ageStr = String(ageYears);
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

                    // ── Restricción de DNI: verificar citas existentes ──
                    if (db) {
                        const ahoraUtcE = new Date();
                        const ahoraLimaE = new Date(ahoraUtcE.getTime() - 5 * 60 * 60 * 1000);
                        const hoyLimaE = ahoraLimaE.toISOString().split('T')[0];

                        if (ageYears > 20) {
                            // Adultos: restricción de 15 días
                            const [citaDni] = await db.execute(
                                `SELECT nombre, doctor, fecha, hora FROM citas WHERE dni=? AND estado='confirmada' AND fecha >= CAST(? AS DATE) - INTERVAL '15 days' ORDER BY fecha DESC LIMIT 1`,
                                [userState[phone].data.dni, hoyLimaE]
                            );
                            if (citaDni.length > 0) {
                                const cd = citaDni[0];
                                const fechaCitaD = new Date(parseFechaBD(cd.fecha) + 'T12:00:00');
                                const fechaLibre = new Date(fechaCitaD.getTime() + 15 * 24 * 60 * 60 * 1000);
                                const diaLibre = `${String(fechaLibre.getDate()).padStart(2, '0')}/${String(fechaLibre.getMonth() + 1).padStart(2, '0')}/${fechaLibre.getFullYear()}`;
                                response = `⚠️ *El paciente con DNI ${userState[phone].data.dni} ya tiene una cita registrada:*\n\n👤 *Paciente:* ${cd.nombre}\n👨‍⚕️ *Doctor:* ${cd.doctor}\n📅 *Fecha:* ${formatFechaBot(cd.fecha)}\n⏰ *Hora:* ${formatHoraBot(cd.hora)}\n\n📋 *¿Por qué no puedo sacar otra cita?*\nNuestro sistema permite registrar *una cita cada 15 días* por paciente (DNI). Esto es para garantizar que todos los pacientes tengan la oportunidad de ser atendidos.\n\n🕐 Podrás registrar una nueva cita a partir del *${diaLibre}*.\n\n👉 Escribe *CITA* para agendar con otro paciente.`;
                                userState[phone] = { step: 'pedir_nombre', data: {} };
                                await replyConTimeout(msg, response);
                                return;
                            }
                        } else {
                            // Menores: bloquear si ya tiene cualquier cita pendiente
                            const [citaDniMenor] = await db.execute(
                                `SELECT nombre, doctor, fecha, hora FROM citas WHERE dni=? AND estado='confirmada' AND fecha >= ? ORDER BY fecha ASC LIMIT 1`,
                                [userState[phone].data.dni, hoyLimaE]
                            );
                            if (citaDniMenor.length > 0) {
                                const cd = citaDniMenor[0];
                                response = `⚠️ *El DNI ${userState[phone].data.dni} ya tiene una cita registrada:*\n\n👤 *Paciente:* ${cd.nombre}\n👨‍⚕️ *Doctor:* ${cd.doctor}\n📅 *Fecha:* ${formatFechaBot(cd.fecha)}\n⏰ *Hora:* ${formatHoraBot(cd.hora)}\n\n📋 *¿Por qué no puedo registrar otra cita?*\nLas citas para menores de edad solo permiten *un registro activo por DNI*. Si necesita reprogramar o agendar una cita adicional, el padre o apoderado debe comunicarse directamente con el consultorio.\n\n❌ No se puede registrar otra cita con el mismo DNI mientras tenga una cita pendiente.\n\n👉 Escribe *CITA* para agendar con otro paciente.`;
                                userState[phone] = { step: 'pedir_nombre', data: {} };
                                await replyConTimeout(msg, response);
                                return;
                            }
                        }
                    }

                    const esPediatria = ageYears <= 11;
                    const consultorio = esPediatria ? 'Odontopediatría' : 'Odontología General';

                    // ── Anuncio especial: solo para Odontología General ──
                    if (!esPediatria && botConfig.anuncioGeneral) {
                        await replyConTimeout(msg, botConfig.anuncioGeneral);
                        userState[phone] = { step: 'pedir_nombre', data: {} };
                        return;
                    }

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
                        const bloqueadasU = userState[phone].data.fechasBloqueadasDNI || [];
                        const fechasFiltradas = fechasMsg.fechas.filter(f => !bloqueadasU.includes(f));
                        let textoFechasU = ''; fechasFiltradas.forEach((f, i) => { textoFechasU += `${i + 1}. ${formatFechaBot(f)}\n`; });
                        if (!fechasFiltradas.length) {
                            response = `Con *${ageStr}*, te atendemos en:\n\n${emoji} *Consultorio de ${consultorio}*\n\n😔 El paciente ya tiene cita en todas las fechas disponibles.\n\n👉 Escribe *CITA* para agendar con otro paciente.`;
                            userState[phone] = { step: 'pedir_nombre', data: {} };
                        } else {
                            userState[phone].data.fechasOpciones = fechasFiltradas;
                            response = `Con *${ageStr}*, te atendemos en:\n\n${emoji} *Consultorio de ${consultorio}*\n\n👨‍⚕️ Doctor: *${docUnico}*\n\n📅 *Fechas Disponibles:*\n\n${textoFechasU}\n👉 *Escribe el número* de la fecha elegida:`;
                            userState[phone].step = 'elegir_fecha';
                        }
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
                    // Solo mostrar doctores que REALMENTE tienen cupos disponibles
                    const docConCupos = [];
                    for (const doc of doctores) { if (doc !== userState[phone].data.doctor) { const fm = await getFechasDisponibles(doc); if (fm.fechas.length > 0) docConCupos.push(doc); } }
                    if (docConCupos.length === 0) {
                        response = `😔 *Ya no contamos con citas disponibles.*\n\n📞 ¡Escríbenos el próximo *viernes a las 7:30 a.m.*!`;
                        userState[phone] = { step: 'sin_citas', data: {} };
                    } else if (docConCupos.length === 1) {
                        // Solo 1 doctor disponible: asignar directamente sin pedir selección
                        const docU = docConCupos[0];
                        userState[phone].data.doctor = docU;
                        userState[phone].data.doctores = docConCupos;
                        const fmU = await getFechasDisponibles(docU);
                        const bloqU = userState[phone].data.fechasBloqueadasDNI || [];
                        const fechasU = fmU.fechas.filter(f => !bloqU.includes(f));
                        let textoU = ''; fechasU.forEach((f, i) => { textoU += `${i + 1}. ${formatFechaBot(f)}\n`; });
                        userState[phone].data.fechasOpciones = fechasU;
                        response = `😔 Ese doctor ya no tiene fechas disponibles.\n\n👨‍⚕️ Te asignamos con: *${docU}*\n\n📅 *Fechas Disponibles:*\n\n${textoU}\n👉 *Escribe el número* de la fecha elegida:`;
                        userState[phone].step = 'elegir_fecha';
                    } else {
                        const lista = docConCupos.map((d, i) => `${i + 1}️⃣ ${d}`).join('\n');
                        userState[phone].data.doctores = docConCupos;
                        response = `😔 Ese doctor ya no tiene fechas.\n\n${lista}\n\n👉 *Escribe el número:*`;
                        // Mantener step en elegir_doctor para que el usuario elija
                    }
                } else {
                    const bloq = userState[phone].data.fechasBloqueadasDNI || [];
                    const fechasFilt = fechasMsg.fechas.filter(f => !bloq.includes(f));
                    let textoFilt = ''; fechasFilt.forEach((f, i) => { textoFilt += `${i + 1}. ${formatFechaBot(f)}\n`; });
                    if (!fechasFilt.length) {
                        response = `😔 El paciente ya tiene cita en todas las fechas disponibles con ese doctor.\n\n👉 Escribe *CITA* para agendar con otro paciente.`;
                        userState[phone] = { step: 'pedir_nombre', data: {} };
                    } else {
                        userState[phone].data.fechasOpciones = fechasFilt;
                        response = `📅 *Fechas Disponibles:*\n\n${textoFilt}\n👉 *Escribe el número* de la fecha elegida:`;
                        userState[phone].step = 'elegir_fecha';
                    }
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
                            // Solo redirigir a doctores que REALMENTE tienen cupos (evita bucle infinito)
                            const doctores2 = userState[phone].data.doctores || [];
                            const docConCupos2 = [];
                            for (const doc of doctores2) { if (doc !== userState[phone].data.doctor) { const fm = await getFechasDisponibles(doc); if (fm.fechas.length > 0) docConCupos2.push(doc); } }
                            if (docConCupos2.length === 0) {
                                response = `😔 *Ya no contamos con citas disponibles.*\n\n📞 ¡El próximo *viernes a las 7:30 a.m.*!`;
                                userState[phone] = { step: 'sin_citas', data: {} };
                            } else if (docConCupos2.length === 1) {
                                const docU2 = docConCupos2[0];
                                userState[phone].data.doctor = docU2;
                                userState[phone].data.doctores = docConCupos2;
                                const fmU2 = await getFechasDisponibles(docU2);
                                userState[phone].data.fechasOpciones = fmU2.fechas;
                                response = `😔 No hay más fechas con ese doctor.\n\n👨‍⚕️ Te asignamos con: *${docU2}*\n\n📅 *Fechas Disponibles:*\n\n${fmU2.texto}\n👉 *Escribe el número* de la fecha elegida:`;
                                userState[phone].step = 'elegir_fecha';
                            } else {
                                const lista2 = docConCupos2.map((d, i) => `${i + 1}️⃣ ${d}`).join('\n');
                                userState[phone].data.doctores = docConCupos2;
                                response = `😔 No hay más fechas con ese doctor.\n\n${lista2}\n\n👉 *Escribe el número:*`;
                                userState[phone].step = 'elegir_doctor';
                            }
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
                                try { await client.sendMessage(chatIdR, `❌ *SU CITA HA SIDO CANCELADA.*\n\n⏱️ El tiempo de *1 minuto* se agotó.\n\n👉 Escribe tu *Nombre y Apellidos* para reintentar.`); } catch (e) { }
                            }
                        });
                        if (!reservado) { response = `⛔ Horario reservado por otro paciente.\n\nEscribe *CITA* para reintentar.`; userState[phone] = { step: 'pedir_nombre', data: {} }; }
                        else {
                            userState[phone].data.hora = horaElegida;
                            userState[phone].data.claveReserva = clave;
                            const d = userState[phone].data;
                            response = `✅ *¡Horario reservado por 1 minuto!*\n\n📋 *Resumen de tu cita:*\n\n👤 *Paciente:* ${d.nombre}\n🪪 *DNI:* ${d.dni}\n🏥 *Consultorio:* ${d.consultorio}\n👨‍⚕️ *Doctor:* ${d.doctor}\n📅 *Fecha:* ${formatFechaBot(d.fecha)}\n⏰ *Hora:* ${formatHoraBot(d.hora)}\n\n⏳ Tienes *1 minuto* para confirmar.\n\n📱 Para confirmar, escribe tu *NÚMERO DE CELULAR* (9 dígitos):`;
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
                    await replyConTimeout(msg, response);
                    return; // ← FIX: evita que la validación de celular sobreescriba el mensaje de cancelación
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
                else if (step === 'elegir_doctor') { const lista = (d.doctores || []).map((doc, i) => `${i + 1}️⃣ ${doc}`).join('\n'); response = `❌ Opción no válida.\n\n${lista}`; }
                else if (step === 'elegir_fecha') { let t = ''; (d.fechasOpciones || []).forEach((f, i) => { t += `${i + 1}. ${formatFechaBot(f)}\n`; }); response = `❌ Escribe un número del 1 al ${(d.fechasOpciones || []).length}:\n\n${t}`; }
                else if (step === 'cita_hora') response = `❌ Escribe un número del 1 al ${(d.horasOpciones || []).length}:`;
                else if (step === 'pedir_telefono') response = '❌ Escribe tu *número de celular* (9 dígitos, empieza con 9), o *CANCELAR*.';
                else { userState[phone] = { step: 'pedir_nombre', data: {} }; const b = await getBienvenida(botConfig.botActivo); response = b.msg; }
            }

            await replyConTimeout(msg, response);
        } catch (innerErr) { console.error('Error procesando:', phone, innerErr); }
    });
});

// ══════════════════════════════════════════════════════════════
//  ARRANQUE
// ══════════════════════════════════════════════════════════════
// Mata procesos Chrome huérfanos que bloquean la carpeta de sesión
async function killOrphanedChrome() {
    if (process.platform !== 'win32') return;
    const { exec } = require('child_process');
    return new Promise((resolve) => {
        exec(
            `powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -match 'wwebjs_auth' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
            (err) => {
                if (err) console.warn('⚠️ No se pudieron cerrar procesos Chrome huérfanos:', err.message);
                else console.log('🧹 Procesos Chrome huérfanos eliminados.');
                resolve();
            }
        );
    });
}

// Limpia carpetas de sesión de forma segura (sin crash por EPERM)
function safeRemoveDir(dirPath) {
    try {
        if (fs.existsSync(dirPath)) {
            fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
            console.log(`🗑️ Eliminado: ${dirPath}`);
        }
    } catch (err) {
        console.warn(`⚠️ No se pudo eliminar ${dirPath}: ${err.message}. Se reintentará en el próximo arranque.`);
    }
}

async function start() {
    try { await connectDB(); }
    catch (e) { console.error('❌ Error Supabase:', e.message); console.warn('⚠️ El bot funcionará sin BD.'); }
    try {
        emitLog('Iniciando DentalBot — Sistema Unificado...', 'system');
        await client.initialize();
    } catch (e) {
        console.error('❌ Error WhatsApp en inicialización:', e.message);

        // Destruir cliente actual si quedó a medias
        try { await client.destroy(); } catch (err) { }

        // Matar procesos Chrome huérfanos que bloquean la sesión
        await killOrphanedChrome();
        // Esperar a que el SO libere los locks de archivo
        await new Promise(r => setTimeout(r, 2000));

        const sessionPath = path.join(__dirname, '.wwebjs_auth');
        const cachePath = path.join(__dirname, '.wwebjs_cache');
        safeRemoveDir(sessionPath);
        safeRemoveDir(cachePath);
        console.log('🔄 Reintentando iniciar en 5s...');

        // Reintentamos inicializar después de limpiar y destruir proceso previo
        setTimeout(() => {
            client.initialize().catch(err => {
                console.error('❌ Error fatal en reintento de inicialización:', err.message);
            });
        }, 5000);
    }
}

// Evitar que un unhandledRejection mate el proceso
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ [unhandledRejection]:', reason);
});

start();
