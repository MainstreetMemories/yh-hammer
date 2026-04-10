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
app.use(express.json({ limit: '20mb' }));

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

app.post('/api/upload', async (req, res) => {
  console.log('=== UPLOAD REQUEST ===');
  const { image, mimeType } = req.body;
  
  if (!image) {
    console.log('ERROR: No image');
    return res.status(400).json({ error: 'No image provided' });
  }
  
  console.log('Image length:', image.length);
  
  try {
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
            { type: 'text', text: 'Extract these fields from the contract: Owner (property owner name), Address (property address), Phone, Email, Total Cost, Contract Date, Shingle Manufacturer, Shingle Type. Format each as "Field: Value"' },
            { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${image}` } }
          ]
        }],
        max_tokens: 1500
      })
    });
    
    const data = await response.json();
    const text = data.choices[0]?.message?.content || '';
    console.log('AI result:', text.substring(0, 200));
    
    // Parse result
    const field = (name) => { const m = text.match(new RegExp(`(?:Field:\\s*)?${name}:?\\s*([^\\n]+)`, 'i')); return m ? m[1].trim() : ''; };
    const amounts = text.match(/\$[\d,]+\.?\d{0,2}/g) || [];
    
    const jobData = {
      owner: field('Owner') || 'Unknown',
      address: field('Address') || field('Property') || '',
      phone: field('Phone') || '',
      email: field('Email') || '',
      totalCost: amounts[0]?.replace(/[$,]/g, '') || '0',
      balanceDue: amounts[0]?.replace(/[$,]/g, '') || '0',
      tooP: amounts[1]?.replace(/[$,]/g, '') || field('Deductible') || field('Insurance') || '0',
      date: field('Date') || field('Contract Date') || '',
      manufacturer: field('Manufacturer') || field('Shingle Manufacturer') || '',
      shingleType: field('Type') || field('Shingle Type') || ''
    };
    
    console.log('Parsed:', JSON.stringify(jobData));
    
    if (!jobData.owner || jobData.owner === 'Unknown' || jobData.owner.length < 3) {
      console.log('ERROR: Could not extract valid data');
      return res.status(400).json({ error: 'Could not read this contract. Please enter manually using Edit Records.' });
    }
    
    // Determine month
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    let month = 'April';
    for (let i = 0; i < months.length; i++) if (jobData.date.toLowerCase().includes(months[i].toLowerCase())) month = months[i];
    const m = jobData.date.match(/(\d{1,2})[\/\-]/); 
    if (m) { const n = parseInt(m[1]); if (n >= 1 && n <= 12) month = months[n - 1]; }
    
    const rowData = [jobData.address, '', jobData.date, '', '', jobData.owner, jobData.totalCost, '$0', '$0', '$0', jobData.balanceDue, jobData.tooP, '', '', 'Check', jobData.phone, jobData.email, '', 'Black', 'Black', jobData.manufacturer, jobData.shingleType, '', '', ''];
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:A` });
    const nextRow = (r.data.values?.length || 0) + 1;
    
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A${nextRow}:Z${nextRow}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [rowData] } });
    
    console.log('SAVED to', month, 'row', nextRow);
    res.json({ success: true, month, owner: jobData.owner });
  } catch (err) {
    console.error('ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('App running on port', process.env.PORT || 3000));