const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { google } = require('googleapis');
const path = require('path');

// Handle credentials - from env var or file
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
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

// Column mapping: A=0, B=1, ..., AE=30
// A=Address, B=CertOfComp, C=ContractDate, D=EstimateDate, E=InstallDate
// F=Owner, G=TotalCost, H=RequiredDownPayment, I=FinanceAmount, J=AdditionalExpense
// K=TotalBalanceDue, L=T.O.O.P, M=DEPtAmtHeld, N=AmountDue, O=PmntMethod
// P=(empty), Q=DatePaid, R=CheckNum, S=AmountPaid, T=DripEdgeColor
// U=VentilationColor, V=Manufacturer, W=ShingleType, X=ShingleColor, Y=EstimatedSquares, Z=Notes
// AA-AE=(empty for future use)

// Helper: check if row is a header or empty
function isValidJob(job) {
  const addr = (job[0] || '').toString().toLowerCase();
  const owner = (job[5] || '').toString().toLowerCase();
  if (!addr || !owner) return false;
  if (addr === 'address' || owner === 'owner') return false;
  return true;
}

// Get all jobs grouped by month
app.get('/api/jobs', async (req, res) => {
  try {
    const result = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const months = result.data.sheets.map(s => s.properties.title).filter(t => t !== 'Customer Information');
    const allJobs = {};
    for (const month of months) {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:AE` });
      const validJobs = (r.data.values || []).filter(isValidJob);
      allJobs[month] = validJobs.map((job, idx) => ({ row: idx + 4, address: job[0] || '', owner: job[5] || '', phone: job[15] || '', email: job[16] || '', totalCost: job[6] || '', tooop: job[11] || '' }));
    }
    res.json(allJobs);
  } catch (err) {
    console.error('Error in /api/jobs:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get single job
app.get('/api/get-job', async (req, res) => {
  try {
    const { month, row } = req.query;
    if (!month || !row) return res.status(400).json({ error: 'Missing month or row' });
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A${row}:AE${row}` });
    const data = r.data.values?.[0] || [];
    res.json({
      address: data[0] || '', certOfComp: data[1] || '', contractDate: data[2] || '', estimateDate: data[3] || '', installDate: data[4] || '',
      owner: data[5] || '', totalCost: data[6] || '', requiredDownPayment: data[7] || '', financeAmount: data[8] || '', additionalExpense: data[9] || '',
      totalBalanceDue: data[10] || '', toooP: data[11] || '', depAmtHeld: data[12] || '', amountDue: data[13] || '', pmntMethod: data[14] || '',
      datePaid: data[16] || '', checkNum: data[17] || '', amountPaid: data[18] || '', dripEdgeColor: data[19] || '', ventilationColor: data[20] || '',
      manufacturer: data[21] || '', shingleType: data[22] || '', shingleColor: data[23] || '', estimatedSquares: data[24] || '', notes: data[25] || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload contract
app.post('/api/upload-json', async (req, res) => {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.openrouter_api_key;
    
    if (!apiKey) {
      return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured. Add it in Render environment variables.' });
    }
    
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
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenRouter error:', response.status, errorText);
      return res.status(500).json({ error: `AI service error: ${response.status}` });
    }
    
    const data = await response.json();
    
    if (data.error) {
      return res.status(500).json({ error: data.error.message || 'AI extraction failed' });
    }
    
    const text = data.choices?.[0]?.message?.content || '';
    
    if (!text) {
      return res.status(400).json({ error: 'Could not extract data from image - try again with clearer photo' });
    }
    
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
    
    const rowData = [
      job.address, '', job.contractDate, '', '', job.owner, job.totalCost, '0', '0', '0', job.totalCost, job.toooP, '0', '0', '', 
      '', job.phone, job.email, '', job.dripEdgeColor, job.ventilationColor, job.manufacturer, job.shingleType, job.shingleColor, '', job.notes,
      '', '', '', '', ''
    ];
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:AE` });
    const nextRow = (r.data.values?.length || 0) + 4;
    
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A${nextRow}:AE${nextRow}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [rowData] } });
    
    res.json({ success: true, month, owner: job.owner, previewData: job });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Save confirmed job (edit form)
app.post('/api/save-confirmed', async (req, res) => {
  try {
    const { month, row, ...data } = req.body;
    if (!month || !row) return res.status(400).json({ error: 'Missing month or row' });
    
    // Build row data with exactly 31 columns (A through AE = indices 0-30)
    const rowData = [
      data.address || '',          // A=0
      data.certOfComp || '',       // B=1
      data.contractDate || '',    // C=2
      data.estimateDate || '',    // D=3
      data.installDate || '',      // E=4
      data.owner || '',            // F=5
      data.totalCost || '',        // G=6
      data.requiredDownPayment || '', // H=7
      data.financeAmount || '',    // I=8
      data.additionalExpense || '', // J=9
      data.totalBalanceDue || '', // K=10
      data.toooP || '',            // L=11
      data.depAmtHeld || '',       // M=12
      data.amountDue || '',       // N=13
      data.pmntMethod || '',       // O=14
      '',                          // P=15 (empty)
      data.datePaid || '',        // Q=16
      data.checkNum || '',        // R=17
      data.amountPaid || '',      // S=18
      data.dripEdgeColor || '',   // T=19
      data.ventilationColor || '', // U=20
      data.manufacturer || '',     // V=21
      data.shingleType || '',      // W=22
      data.shingleColor || '',     // X=23
      data.estimatedSquares || '', // Y=24
      data.notes || '',            // Z=25
      '',                          // AA=26
      '',                          // AB=27
      '',                          // AC=28
      '',                          // AD=29
      ''                           // AE=30
    ];
    
    await sheets.spreadsheets.values.update({ 
      spreadsheetId: SPREADSHEET_ID, 
      range: `${month}!A${row}:AE${row}`, 
      valueInputOption: 'USER_ENTERED', 
      requestBody: { values: [rowData] } 
    });
    
    res.json({ success: true, month });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add estimate (batch update)
app.post('/api/save-estimate', async (req, res) => {
  try {
    const { month, row, estimateDate, permitCost, primaryContractor, paid } = req.body;
    if (!month || !row) return res.status(400).json({ error: 'Missing month or row' });
    
    // Update D, Y, AC, AE in one call
    const rowData = new Array(31).fill('');
    rowData[3] = estimateDate || '';      // D
    rowData[24] = permitCost || '';       // Y
    rowData[28] = primaryContractor || ''; // AC
    rowData[30] = paid || '';             // AE
    
    await sheets.spreadsheets.values.update({ 
      spreadsheetId: SPREADSHEET_ID, 
      range: `${month}!A${row}:AE${row}`, 
      valueInputOption: 'USER_ENTERED', 
      requestBody: { values: [rowData] }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add install date
app.post('/api/save-install', async (req, res) => {
  try {
    const { month, row, installDate } = req.body;
    if (!month || !row) return res.status(400).json({ error: 'Missing month or row' });
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${month}!E${row}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[installDate]] } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Request estimate - send GroupMe notification
app.post('/api/request-estimate', async (req, res) => {
  const { address, owner } = req.body;
  const botId = process.env.GROUPME_BOT_ID || 'a36a8a2e2fc7ad27ece3f21843';
  const text = `ESTIMATE NEEDED\n${owner || 'Unknown'}\n${address || 'Unknown'}`;
  
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

// Just extract data, don't save - for confirmation flow
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
    
    const field = (n) => { const m = text.match(new RegExp(`(?:Field:\\s*)?${n}:\\s*(.+)`, 'i')); return m ? m[1].trim() : '' };
    const amounts = text.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
    
    // Parse into object - don't save yet
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

// Save confirmed extracted data
app.post('/api/save-extracted', async (req, res) => {
  try {
    const { month, owner, address, phone, email, totalCost, toooP, contractDate, manufacturer, shingleType, shingleColor, ventilationColor, dripEdgeColor, notes } = req.body;
    
    if (!month || !owner) return res.status(400).json({ error: 'Missing month or owner' });
    
    // Column mapping: A=0, B=1, ..., AE=30
    const rowData = [
      address || '',                    // A=0 Address
      '',                               // B=1 Cert Of Comp
      contractDate || '',              // C=2 Contract Date
      '',                               // D=3 Estimate Date
      '',                               // E=4 Install Date
      owner || '',                      // F=5 Owner
      totalCost || '',                  // G=6 Total Cost
      '0',                              // H=7 Required Down Payment
      '0',                              // I=8 Finance Amount
      '0',                              // J=9 Additional Expense
      totalCost || '',                  // K=10 Total Balance Due
      toooP || '',                      // L=11 T.O.O.P
      '0',                              // M=12 DEP Amt Held
      '0',                              // N=13 Amount Due
      '',                               // O=14 Pmnt Method
      '',                               // P=15 (empty)
      phone || '',                     // Q=16 Date Paid (using for phone)
      email || '',                     // R=17 Check # (using for email)
      '',                               // S=18 Amount Paid
      dripEdgeColor || '',             // T=19 Drip Edge Color
      ventilationColor || '',          // U=20 Ventilation Color
      manufacturer || '',               // V=21 Manufacturer
      shingleType || '',                // W=22 Shingle Type
      shingleColor || '',               // X=23 Shingle Color
      '',                               // Y=24 Estimated Squares
      notes || '',                      // Z=25 Notes
      '',                               // AA=26
      '',                               // AB=27
      '',                               // AC=28
      '',                               // AD=29
      ''                                // AE=30
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
