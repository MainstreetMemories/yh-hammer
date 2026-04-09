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
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static('public'));

// Accept both JSON and FormData
const upload = multer();

app.post('/api/upload', upload.any(), async (req, res) => {
  console.log('=== UPLOAD ===');
  console.log('Files:', req.files);
  console.log('Body:', req.body);
  console.log('Content-Type:', req.get('content-type'));
  
  // Handle FormData (from form upload)
  let image = req.body.image || (req.files && req.files[0] && req.files[0].fieldname === 'image' ? req.files[0].buffer.toString('base64') : null);
  let mimeType = req.body.mimeType || 'image/jpeg';
  
  // If image is a buffer (from multer), convert to base64
  if (!image && req.files && req.files.length > 0) {
    const file = req.files[0];
    image = file.buffer.toString('base64');
    mimeType = file.mimetype || 'image/jpeg';
  }
  
  // Handle JSON (from fetch with JSON)
  if (req.body.image) {
    image = req.body.image;
    mimeType = req.body.mimeType || 'image/jpeg';
  }
  
  console.log('Image length:', image?.length || 0);
  console.log('mimeType:', mimeType);
  
  if (!image) {
    console.log('ERROR: No image');
    return res.status(400).json({ error: 'No image provided' });
  }
  
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
    console.log('AI result:', text?.substring(0, 100));
    
    const field = (name) => { const m = text.match(new RegExp(`(?:Field:\\s*)?${name}:?\\s*([^\\n]+)`, 'i')); return m ? m[1].trim() : ''; };
    const amounts = text.match(/\$[\d,]+\.?\d{0,2}/g) || [];
    
    const jobData = {
      owner: field('Owner') || 'Unknown',
      address: field('Address') || '',
      phone: field('Phone') || '',
      email: field('Email') || '',
      totalCost: amounts[0]?.replace(/[$,]/g, '') || '0',
      balanceDue: amounts[0]?.replace(/[$,]/g, '') || '0',
      tooP: amounts[1]?.replace(/[$,]/g, '') || field('Deductible') || '0',
      date: field('Date') || field('Contract Date') || '',
      manufacturer: field('Manufacturer') || field('Shingle') || '',
      shingleType: field('Type') || field('Shingle Type') || ''
    };
    
    if (!jobData.owner || jobData.owner === 'Unknown' || jobData.owner.length < 3) {
      return res.status(400).json({ error: 'Could not read contract. Please enter manually.' });
    }
    
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    let month = 'April';
    for (let i = 0; i < months.length; i++) if (jobData.date.toLowerCase().includes(months[i].toLowerCase())) month = months[i];
    const m = jobData.date.match(/(\d{1,2})[\/\-]/); 
    if (m) { const n = parseInt(m[1]); if (n >= 1 && n <= 12) month = months[n - 1]; }
    
    const rowData = [jobData.address, '', jobData.date, '', '', jobData.owner, jobData.totalCost, '$0', '$0', '$0', jobData.balanceDue, jobData.tooP, '', '', 'Check', jobData.phone, jobData.email, '', 'Black', 'Black', jobData.manufacturer, jobData.shingleType, '', '', ''];
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:A` });
    const nextRow = (r.data.values?.length || 0) + 1;
    
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A${nextRow}:Z${nextRow}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [rowData] } });
    
    console.log('SAVED:', month, 'row', nextRow);
    res.json({ success: true, month, owner: jobData.owner });
  } catch (err) {
    console.error('ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('App running'));