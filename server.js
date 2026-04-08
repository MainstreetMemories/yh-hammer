import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Get credentials from environment variable
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');

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

app.post('/api/upload', upload.single('contract'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const newName = `${Date.now()}_${req.file.originalname}`;
    fs.renameSync(req.file.path, path.join(UPLOAD_DIR, newName));
    
    // Simple test - just add placeholder row
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
    
    res.json({ success: true, month, owner: 'Test Owner', file: newName });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));
