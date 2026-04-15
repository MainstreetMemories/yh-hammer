const express = require('express');
const fs = require('fs');
const { google } = require('googleapis');
const path = require('path');

// Credentials
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

// Get all jobs
app.get('/api/jobs', async (req, res) => {
  try {
    const result = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const months = result.data.sheets.map(s => s.properties.title).filter(t => t !== 'Customer Information');
    const allJobs = {};
    for (const month of months) {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:AE` });
      const jobs = (r.data.values || []).filter((job, idx) => {
        const addr = (job[0] || '').toString().toLowerCase();
        const owner = (job[5] || '').toString().toLowerCase();
        return addr && owner && addr !== 'address' && owner !== 'owner';
      });
      allJobs[month] = jobs.map((job, idx) => ({ row: idx + 4, address: job[0] || '', owner: job[5] || '', phone: job[15] || '', email: job[16] || '', totalCost: job[6] || '', tooop: job[11] || '' }));
    }
    res.json(allJobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Extract data (for confirmation flow)
app.post('/api/extract-data', async (req, res) => {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.openrouter_api_key;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });
    
    const { file, isPdf } = req.body;
    if (!file) return res.status(400).json({ error: 'No file provided' });
    
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'https://yh-hammer.onrender.com', 'X-Title': 'Yellow Hammer' },
      body: JSON.stringify({
        model: 'anthropic/claude-3-haiku',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Extract: Owner, Address (street city state zip), Phone, Email, Total Cost, T.O.O.P, Contract Date, Manufacturer, Shingle Type, Shingle Color, Ventilation Color, Drip Edge Color, Notes. Format: Field: Value' },
          { type: 'image_url', image_url: { url: isPdf ? `data:image/png;base64,${file.split('||PAGE||')[0]}` : `data:image/jpeg;base64,${file}` } }
        ]}],
        max_tokens: 1500
      })
    });
    
    if (!response.ok) return res.status(500).json({ error: 'AI extraction failed' });
    
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    
    const field = (n) => { const m = text.match(new RegExp(`(?:Field:\\s*)?${n}:\\s*(.+)`,'i')); return m ? m[1].trim() : ''; };
    const amounts = text.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
    
    const extracted = {
      owner: field('Owner') || field('Name') || '',
      address: field('Address') || field('Street') || '',
      phone: field('Phone') || '',
      email: field('Email') || '',
      totalCost: amounts[0]?.replace(/[$,]/g, '') || '0',
      toooP: field('T.O.O.P') || field('Out of Pocket') || amounts[1]?.replace(/[$,]/g, '') || '0',
      contractDate: field('Date') || field('Contract Date') || '',
      manufacturer: field('Manufacturer') || '',
      shingleType: field('Type') || field('Shingle Type') || '',
      shingleColor: field('Color') || field('Shingle Color') || '',
      ventilationColor: field('Ventilation') || '',
      dripEdgeColor: field('Drip Edge') || '',
      notes: field('Notes') || ''
    };
    
    res.json({ success: true, data: extracted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save extracted data
app.post('/api/save-extracted', async (req, res) => {
  try {
    const { month, owner, address, phone, email, totalCost, toooP, contractDate, manufacturer, shingleType, shingleColor, ventilationColor, dripEdgeColor, notes } = req.body;
    
    if (!month || !owner) return res.status(400).json({ error: 'Missing month or owner' });
    
    // 31 columns: A through AE
    const rowData = [
      address, '', contractDate, '', '', owner, totalCost, '0', '0', '0', totalCost, toooP, '0', '0', '', '',
      phone, email, '', dripEdgeColor, ventilationColor, manufacturer, shingleType, shingleColor, '', notes,
      '', '', '', '', ''
    ];
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:AE` });
    const nextRow = (r.data.values?.length || 0) + 4;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${month}!A${nextRow}:AE${nextRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] }
    });
    
    res.json({ success: true, month, owner });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
  }
});

// Request estimate - GroupMe
app.post('/api/request-estimate', async (req, res) => {
  const { address, owner } = req.body;
  const botId = process.env.GROUPME_BOT_ID || 'a36a8a2e2fc7ad27ece3f21843';
  
  try {
    await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: botId, text: `ESTIMATE NEEDED\n${owner || 'Unknown'}\n${address || 'Unknown'}` })
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Running'));
