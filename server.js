import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credentials = JSON.parse(fs.readFileSync(path.join(__dirname, 'credentials.json')));
const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = '1YmEsM3AvtIbNqto8DoYLMO48tH13UY23niGvRz5vOtU';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static('public'));
app.use(express.json());

app.get('/api/jobs', async (req, res) => {
  const result = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const months = result.data.sheets.map(s => s.properties.title).filter(t => t !== 'Customer Information');
  const allJobs = {};
  for (const month of months) {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A4:Z` });
    allJobs[month] = (r.data.values || []).map((job, idx) => ({ row: idx + 4, address: job[0] || '', owner: job[5] || '', phone: job[15] || '', email: job[16] || '', totalCost: job[6] || '' }));
  }
  res.json(allJobs);
});

app.post('/api/upload', upload.any(), async (req, res) => {
  console.log('=== UPLOAD ===');
  console.log('Files:', req.files?.map(f => ({ field: f.fieldname, size: f.size })));
  
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No file' });
  }
  
  const file = req.files[0];
  const image = file.buffer.toString('base64');
  const mimeType = file.mimetype || 'image/jpeg';
  
  console.log('Image size:', image.length);
  
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'https://yh-hammer.onrender.com', 'X-Title': 'Yellow Hammer' },
      body: JSON.stringify({
        model: 'anthropic/claude-3-haiku',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Extract: Owner, Address, Phone, Email, Total Cost, Date, Shingle info. Format: Field: Value' },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${image}` } }
          ]
        }],
        max_tokens: 1500
      })
    });
    
    const data = await response.json();
    const text = data.choices[0]?.message?.content || '';
    console.log('AI:', text.substring(0, 100));
    
    const field = (n) => { const m = text.match(new RegExp(`(?:Field:\\s*)?${n}:?\\s*([^\\n]+)`, 'i')); return m ? m[1].trim() : ''; };
    const amounts = text.match(/\$[\d,]+\.?\d{0,2}/g) || [];
    
    const job = {
      owner: field('Owner') || 'Unknown',
      address: field('Address') || '',
      phone: field('Phone') || '',
      email: field('Email') || '',
      totalCost: amounts[0]?.replace(/[$,]/g, '') || '0',
      date: field('Date') || field('Contract Date') || '',
      manufacturer: field('Manufacturer') || '',
      shingleType: field('Type') || ''
    };
    
    if (!job.owner || job.owner === 'Unknown') {
      return res.status(400).json({ error: 'Could not read - enter manually' });
    }
    
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    let month = 'April';
    for (let i = 0; i < months.length; i++) if (job.date.toLowerCase().includes(months[i].toLowerCase())) month = months[i];
    
    const rowData = [job.address, '', job.date, '', '', job.owner, job.totalCost, '$0', '$0', '$0', job.totalCost, '$0', '', '', 'Check', job.phone, job.email, '', 'Black', 'Black', job.manufacturer, job.shingleType, '', '', ''];
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:A` });
    const nextRow = (r.data.values?.length || 0) + 1;
    
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A${nextRow}:Z${nextRow}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [rowData] } });
    
    res.json({ success: true, month, owner: job.owner });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Running'));