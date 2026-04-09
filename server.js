import express from 'express';
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
app.use(express.static('public'));

app.get('/api/jobs', async (req, res) => {
  const result = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const months = result.data.sheets.map(s => s.properties.title).filter(t => t !== 'Customer Information');
  const allJobs = {};
  for (const month of months) {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A4:Z` });
    allJobs[month] = (r.data.values || []).map((job, idx) => ({ row: idx + 4, address: job[0] || '', owner: job[5] || '', phone: job[15] || '', email: job[16] || '', contractDate: job[2] || '', totalCost: job[6] || '', manufacturer: job[21] || '', shingleType: job[22] || '' }));
  }
  res.json(allJobs);
});

app.post('/api/jobs/update', async (req, res) => {
  const { month, row, field, value } = req.body;
  const map = { address: 'A', owner: 'F', totalCost: 'G', phone: 'P', email: 'Q', manufacturer: 'W', shingleType: 'X', notes: 'Z' };
  if (!map[field]) return res.status(400).json({ error: 'Invalid field' });
  await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${month}!${map[field]}${row}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[value]] } });
  res.json({ success: true });
});

async function extractFromImage(base64, mimeType) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  console.log('Calling AI...');
  
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'https://yh-hammer.onrender.com', 'X-Title': 'Yellow Hammer' },
    body: JSON.stringify({
      model: 'anthropic/claude-3-haiku',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Extract: Owner, Address, Phone, Email, Total Cost, Date, Shingle Manufacturer, Shingle Type. Format: Field: Value' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
        ]
      }],
      max_tokens: 1500
    })
  });
  
  const data = await response.json();
  console.log('AI status:', response.status);
  return data.choices[0]?.message?.content || '';
}

function parseOCR(text) {
  const amounts = text.match(/\$[\d,]+\.?\d{0,2}/g) || [];
  const field = (name) => { const m = text.match(new RegExp(`(?:Field:\\s*)?${name}:?\\s*([^\\n]+)`, 'i')); return m ? m[1].trim() : ''; };
  return { 
    owner: field('Owner') || 'Unknown', 
    address: field('Address') || '', 
    phone: field('Phone') || '', 
    email: field('Email') || '', 
    totalCost: amounts[0]?.replace(/[$,]/g, '') || '0', 
    balanceDue: amounts[0]?.replace(/[$,]/g, '') || '0', 
    tooP: amounts[1]?.replace(/[$,]/g, '') || field('Deductible') || '0', 
    date: field('Date') || field('Contract Date') || '', 
    manufacturer: field('Manufacturer') || field('Shingle Manufacturer') || '', 
    shingleType: field('Type') || field('Shingle Type') || '' 
  };
}

function getMonth(dateStr) {
  if (!dateStr) return 'April';
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  for (let i = 0; i < months.length; i++) if (dateStr.toLowerCase().includes(months[i].toLowerCase())) return months[i];
  const m = dateStr.match(/(\d{1,2})[\/\-]/); 
  if (m) { const n = parseInt(m[1]); if (n >= 1 && n <= 12) return months[n - 1]; }
  return 'April';
}

app.post('/api/upload', async (req, res) => {
  console.log('=== UPLOAD ===');
  console.log('Body keys:', Object.keys(req.body));
  
  const { image, mimeType } = req.body;
  
  if (!image) {
    console.log('ERROR: No image received');
    return res.status(400).json({ error: 'No image provided. Please try uploading again.' });
  }
  
  console.log('Image length:', image?.length || 0);
  console.log('mimeType:', mimeType);
  
  try {
    const aiResult = await extractFromImage(image, mimeType || 'image/jpeg');
    console.log('AI result:', aiResult?.substring(0, 100));
    
    const data = parseOCR(aiResult);
    console.log('Parsed:', JSON.stringify(data));
    
    if (!data.owner || data.owner === 'Unknown' || data.owner.length < 3) {
      return res.status(400).json({ error: 'Could not read this contract. Please enter manually.' });
    }
    
    const month = getMonth(data.date);
    const rowData = [data.address, '', data.date, '', '', data.owner, data.totalCost, '$0', '$0', '$0', data.balanceDue, data.tooP, '', '', 'Check', data.phone, data.email, '', 'Black', 'Black', data.manufacturer, data.shingleType, '', '', ''];
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:A` });
    const nextRow = (r.data.values?.length || 0) + 1;
    
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A${nextRow}:Z${nextRow}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [rowData] } });
    
    console.log('SAVED:', month, 'row', nextRow);
    res.json({ success: true, month, owner: data.owner });
  } catch (err) {
    console.error('ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('App running'));