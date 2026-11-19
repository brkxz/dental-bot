// Test rápido de autenticación Google Sheets
const { google } = require('googleapis');
const creds = require('./credenciales.json');

async function test() {
    console.log('🔑 Client email:', creds.client_email);
    console.log('🔑 Key ID:', creds.private_key_id);
    console.log('🔑 Private key empieza con:', creds.private_key.substring(0, 40));
    console.log('🔑 Private key tiene newlines reales:', creds.private_key.includes('\n'));
    
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: creds.client_email,
                private_key: creds.private_key
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        });
        
        const client = await auth.getClient();
        console.log('✅ Autenticación exitosa! Token obtenido.');
        
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.get({
            spreadsheetId: '1NbAtoy6opm-iVfWUp2-ucDOXyPRSFIoHferhib7DTKU'
        });
        console.log('✅ Google Sheets accesible! Título:', res.data.properties.title);
        console.log('✅ Pestañas:', res.data.sheets.map(s => s.properties.title).join(', '));
    } catch (err) {
        console.error('❌ Error:', err.message);
        if (err.response) {
            console.error('❌ Status:', err.response.status);
            console.error('❌ Data:', JSON.stringify(err.response.data));
        }
    }
}

test();

