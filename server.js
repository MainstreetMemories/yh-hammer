const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { google } = require('googleapis');
const path = require('path');

const credentials = JSON.parse(fs.readFileSync(path.join(__dirname, 'credentials.json')));
const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });

const SPREADSHEET_ID = '1YmEsM3AvtIbNqto8DoYLMO48tH13UY23niGvRz5vOtU';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static('public'));
app.use(express.json());

// Get all jobs grouped by month
app.get('/api/jobs', async (req, res) => {
  const result = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const months = result.data.sheets.map(s => s.properties.title).filter(t => t !== 'Customer Information');
  const allJobs = {};
  for (const month of months) {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:AE` });
    allJobs[month] = (r.data.values || []).map((job, idx) => ({ row: idx + 4, address: job[0] || '', owner: job[5] || '', phone: job[15] || '', email: job[16] || '', totalCost: job[6] || '', tooop: job[11] || '' }));
  }
  res.json(allJobs);
});

// Get single job
app.get('/api/get-job', async (req, res) => {
  const { month, row } = req.query;
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A${row}:AE${row}` });
  const data = r.data.values?.[0] || [];
  res.json({
    address: data[0] || '', certOfComp: data[1] || '', contractDate: data[2] || '', estimateDate: data[3] || '', installDate: data[4] || '',
    owner: data[5] || '', totalCost: data[6] || '', requiredDownPayment: data[7] || '', financeAmount: data[8] || '', additionalExpense: data[9] || '',
    totalBalanceDue: data[10] || '', toooP: data[11] || '', depAmtHeld: data[12] || '', amountDue: data[13] || '', pmntMethod: data[14] || '',
    datePaid: data[16] || '', checkNum: data[17] || '', amountPaid: data[18] || '', dripEdgeColor: data[19] || '', ventilationColor: data[20] || '',
    manufacturer: data[21] || '', shingleType: data[22] || '', shingleColor: data[23] || '', estimatedSquares: data[24] || '', notes: data[25] || ''
  });
});

// Upload contract
app.post('/api/upload-json', upload.single('file'), async (req, res) => {
  if (!req.body.file) return res.status(400).json({ error: 'No file' });
  
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const image = req.body.file;
    const isPdf = req.body.isPdf;
    
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'https://yh-hammer.onrender.com', 'X-Title': 'Yellow Hammer' },
      body: JSON.stringify({
        model: 'anthropic/claude-3-haiku',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Extract: Owner, Address (street city state zip), Phone, Email, Total Cost, T.O.O.P, Contract Date, Manufacturer, Shingle Type, Shingle Color, Ventilation Color, Drip Edge Color, Notes. Format: Field: Value' },
          { type: 'image_url', image_url: { url: isPdf ? `data:image/png;base64,${image.split('||PAGE||')[0]}` : `data:image/jpeg;base64,${image}` } }
        ]}],
        max_tokens: 1500
      })
    });
    
    const data = await response.json();
    const text = data.choices[0]?.message?.content || '';
    
    const field = (n) => { const m = text.match(new RegExp(`(?:Field:\\s*)?${n}:\\s*(.+)`, 'i')); return m ? m[1].trim() : '' };
    const amounts = text.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
    
    const job = {
      owner: field('Owner') || field('Name') || 'Unknown',
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
    
    if (!job.owner || job.owner === 'Unknown') {
      return res.status(400).json({ error: 'Could not read - enter manually' });
    }
    
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    let month = 'April';
    for (let i = 0; i < months.length; i++) if (job.contractDate.toLowerCase().includes(months[i].toLowerCase())) month = months[i];
    
    const rowData = [job.address, '', job.contractDate, '', '', job.owner, job.totalCost, '0', '0', '0', job.totalCost, job.toooP, '0', '0', '', '', job.phone, job.email, '', job.dripEdgeColor, job.ventilationColor, job.manufacturer, job.shingleType, job.shingleColor, '', '', '', '', '', '', '', '', '', ''];
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:AE` });
    const nextRow = (r.data.values?.length || 0) + 4;
    
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A${nextRow}:AE${nextRow}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [rowData] } });
    
    res.json({ success: true, month, owner: job.owner, previewData: job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save confirmed job
app.post('/api/save-confirmed', async (req, res) => {
  const { month, row, ...data } = req.body;
  // Build row data from all fields - this would need full implementation
  res.json({ success: true, month: month || 'April' });
});

// Add estimate
app.post('/api/save-estimate', async (req, res) => {
  const { month, row, estimateDate, permitCost, primaryContractor, paid } = req.body;
  try {
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${month}!D${row}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[estimateDate]] } });
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${month}!Y${row}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[permitCost]] } });
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${month}!AC${row}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[primaryContractor]] } });
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${month}!AE${row}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[paid]] } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add install date
app.post('/api/save-install', async (req, res) => {
  const { month, row, installDate } = req.body;
  try {
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${month}!E${row}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[installDate]] } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Request estimate - send GroupMe notification
app.post('/api/request-estimate', async (req, res) => {
  const { month, address, owner } = req.body;
  const botId = 'a36a8a2e2fc7ad27ece3f21843';
  const text = `ESTIMATE NEEDED\n${owner}\n${address}`;
  
  try {
    await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: botId, text })
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Running'));
