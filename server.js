const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');

console.log('GCP_PROJECT_ID:', process.env.GCP_PROJECT_ID);
console.log('GCP_CLIENT_EMAIL:', process.env.GCP_CLIENT_EMAIL);

// Build credentials from individual env vars
const credentials = {
  type: 'service_account',
  project_id: process.env.GCP_PROJECT_ID || '',
  private_key: process.env.GCP_PRIVATE_KEY.split('\\n').join('\n'),
  client_email: process.env.GCP_CLIENT_EMAIL || '',
  client_id: process.env.GCP_CLIENT_ID || ''
};

console.log('Credentials loaded, client_email:', credentials.client_email);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = '1YmEsM3AvtIbNqto8DoYLMO48tH13UY23niGvRz5vOtU';

const app = express();
const upload = multer({ dest: '/tmp' });

app.use(express.static('public'));
app.use(express.json());

app.post('/api/upload', upload.single('contract'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    
    const month = 'March';
    const rowData = ['Test Address', '', '3/15/26', '', '', 'Test Owner', '$5000', '$0', '$0', '$0', '$5000', '$500', '', 'Check', '', '', '', '', '', '', '', '', '', '', ''];
    
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${month}!A:A`
    });
    const nextRow = (result.data.values?.length || 0) + 1;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${month}!A${nextRow}:Z${nextRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] }
    });
    
    res.json({ success: true, month, owner: 'Test' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('App running on port ' + PORT));
