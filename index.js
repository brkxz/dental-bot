
// ── Manejadores globales de errores ────────────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('❌ [uncaughtException] Error no capturado:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ [unhandledRejection] Promesa sin manejar:', reason);
});
// ────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const http = require('http');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Configuración Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

let lastQR = null;
let botStatus = 'Iniciando...';

const estilos = `
    body{font-family:Arial;text-align:center;background:#f0f0f0;padding:40px}
    h2{color:#128C7E}
    .ok{color:white;padding:12px 28px;border-radius:20px;display:inline-block;margin-top:20px;font-size:16px}
    img{border:5px solid #25D366;border-radius:10px}
`;

// Configuración y Horarios (Cargar desde Supabase)
let botConfig = { botActivo: false, modoViernes: false };
let horariosPanel = {};

async function cargarDatosDesdeSupabase() {
    try {
        // Cargar Horarios
        const { data: hData, error: hError } = await supabase.from('horarios_panel').select('*');
        if (hError) throw hError;
        
        horariosPanel = {};
        hData.forEach(row => {
            if (row.doctor === '_config') {
                botConfig = row.datos;
            } else {
                horariosPanel[row.doctor] = row.datos;
            }
        });
        console.log('📅 Datos cargados desde Supabase');
    } catch (e) {
        console.error('❌ Error cargando datos desde Supabase:', e.message);
    }
}

async function guardarConfigSupabase(data) {
    try {
        const { error } = await supabase.from('horarios_panel').upsert({ 
            doctor: '_config', 
            datos: data 
        });
        if (error) throw error;
    } catch (e) { console.error('Error guardando config en Supabase:', e); }
}

async function guardarHorariosSupabase(doctor, datos) {
    try {
        const { error } = await supabase.from('horarios_panel').upsert({ 
            doctor: doctor, 
            datos: datos 
        });
        if (error) throw error;
    } catch (e) { console.error('Error guardando horarios en Supabase:', e); }
}

// Utilidades de formato
function formatFechaBot(f) {
    if (!f) return '';
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

function formatFechaParaSheet(fecha) {
    if (!fecha) return '';
    let d;
    if (typeof fecha === 'string') {
        const parts = fecha.split('T')[0].split('-');
        d = new Date(parts[0], parts[1] - 1, parts[2]);
    } else if (fecha instanceof Date) {
        d = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
    } else {
        d = new Date(fecha);
    }
    const meses = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
    const dia = String(d.getDate()).padStart(2, '0');
    const mes = meses[d.getMonth()];
    return `${dia} DE ${mes}`;
}

function formatearDoctor(doctor) {
    if (!doctor) return '';
    const mapping = {
        'C.D. Manuel Jesús Romani Maldonado': 'C.D. MANUEL JESUS ROMANI MALDONADO',
        'C.D. Elio Elvis Támara Trinidad': 'C.D. ELIO ELVIS TÀMARA TRINIDAD',
        'C.D. Jimy Aldo Osorio Rosales': 'C.D. JIMY ALDO OSORIO ROSALES',
        'C.D. Fernando Fredy Bustamante Tolentino': 'C.D. FERNANDO FREDY BUSTAMANTE TOLENTINO',
        'C.D. Manuel Romani': 'C.D. MANUEL JESUS ROMANI MALDONADO',
        'C.D. Elio Támara': 'C.D. ELIO ELVIS TÀMARA TRINIDAD',
        'C.D. Jimy Osorio': 'C.D. JIMY ALDO OSORIO ROSALES',
        'C.D. Fernando Bustamante': 'C.D. FERNANDO FREDY BUSTAMANTE TOLENTINO'
    };
    if (mapping[doctor]) return mapping[doctor];
    return doctor.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function formatearHora(hora) {
    if (!hora) return '';
    hora = hora.substring(0, 5);
    if (hora.startsWith('0') && hora.length > 1) {
        hora = hora.substring(1);
    }
    return hora;
}

// Servidor HTTP
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        
        // Ruta raíz - Estado del Bot
        if (url.pathname === '/' || url.pathname === '') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            if (lastQR) {
                const qrImage = await QRCode.toDataURL(lastQR);
                res.end(`<html><head><title>Bot Odontología</title><meta http-equiv="refresh" content="15"><style>${estilos}</style></head>
                <body><h2>🏥 Bot WhatsApp - Odontología</h2><img src="${qrImage}" width="300"/><br>
                <div class="ok" style="background:#25D366">${botStatus}</div></body></html>`);
            } else {
                const color = botStatus.includes('✅') ? '#25D366' : '#f39c12';
                res.end(`<html><head><title>Bot Odontología</title><meta http-equiv="refresh" content="4"><style>${estilos}</style></head>
                <body><h2>🏥 Bot WhatsApp - Odontología</h2><div class="ok" style="background:${color}">${botStatus}</div></body></html>`);
            }
            return;
        }

        // Ruta panel
        if (url.pathname === '/panel') {
            const html = fs.readFileSync(path.join(__dirname, 'panel.html'), 'utf8');
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(html);
            return;
        }

        // API endpoints
        if (url.pathname === '/guardar-horarios' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const datos = JSON.parse(body);
                    const doctorDatos = { dias: datos.dias, horarios: datos.horarios };
                    horariosPanel[datos.doctor] = doctorDatos;
                    await guardarHorariosSupabase(datos.doctor, doctorDatos);
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ ok: true }));
                } catch (e) {
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        if (url.pathname === '/citas-doctor') {
            const doctor = url.searchParams.get('doctor');
            let query = supabase.from('citas').select('*');
            if (doctor && doctor !== 'null' && doctor !== '') {
                query = query.eq('doctor', doctor);
            }
            const { data, error } = await query.order('fecha', { ascending: false }).order('hora', { ascending: false });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(data || []));
            return;
        }

        if (url.pathname === '/horarios-panel') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(horariosPanel));
            return;
        }

        if (url.pathname === '/config-bot') {
            if (req.method === 'POST') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    const datos = JSON.parse(body);
                    if (datos.botActivo !== undefined) botConfig.botActivo = !!datos.botActivo;
                    if (datos.modoViernes !== undefined) botConfig.modoViernes = !!datos.modoViernes;
                    await guardarConfigSupabase(botConfig);
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ ok: true, ...botConfig }));
                });
            } else {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(botConfig));
            }
            return;
        }

        if (url.pathname === '/sync-drive' && req.method === 'POST') {
            const { data: citasDB, error } = await supabase.from('citas')
                .select('*').eq('estado', 'confirmada');
            
            const citas = (citasDB || []).filter(c => {
                const doctorPanel = horariosPanel[c.doctor];
                return doctorPanel?.horarios?.[c.fecha]?.includes(c.hora.substring(0, 5));
            });

            const sheetURL = "https://script.google.com/macros/s/AKfycbzNF-Jt4HVJuli33Y_lFZSFSmQQRlTpPPi85z11RjOK5ODLi2RGhSAHpKV-AEQzldJrpA/exec";
            let count = 0;
            for (const c of citas) {
                const payload = {
                    fecha: formatFechaParaSheet(c.fecha),
                    doctor: formatearDoctor(c.doctor),
                    hora: formatearHora(c.hora),
                    nombre: c.nombre, dni: c.dni, edad: c.edad, telefono: c.telefono
                };
                try {
                    const r = await fetch(sheetURL, { 
                        method: 'POST', body: JSON.stringify(payload),
                        headers: { 'Content-Type': 'application/json' }
                    });
                    if (r.ok) count++;
                } catch(e) {}
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, synced: count, total: citas.length }));
            return;
        }

        // Página de estado / QR (Legacy)
        if (url.pathname === '/qr') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            if (lastQR) {
                const qrImage = await QRCode.toDataURL(lastQR);
                res.end(`<html><head><title>Bot Odontología</title><meta http-equiv="refresh" content="15"><style>${estilos}</style></head>
                <body><h2>🏥 Bot WhatsApp - Odontología</h2><img src="${qrImage}" width="300"/><br>
                <div class="ok" style="background:#25D366">${botStatus}</div></body></html>`);
            } else {
                const color = botStatus.includes('✅') ? '#25D366' : '#f39c12';
                res.end(`<html><head><title>Bot Odontología</title><meta http-equiv="refresh" content="4"><style>${estilos}</style></head>
                <body><h2>🏥 Bot WhatsApp - Odontología</h2><div class="ok" style="background:${color}">${botStatus}</div></body></html>`);
            }
            return;
        }

        // Si no es ninguna de las anteriores, devolver 404
        res.statusCode = 404;
        res.end('Not Found');

    } catch (error) {
        console.error('Error en servidor HTTP:', error);
        res.statusCode = 500;
        res.end('Error interno');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});

// Lógica del Bot WhatsApp
const doctoresGeneral = ['C.D. Manuel Jesús Romani Maldonado', 'C.D. Elio Elvis Támara Trinidad', 'C.D. Fernando Fredy Bustamante Tolentino'];
const doctoresPediatria = ['C.D. Manuel Jesús Romani Maldonado', 'C.D. Jimy Aldo Osorio Rosales', 'C.D. Fernando Fredy Bustamante Tolentino'];

const userState = {};
const reservasTemp = {};

function claveReserva(fecha, hora, doctor) { return `${fecha}|${hora}|${doctor}`; }
function liberarReserva(clave) { delete reservasTemp[clave]; }
function crearReserva(clave, phone, onVencer) {
    if (reservasTemp[clave] && reservasTemp[clave].phone !== phone) return false;
    reservasTemp[clave] = { phone, timer: setTimeout(onVencer, 60000) };
    return true;
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true, 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // Esto ayuda mucho en entornos con poca RAM como Render Free
            '--disable-gpu'
        ] 
    }
});

client.on('qr', (qr) => {
    lastQR = qr;
    botStatus = 'Escanea el QR 👇';
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    lastQR = null;
    botStatus = '✅ Bot conectado!';
    console.log('✅ Bot listo!');
});

async function getFechasDisponibles(doctor) {
    const panel = horariosPanel[doctor];
    if (!panel?.horarios) return { fechas: [], texto: '' };
    
    const hoy = new Date().toISOString().split('T')[0];
    const fechasLibres = [];
    
    for (const fecha of Object.keys(panel.horarios).sort()) {
        if (fecha < hoy) continue;
        const { data: ocupadas } = await supabase.from('citas').select('hora').eq('fecha', fecha).eq('doctor', doctor).eq('estado', 'confirmada');
        const ocupadasList = (ocupadas || []).map(r => r.hora.substring(0, 5));
        const libres = panel.horarios[fecha].filter(h => !ocupadasList.includes(h));
        if (libres.length > 0) fechasLibres.push(fecha);
    }
    
    let texto = fechasLibres.map((f, i) => `${i + 1}. ${formatFechaBot(f)}`).join('\n');
    return { fechas: fechasLibres, texto };
}

async function getHorasDisponibles(fecha, doctor) {
    const panel = horariosPanel[doctor];
    if (!panel?.horarios?.[fecha]) return { horas: [], texto: '' };
    
    const { data: ocupadas } = await supabase.from('citas').select('hora').eq('fecha', fecha).eq('doctor', doctor).eq('estado', 'confirmada');
    const ocupadasList = (ocupadas || []).map(r => r.hora.substring(0, 5));
    const libres = panel.horarios[fecha].filter(h => !ocupadasList.includes(h));
    
    let texto = libres.map((h, i) => `${i + 1}. ${formatHoraBot(h)}`).join('\n');
    return { horas: libres, texto };
}

client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast' || msg.isGroupMsg) return;
    
    const phone = msg.from.replace(/@.*$/, '');
    const text = msg.body.trim();
    
    if (!userState[phone]) userState[phone] = { step: 'inicio', data: {} };
    const state = userState[phone];

    try {
        if (text.toLowerCase() === 'cancelar') {
            userState[phone] = { step: 'inicio', data: {} };
            return msg.reply('❌ Proceso cancelado.');
        }

        if (state.step === 'inicio' || ['hola', 'cita', 'menu'].includes(text.toLowerCase())) {
            if (!botConfig.botActivo) return msg.reply('Lo sentimos, el bot está desactivado por ahora.');
            state.step = 'pedir_nombre';
            return msg.reply('🦷 *Bienvenido* 🦷\nPor favor, escribe el *Nombre y Apellido* del paciente:');
        }

        if (state.step === 'pedir_nombre') {
            state.data.nombre = text;
            state.step = 'pedir_dni';
            return msg.reply('🪪 Escribe el *DNI* (8 dígitos):');
        }

        if (state.step === 'pedir_dni') {
            if (!/^\d{8}$/.test(text)) return msg.reply('❌ DNI inválido. Deben ser 8 números:');
            const { data: existe } = await supabase.from('citas').select('id').eq('dni', text).eq('estado', 'confirmada').single();
            if (existe) return msg.reply('⚠️ Este DNI ya tiene una cita confirmada.');
            state.data.dni = text;
            state.step = 'pedir_edad';
            return msg.reply('🎂 ¿Qué edad tiene el paciente?');
        }

        if (state.step === 'pedir_edad') {
            const edad = parseInt(text);
            if (isNaN(edad)) return msg.reply('❌ Edad inválida:');
            state.data.edad = edad;
            const doctores = edad <= 11 ? doctoresPediatria : doctoresGeneral;
            state.data.doctores = doctores;
            let lista = doctores.map((d, i) => `${i + 1}. ${d}`).join('\n');
            state.step = 'elegir_doctor';
            return msg.reply(`👨‍⚕️ Elige un doctor:\n${lista}`);
        }

        if (state.step === 'elegir_doctor') {
            const idx = parseInt(text) - 1;
            if (isNaN(idx) || !state.data.doctores[idx]) return msg.reply('❌ Elige una opción válida:');
            state.data.doctor = state.data.doctores[idx];
            const { fechas, texto } = await getFechasDisponibles(state.data.doctor);
            if (fechas.length === 0) return msg.reply('😔 No hay fechas disponibles.');
            state.data.fechas = fechas;
            state.step = 'elegir_fecha';
            return msg.reply(`📅 Elige una fecha:\n${texto}`);
        }

        if (state.step === 'elegir_fecha') {
            const idx = parseInt(text) - 1;
            if (isNaN(idx) || !state.data.fechas[idx]) return msg.reply('❌ Elige una opción válida:');
            state.data.fecha = state.data.fechas[idx];
            const { horas, texto } = await getHorasDisponibles(state.data.fecha, state.data.doctor);
            state.data.horas = horas;
            state.step = 'elegir_hora';
            return msg.reply(`⏰ Elige una hora:\n${texto}`);
        }

        if (state.step === 'elegir_hora') {
            const idx = parseInt(text) - 1;
            if (isNaN(idx) || !state.data.horas[idx]) return msg.reply('❌ Elige una opción válida:');
            state.data.hora = state.data.horas[idx];
            
            const { error } = await supabase.from('citas').insert([{
                telefono: phone, nombre: state.data.nombre, dni: state.data.dni,
                edad: state.data.edad, doctor: state.data.doctor,
                fecha: state.data.fecha, hora: state.data.hora, estado: 'confirmada'
            }]);
            
            if (error) throw error;
            state.step = 'inicio';
            return msg.reply(`✅ *Cita confirmada!*\n📅 ${formatFechaBot(state.data.fecha)} a las ${formatHoraBot(state.data.hora)}\n👨‍⚕️ ${state.data.doctor}`);
        }

    } catch (e) {
        console.error(e);
        msg.reply('❌ Error al procesar. Inténtalo de nuevo.');
    }
});

async function start() {
    await cargarDatosDesdeSupabase();
    client.initialize();
}

start();
