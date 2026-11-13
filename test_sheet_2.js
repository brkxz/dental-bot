const { google } = require('googleapis');
const credenciales = require('./credenciales.json');
const SHEET_ID = '1FY_n_d8xUCjYbashyT4ueOH_id9jpob36yJ9N-Ww-pw';

const auth = new google.auth.GoogleAuth({
    credentials: { client_email: credenciales.client_email, private_key: credenciales.private_key },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const sheets = google.sheets({ version: 'v4', auth });

async function test() {
    try {
        // List all sheet tabs
        const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
        console.log("=== HOJAS EN EL SPREADSHEET ===");
        meta.data.sheets.forEach(s => {
            console.log(" -", s.properties.title);
        });

        // Try reading Sheet1
        console.log("\n=== CONTENIDO Sheet1 A1:E5 ===");
        const r1 = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Sheet1!A1:E5' });
        console.log(r1.data.values);
    } catch(err) {
        console.error("Error:", err.message);
    }
}
test();
