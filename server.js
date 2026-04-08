import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credentials = JSON.parse(fs.readFileSync(path.join(__dirname, 'credentials.json')));

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = '1YmEsM3AvtIbNqto8DoYLMO48tH13UY23niGvRz5vOtU';

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const upload = multer({ dest: UPLOAD_DIR });

app.use(express.static('public'));
app.use(express.json());

function cleanCurrency(val) {
  if (!val) return '$0';
  const match = val.match(/\$?[\d,]+\.?\d*/);
  return match ? `$${match[0].replace('$','')}` : val;
}

function getMonth(dateStr) {
  if (!dateStr) return 'March';
  const m = parseInt(dateStr.split(/[\/\-]/)[0]);
  if (isNaN(m) || m < 1 || m > 12) return 'March';
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return months[m - 1];
}

app.post('/api/upload', upload.single('contract'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const newName = `${Date.now()}_${req.file.originalname}`;
    const newPath = path.join(UPLOAD_DIR, newName);
    fs.renameSync(req.file.path, newPath);
    
    // Simple extraction - update this with real extraction
    const data = { owner: 'Uploaded', date: '', totalCost: '$0' };
    
    const month = getMonth(data.date);
    const rowData = ['','',data.date,'','',data.owner,cleanCurrency(data.totalCost),'$0','$0','$0',cleanCurrency(data.totalCost),'$0','','Check','','','','','','','','','','',''];
    
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
    
    res.json({ success: true, month, owner: data.owner, file: newName, downloadUrl: `/api/download/${newName}` });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/downloads/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (fs.existsSync(filePath)) res.download(filePath);
  else res.status(404).send('Not found');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));
