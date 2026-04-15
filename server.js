const express = require('express');
const fs = require('fs');
const { google } = require('googleapis');
const path = require('path');

let credentials;
if (process.env.GOOGLE_CREDS) {
  credentials = JSON.parse(process.env.GOOGLE_CREDS);
} else {
  credentials = JSON.parse(fs.readFileSync(path.join(__dirname, 'credentials.json')));
}

const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });

const SPREADSHEET_ID = '1YmEsM3AvtIbNqto8DoYLMO48tH13UY23niGvRz5vOtU';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

app.get('/api/jobs', async (req, res) => {
  try {
    const result = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const months = result.data.sheets.map(s => s.properties.title).filter(t => t !== 'Customer Information');
    const allJobs = {};
    for (const month of months) {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A:AE' });
      const jobs = (r.data.values || []).filter((job, idx) => {
        const addr = (job[0] || '').toString().toLowerCase();
        const owner = (job[5] || '').toString().toLowerCase();
        return addr && owner && addr !== 'address' && owner !== 'owner';
      });
      allJobs[month] = jobs.map((job, idx) => ({ row: idx + 2, address: job[0] || '', owner: job[5] || '', phone: job[15] || '', email: job[16] || '', totalCost: job[6] || '', tooop: job[11] || '' }));
    }
    res.json(allJobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/extract-data', async (req, res) => {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.openrouter_api_key;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });
    
    const { file, isPdf } = req.body;
    if (!file) return res.status(400).json({ error: 'No file provided' });
    
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'HTTP-Referer': 'https://yh-hammer.onrender.com', 'X-Title': 'Yellow Hammer' },
      body: JSON.stringify({
        model: 'anthropic/claude-3-haiku',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Extract from FIRST page: Owner, Address, City, State, Zip, Phone, Email, Total Cost. Extract from SECOND page: Contract Date (after "YHP Representative Signature"). Format each as: Field: Value' },
          { type: 'image_url', image_url: { url: isPdf ? 'data:image/png;base64,' + file.split('||PAGE||')[0] : 'data:image/jpeg;base64,' + file } }
        ]}],
        max_tokens: 1500
      })
    });
    
    if (!response.ok) return res.status(500).json({ error: 'AI extraction failed' });
    
    const data = await response.json();
    const text = data.choices[0].message.content || '';
    
    const field = function(n) { var m = text.match(new RegExp('(?:Field:\\s*)?' + n + ':\\s*(.+)', 'i')); return m ? m[1].trim() : ''; };
    var amounts = text.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
    
    res.json({ success: true, data: {
      owner: field('Owner') || field('Name') || '',
      address: [field('Address'), field('City'), field('State'), field('Zip')].filter(function(x) { return x; }).join(', ') || field('Address') || '',
      phone: field('Phone') || '',
      email: field('Email') || '',
      totalCost: amounts[0] ? amounts[0].replace(/[$,]/g, '') : '0',
      toooP: field('T.O.O.P') ? field('T.O.O.P').replace(/[$,]/g, '') : (amounts[1] ? amounts[1].replace(/[$,]/g, '') : '0'),
      contractDate: field('Contract Date') || '',
      manufacturer: '',
      shingleType: '',
      shingleColor: '',
      notes: ''
    }});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save-extracted', async (req, res) => {
  try {
    var month = req.body.month;
    var owner = req.body.owner;
    var address = req.body.address || '';
    var phone = req.body.phone || '';
    var email = req.body.email || '';
    var totalCost = req.body.totalCost || '';
    var toooP = req.body.toooP || '';
    var contractDate = req.body.contractDate || '';
    
    if (!month || !owner) return res.status(400).json({ error: 'Missing month or owner' });
    
    var rowData = [address, '', contractDate, '', '', owner, totalCost, '0', '0', '0', totalCost, toooP, '0', '0', '', '', phone, email, '', '', '', '', '', '', '', '', '', '', '', '', ''];
    
    var r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A:AE' });
    var nextRow = (r.data.values ? r.data.values.length : 0) + 2;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: month + '!A' + nextRow + ':AE' + nextRow,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] }
    });
    
    res.json({ success: true, month: month, owner: owner });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, function() { console.log('Running'); });
