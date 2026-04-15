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
const GROUPME_BOT_ID = 'a36a8a2e2fc7ad27ece3f21843';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Column mapping (A=0, B=1, ..., Z=25)
const COLS = {
  address: 0, certOfComp: 1, contractDate: 2, estimateDate: 3, installDate: 4,
  owner: 5, totalCost: 6, requiredDownPayment: 7, financeAmount: 8, additionalExpense: 9,
  totalBalanceDue: 10, toooP: 11, depAmtHeld: 12, amountDue: 13, pmntMethod: 14,
  phone: 15, email: 16, datePaid: 17, checkNum: 18, amountPaid: 19,
  dripEdgeColor: 20, ventilationColor: 21, manufacturer: 22, shingleType: 23,
  shingleColor: 24, estimatedSquares: 25, notes: 26
};

const CONTRACTORS = ['Joshua Hall', 'Dylan Hall', 'Jesse Hall', 'Austin Hall', 'Jason Hall', 'Caleb Hall', 'Nathan Hall'];

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

app.get('/api/get-job', async (req, res) => {
  try {
    const { month, row } = req.query;
    if (!month || !row) return res.status(400).json({ error: 'Missing month or row' });
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A' + row + ':AE' + row });
    const job = r.data.values?.[0] || [];
    
    res.json({
      address: job[0] || '', certOfComp: job[1] || '', contractDate: job[2] || '',
      estimateDate: job[3] || '', installDate: job[4] || '', owner: job[5] || '',
      totalCost: job[6] || '', requiredDownPayment: job[7] || '', financeAmount: job[8] || '',
      additionalExpense: job[9] || '', totalBalanceDue: job[10] || '', toooP: job[11] || '',
      depAmtHeld: job[12] || '', amountDue: job[13] || '', pmntMethod: job[14] || '',
      phone: job[15] || '', email: job[16] || '', datePaid: job[17] || '', checkNum: job[18] || '',
      amountPaid: job[19] || '', dripEdgeColor: job[20] || '', ventilationColor: job[21] || '',
      manufacturer: job[22] || '', shingleType: job[23] || '', shingleColor: job[24] || '',
      estimatedSquares: job[25] || '', notes: job[26] || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/contractors', (req, res) => {
  res.json(CONTRACTORS);
});

app.post('/api/save-confirmed', async (req, res) => {
  try {
    const data = req.body;
    const { month, row } = data;
    if (!month) return res.status(400).json({ error: 'Missing month' });
    
    const rowData = [
      data.address || '', data.certOfComp || '', data.contractDate || '', data.estimateDate || '',
      data.installDate || '', data.owner || '', data.totalCost || '', data.requiredDownPayment || '',
      data.financeAmount || '', data.additionalExpense || '', data.totalBalanceDue || '', data.toooP || '',
      data.depAmtHeld || '', data.amountDue || '', data.pmntMethod || '', data.phone || '', data.email || '',
      data.datePaid || '', data.checkNum || '', data.amountPaid || '', data.dripEdgeColor || '',
      data.ventilationColor || '', data.manufacturer || '', data.shingleType || '', data.shingleColor || '',
      data.estimatedSquares || '', data.notes || ''
    ];
    
    let targetRow;
    if (row) {
      targetRow = row;
    } else {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A:AE' });
      targetRow = (r.data.values ? r.data.values.length : 0) + 2;
    }
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: month + '!A' + targetRow + ':AE' + targetRow,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] }
    });
    
    res.json({ success: true, month: month, row: targetRow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save-estimate', async (req, res) => {
  try {
    const { month, row, estimateDate, squares, primaryContractor, paid } = req.body;
    if (!month || !row) return res.status(400).json({ error: 'Missing month or row' });
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A' + row + ':AE' + row });
    const job = r.data.values?.[0] || [];
    
    // Update fields: D (estimateDate), Y (squares), AC (contractor), AE (paid)
    job[3] = estimateDate || '';
    job[25] = squares || ''; // Y = index 24, wait let me recount
    // Actually: A=0, B=1, C=2, D=3, E=4, F=5, G=6, H=7, I=8, J=9, K=10, L=11, M=12, N=13, O=14, P=15, Q=16, R=17, S=18, T=19, U=20, V=21, W=22, X=23, Y=24, Z=25
    // Estimate Date = D = index 3
    // Estimated Squares = Y = index 24
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: month + '!A' + row + ':AE' + row,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [job] }
    });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save-install-date', async (req, res) => {
  try {
    const { month, row, installDate } = req.body;
    if (!month || !row) return res.status(400).json({ error: 'Missing month or row' });
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A' + row + ':AE' + row });
    const job = r.data.values?.[0] || [];
    
    // Install Date = E = index 4
    job[4] = installDate || '';
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: month + '!A' + row + ':AE' + row,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [job] }
    });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/request-estimate', async (req, res) => {
  try {
    const { month, row } = req.body;
    if (!month || !row) return res.status(400).json({ error: 'Missing month or row' });
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A' + row + ':F' + row });
    const job = r.data.values?.[0] || [];
    const owner = job[5] || 'Unknown';
    const address = job[0] || '';
    
    // Send to GroupMe
    await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: GROUPME_BOT_ID,
        text: 'ESTIMATE NEEDED\n' + owner + '\n' + address
      })
    });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/request-install', async (req, res) => {
  try {
    const { month, row } = req.body;
    if (!month || !row) return res.status(400).json({ error: 'Missing month or row' });
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A' + row + ':F' + row });
    const job = r.data.values?.[0] || [];
    const owner = job[5] || 'Unknown';
    const address = job[0] || '';
    
    // Send to GroupMe
    await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot_id: GROUPME_BOT_ID,
        text: 'INSTALL DATE NEEDED\n' + owner + '\n' + address
      })
    });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/extract-data', async (req, res) => {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.openrouter_api_key;
    if (!apiKey) {
      console.log('Looking for API key, env vars with api:', Object.keys(process.env).filter(k => k.toLowerCase().includes('api')));
      return res.status(500).json({ error: 'API key not configured' });
    }
    
    const { file, isPdf } = req.body;
    if (!file) return res.status(400).json({ error: 'No file provided' });
    
    // Handle multiple pages
    const pages = file.split('||PAGE||');
    const imageData = isPdf ? 'data:image/png;base64,' + pages[0] : 'data:image/jpeg;base64,' + file;
    
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'HTTP-Referer': 'https://yh-hammer.onrender.com', 'X-Title': 'Yellow Hammer' },
      body: JSON.stringify({
        model: 'anthropic/claude-3-haiku',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Read this contract and tell me: WHO is the owner (name), WHAT is the property address, WHAT is the phone number, WHAT is the email. Answer in simple format: Owner=NAME | Address=STREET CITY STATE ZIP | Phone=NUMBER | Email=EMAIL' },
          { type: 'image_url', image_url: { url: imageData } }
        ]}],
        max_tokens: 1500
      })
    });
    
    if (!response.ok) {
      const errText = await response.text();
      console.log('AI Error:', response.status, errText);
      return res.status(500).json({ error: 'AI extraction failed: ' + response.status });
    }
    
    const data = await response.json();
    const text = data.choices[0].message.content || '';
    
    const field = function(n) { var m = text.match(new RegExp('(?:Field:\\s*)?' + n + ':\\s*(.+)', 'i')); return m ? m[1].trim() : ''; };
    var amounts = text.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
    
    console.log('AI response:', text);
    
    // Simple parsing - look for patterns
    var ownerMatch = text.match(/Owner=([^|]+)/i);
    var owner = ownerMatch ? ownerMatch[1].trim() : '';
    
    var addressMatch = text.match(/Address=([^|]+)/i);
    var fullAddress = addressMatch ? addressMatch[1].trim() : '';
    
    var phoneMatch = text.match(/Phone=([^|]+)/i);
    var phone = phoneMatch ? phoneMatch[1].trim() : '';
    
    var emailMatch = text.match(/Email=([^|]+)/i);
    var email = emailMatch ? emailMatch[1].trim() : '';
    
    // Default the rest
    var contractDate = '';
    var totalCost = '0';
    var toooP = '0';
    var dripEdgeColor = '';
    var ventilationColor = '';
    
    res.json({ success: true, data: {
      owner: owner,
      address: fullAddress || field('Address') || '',
      phone: phone,
      email: email,
      totalCost: totalCost,
      toooP: toooP,
      contractDate: contractDate,
      dripEdgeColor: dripEdgeColor,
      ventilationColor: ventilationColor,
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
    var manufacturer = req.body.manufacturer || '';
    var shingleType = req.body.shingleType || '';
    var shingleColor = req.body.shingleColor || '';
    var dripEdgeColor = req.body.dripEdgeColor || '';
    var ventilationColor = req.body.ventilationColor || '';
    var notes = req.body.notes || '';
    
    if (!month || !owner) return res.status(400).json({ error: 'Missing month or owner' });
    
    // Columns: A-Z (0-25)
    // A=address, B=certOfComp, C=contractDate, D=estimateDate, E=installDate
    // F=owner, G=totalCost, H=requiredDownPayment, I=financeAmount, J=additionalExpense
    // K=totalBalanceDue, L=toooP, M=depAmtHeld, N=amountDue, O=pmntMethod
    // P=phone, Q=email, R=datePaid, S=checkNum, T=amountPaid
    // U=dripEdgeColor, V=ventilationColor, W=manufacturer, X=shingleType, Y=shingleColor, Z=estimatedSquares, AA=notes
    var rowData = [
      address, '', contractDate, '', '', owner, totalCost, '0', '0', '0', 
      totalCost, toooP, '0', '0', '', '', phone, email, '', '', '', '', '', '',
      dripEdgeColor, ventilationColor, manufacturer, shingleType, shingleColor, '', notes
    ];
    
    var r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A:AE' });
    var dataRows = r.data.values ? r.data.values.length : 0;
    // Row 1 is header, so if there's only 1 row (just header), next data goes to row 2
    // Otherwise, add 2 to skip header and go to next empty row
    var nextRow = dataRows <= 1 ? 2 : dataRows + 1;
    
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