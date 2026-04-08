const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');

console.log('Starting app...');
console.log('GCP_PROJECT_ID:', process.env.GCP_PROJECT_ID ? 'SET' : 'MISSING');
console.log('GCP_CLIENT_EMAIL:', process.env.GCP_CLIENT_EMAIL ? 'SET' : 'MISSING');
console.log('GCP_PRIVATE_KEY_B64:', process.env.GCP_PRIVATE_KEY_B64 ? 'SET' : 'MISSING');

const credentials = {
  type: 'service_account',
  project_id: process.env.GCP_PROJECT_ID || '',
  private_key: Buffer.from(process.env.GCP_PRIVATE_KEY_B64, 'base64').toString('utf8'),
  client_email: process.env.GCP_CLIENT_EMAIL || '',
  client_id: process.env.GCP_CLIENT_ID || ''
};

console.log('Credentials loaded, client_email:', credentials.client_email);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

console.log('Auth created, now creating sheets client...');

const sheets = google.sheets({ version: 'v4', auth });
console.log('Sheets client created');

const SPREADSHEET_ID = '1YmEsM3AvtIbNqto8DoYLMO48tH13UY23niGvRz5vOtU';

const app = express();
const upload = multer({ dest: '/tmp' });

app.use(express.static('public'));
app.use(express.json());

console.log('Express app configured');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('App running on port ' + PORT));
