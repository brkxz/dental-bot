const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');
const http = require('http');
const fs = require('fs');
const path = require('path');

console.log('Iniciando servidor de prueba...');

// Servidor HTTP simple
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    
    if (req.url === '/panel') {
        const html = fs.readFileSync(path.join(__dirname, 'panel.html'), 'utf8');
        res.end(html);
        return;
    }
    
    res.end(`
        <html>
        <head><title>Test</title></head>
        <body>
            <h1>Bot Status: Running</h1>
            <p>Panel: <a href="/panel">Click aquí</a></p>
        </body>
        </html>
    `);
});

server.listen(3000, () => {
    console.log('Servidor HTTP iniciado en puerto 3000');
    console.log('Panel disponible en: http://localhost:3000/panel');
});

// Intentar conectar a MySQL
async function testDB() {
    try {
        const db = await mysql.createPool({
            host: 'localhost',
            user: 'root',
            password: '',
            database: 'odontologia_bot'
        });
        console.log('MySQL conectado exitosamente');
        await db.end();
    } catch (e) {
        console.error('Error MySQL:', e.message);
    }
}

// Intentar iniciar WhatsApp (sin bloquear)
async function testWhatsApp() {
    try {
        const client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: { 
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });
        
        client.on('qr', (qr) => {
            console.log('QR recibido - Bot listo para escanear');
        });
        
        client.on('ready', () => {
            console.log('WhatsApp conectado y listo');
        });
        
        client.on('disconnected', (reason) => {
            console.log('WhatsApp desconectado:', reason);
        });
        
        await client.initialize();
        console.log('WhatsApp inicializado');
    } catch (e) {
        console.error('Error WhatsApp:', e.message);
    }
}

// Ejecutar pruebas
testDB();
testWhatsApp();

console.log('Servidor de prueba iniciado completamente');
