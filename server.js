const express = require('express');
const fs = require('fs');
const { google } = require('googleapis');
const path = require('path');
const multer = require('multer');

// Multer setup for file uploads
const upload = multer({ storage: multer.memoryStorage() });

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
      allJobs[month] = jobs.map((job, idx) => ({ row: idx + 2, address: job[0] || '', owner: job[5] || '', phone: job[15] || '', email: job[16] || '', totalCost: job[6] || '', tooop: job[11] || '' }));
    }
    res.json(allJobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload JSON - returns previewData for confirmation (same as extract-data but different response format)
app.post('/api/upload-json', async (req, res) => {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.openrouter_api_key;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });
    
    const { file, isPdf, preview } = req.body;
    if (!file) return res.status(400).json({ error: 'No file provided' });
    
    // Split pages and build content array
    const pages = isPdf ? file.split('||PAGE||') : [file];
    const content = [
      { type: 'text', text: 'Extract from these contract pages: TOTAL COST, TOTAL OUT OF POCKET, Owner Name, Property Address (street,city,state,zip), Phone, Email, DATE (look for the date AFTER YHP Representative Signature, NOT the property owner date), Manufacturer, Shingle Type, Shingle Color, Ventilation Color, Drip Edge Color, ROOFING WORK TO BE PERFORMED, EXTERIOR/INTERIOR WORK TO BE PERFORMED, Printed Name. IMPORTANT: 1) For money amounts use format "TOTAL COST: 12069.14" with no $ sign. 2) The contract date is the SECOND date on the page (after YHP Rep signature), not the first date. Return as "Field: Value".' }
    ];
    
    // Add each page as an image
    for (const page of pages) {
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${page}` } });
    }
    
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'https://yh-hammer-1.onrender.com', 'X-Title': 'Yellow Hammer' },
      body: JSON.stringify({
        model: 'anthropic/claude-3-haiku',
        messages: [{ role: 'user', content: content }],
        max_tokens: 2500
      })
    });
    
    if (!response.ok) { const errText = await response.text(); console.log("AI Error:", response.status, errText); return res.status(500).json({ error: "AI extraction failed: " + response.status }); }
    
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    
    const field = (n) => { const m = text.match(new RegExp(`(?:Field:\\s*)?${n}:\\s*(.+)`,'i')); return m ? m[1].trim() : ''; };
    const amounts = text.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
    
    const extracted = {
      owner: field('Owner') || field('Name') || '',
      salesperson: field('Printed Name') || field('Printed') || field('Salesperson') || '',
      address: field('Address') || field('Street') || '',
      phone: field('Phone') || '',
      email: field('Email') || '',
      totalCost: field('TOTAL COST') || field('Total Cost') || field('Total') || field('Total Contract') || amounts[0]?.replace(/[$,]/g, '') || '0',
      toooP: field('T.O.O.P') || field('Out of Pocket') || amounts[1]?.replace(/[$,]/g, '') || '0',
      contractDate: field('DATE') || field('Contract Date') || field('Date') || '' || '',
      manufacturer: field('Manufacturer') || '',
      shingleType: field('Type') || field('Shingle Type') || '',
      shingleColor: field('Color') || field('Shingle Color') || '',
      ventilationColor: field('Ventilation') || field('Ventilation Color') || '',
      dripEdgeColor: field('Drip Edge') || field('Drip Edge Color') || '',
      notes: (field('ROOFING WORK TO BE PERFORMED') ? field('ROOFING WORK TO BE PERFORMED') + ' ' : '') + (field('EXTERIOR/INTERIOR WORK TO BE PERFORMED') || field('Notes') || '')
    };
    
    res.json({ success: true, previewData: extracted });
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
    
    // Split pages and build content array
    const pages = isPdf ? file.split('||PAGE||') : [file];
    const content = [
      { type: 'text', text: 'Extract: Owner, Address (street city state zip), Phone, Email, Total Cost, T.O.O.P, Contract Date, Manufacturer, Shingle Type, Shingle Color, Ventilation Color, Drip Edge Color, Notes. Format: Field: Value' }
    ];
    
    // Add each page as an image
    for (const page of pages) {
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${page}` } });
    }
    
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'https://yh-hammer-1.onrender.com', 'X-Title': 'Yellow Hammer' },
      body: JSON.stringify({
        model: 'anthropic/claude-3-haiku',
        messages: [{ role: 'user', content: content }],
        max_tokens: 2500
      })
    });
    
    if (!response.ok) { const errText = await response.text(); console.log("AI Error:", response.status, errText); return res.status(500).json({ error: "AI extraction failed: " + response.status }); }
    
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    
    const field = (n) => { const m = text.match(new RegExp(`(?:Field:\\s*)?${n}:\\s*(.+)`,'i')); return m ? m[1].trim() : ''; };
    const amounts = text.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
    
    const extracted = {
      owner: field('Owner') || field('Name') || '',
      salesperson: field('Printed Name') || field('Printed') || field('Salesperson') || '',
      address: field('Address') || field('Street') || '',
      phone: field('Phone') || '',
      email: field('Email') || '',
      totalCost: field('TOTAL COST') || field('Total Cost') || field('Total') || field('Total Contract') || amounts[0]?.replace(/[$,]/g, '') || '0',
      toooP: field('T.O.O.P') || field('Out of Pocket') || amounts[1]?.replace(/[$,]/g, '') || '0',
      contractDate: field('DATE') || field('Contract Date') || field('Date') || '' || '',
      manufacturer: field('Manufacturer') || '',
      shingleType: field('Type') || field('Shingle Type') || '',
      shingleColor: field('Color') || field('Shingle Color') || '',
      ventilationColor: field('Ventilation') || field('Ventilation Color') || '',
      dripEdgeColor: field('Drip Edge') || field('Drip Edge Color') || '',
      notes: (field('ROOFING WORK TO BE PERFORMED') ? field('ROOFING WORK TO BE PERFORMED') + ' ' : '') + (field('EXTERIOR/INTERIOR WORK TO BE PERFORMED') || field('Notes') || '') || field('Notes') || ''
    };
    
    res.json({ success: true, data: extracted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save extracted data
app.post('/api/save-extracted', async (req, res) => {
  try {
    const { 
      month, address, certOfComp, contractDate, estimateDate, installDate, owner,
      totalCost, requiredDownPayment, financeAmount, additionalExpense,
      totalBalanceDue, toooP, depAmtHeld, amountDue, pmntMethod,
      datePaid, checkNumber, amountPaid, dripEdgeColor, ventilationColor,
      manufacturer, shingleType, shingleColor, estimatedSquares, notes,
      phone, email, salesperson
    } = req.body;
    
    if (!month || !owner) return res.status(400).json({ error: 'Missing month or owner' });
    
    const rowData = [
      address || '',                // A - Address
      certOfComp || '',             // B - Cert Of Comp
      contractDate || '',          // C - Contract Date
      estimateDate || '',          // D - Estimate Date
      installDate || '',           // E - Install Date
      owner || '',                 // F - Owner
      totalCost || '',             // G - Total Cost
      requiredDownPayment || '',   // H - Required Down Payment
      financeAmount || '',         // I - Finance Amount
      additionalExpense || '',     // J - Additional Expense
      totalBalanceDue || totalCost || '', // K - Total Balance Due
      toooP || '',                 // L - T.O.O.P
      depAmtHeld || '',            // M - DEP Amt Held
      amountDue || '',             // N - Amount Due
      pmntMethod || '',            // O - Pmnt Method
      '',                          // P - (empty)
      datePaid || '',              // Q - Date Paid
      checkNumber || '',           // R - Check #
      amountPaid || '',            // S - Amount Paid
      dripEdgeColor || '',         // T - Drip Edge Color
      ventilationColor || '',      // U - Ventilation Color
      manufacturer || '',          // V - Manufacturer
      shingleType || '',           // W - Shingle Type
      shingleColor || '',          // X - Shingle Color
      estimatedSquares || '',      // Y - Estimated Squares
      notes || '',                 // Z - Notes
      '',                          // AA - (empty)
      '',                          // AB - (empty)
      '',                          // AC - (empty)
      '',                          // AD - (empty)
      '',                          // AE - (empty)
      '',                          // AF - (empty)
      salesperson || ''            // AG - Salesperson
    ];
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:AE` });
    // Data starts at row 2 (row 1 is header)
    const nextRow = (r.data.values?.length || 0) + 1;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${month}!A${nextRow}:AG${nextRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] }
    });
    
    // Also save customer info to Customer Information tab
    // A=Name, B=Address, C=Phone, D=Email
    try {
      const custR = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Customer Information!A:D' });
      const custNextRow = (custR.data.values?.length || 0) + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `Customer Information!A${custNextRow}:D${custNextRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[owner || '', address || '', phone || '', email || '']] }
      });
    } catch (e) {
      console.log('Customer info save error:', e.message);
    }
    
    res.json({ success: true, month, owner });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Request estimate - GroupMe
app.post('/api/request-estimate', async (req, res) => {
  try {
    const { month, row } = req.body;
    if (!month || !row) return res.status(400).json({ error: 'Missing month or row' });
    
    // Get columns A (0), F (5), V (21), W (22), X (23), Z (25)
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A' + row + ':Z' + row });
    const job = r.data.values?.[0] || [];
    const owner = job[5] || 'Unknown';
    const address = job[0] || '';
    const manufacturer = job[21] || '';
    const shingleType = job[22] || '';
    const shingleColor = job[23] || '';
    const notes = job[25] || '';
    
    const botId = process.env.GROUPME_BOT_ID || 'a36a8a2e2fc7ad27ece3f21843';
    const message = 'ESTIMATE NEEDED\n' +
      'Owner: ' + owner + '\n' +
      'Address: ' + address + '\n' +
      'Manufacturer: ' + manufacturer + '\n' +
      'Shingle Type: ' + shingleType + '\n' +
      'Shingle Color: ' + shingleColor + '\n' +
      'Notes: ' + notes;
    
    await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: botId, text: message })
    });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Request install date - GroupMe
app.post('/api/request-install', async (req, res) => {
  try {
    const { month, row, installDate } = req.body;
    if (!month || !row) return res.status(400).json({ error: 'Missing month or row' });
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A' + row + ':Z' + row });
    const job = r.data.values?.[0] || [];
    const owner = job[5] || 'Unknown';
    const address = job[0] || '';
    const manufacturer = job[21] || '';
    const shingleType = job[22] || '';
    const shingleColor = job[23] || '';
    
    const botId = process.env.GROUPME_BOT_ID || 'a36a8a2e2fc7ad27ece3f21843';
    const message = 'INSTALL DATE NEEDED\n' +
      'Owner: ' + owner + '\n' +
      'Address: ' + address + '\n' +
      'Manufacturer: ' + manufacturer + '\n' +
      'Shingle Type: ' + shingleType + '\n' +
      'Shingle Color: ' + shingleColor + 
      (installDate ? '\nProposed Date: ' + installDate : '\nProposed Date: TBD');
    
    await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: botId, text: message })
    });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single job
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
      manufacturer: job[27] || '', shingleType: job[22] || '', shingleColor: job[23] || '',
      estimatedSquares: job[24] || '', notes: job[25] || '', paid: job[30] || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save confirmed/edited job
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
      data.estimatedSquares || '', data.notes || '', data.salesperson || ''
    ];
    
    let targetRow = row || ((await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A:AE' })).data.values?.length || 0) + 1;
    
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

// Save estimate
app.post('/api/save-estimate', async (req, res) => {
  try {
    const { month, row, estimateDate, manufacturer, paid } = req.body;
    if (!month || !row) return res.status(400).json({ error: 'Missing month or row' });
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A' + row + ':AF' + row });
    const job = r.data.values?.[0] || [];
    
    job[3] = estimateDate || '';      // D = Estimate Date
    job[27] = manufacturer || '';     // AC = Primary Contractor  
    job[30] = paid || '';             // AE = Paid
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: month + '!A' + row + ':AF' + row,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [job] }
    });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save install date
app.post('/api/save-install-date', async (req, res) => {
  try {
    const { month, row, installDate } = req.body;
    if (!month || !row) return res.status(400).json({ error: 'Missing month or row' });
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A' + row + ':AE' + row });
    const job = r.data.values?.[0] || [];
    
    job[4] = installDate || '';  // E = Install Date
    
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

// Get contractors list
app.get('/api/contractors', (req, res) => {
  res.json(['Joshua Hall', 'Dylan Hall', 'Jesse Hall', 'Austin Hall', 'Jason Hall', 'Caleb Hall', 'Nathan Hall']);
});

// Request install - GroupMe
app.post('/api/request-install', async (req, res) => {
  try {
    const { month, row } = req.body;
    if (!month || !row) return res.status(400).json({ error: 'Missing month or row' });
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A' + row + ':F' + row });
    const job = r.data.values?.[0] || [];
    const owner = job[5] || 'Unknown';
    const address = job[0] || '';
    
    const botId = process.env.GROUPME_BOT_ID || 'a36a8a2e2fc7ad27ece3f21843';
    await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: botId, text: 'INSTALL DATE NEEDED\n' + owner + '\n' + address })
    });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload file endpoint - handles PDF files (scanned or text)
app.post('/api/upload-file', upload.single('file'), async (req, res) => {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.openrouter_api_key;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    
    const fileBuffer = req.file.buffer;
    
    // Send PDF directly to AI (works for both text and scanned PDFs)
    const pdfBase64 = fileBuffer.toString('base64');
    
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'https://yh-hammer-1.onrender.com', 'X-Title': 'Yellow Hammer' },
      body: JSON.stringify({
        model: 'anthropic/claude-3-haiku',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Extract from this contract: Owner Name, Full Property Address (street,city,state,zip), Phone Number, Email, Total Contract Amount, T.O.O.P (total out of pocket), Contract Date, Manufacturer, Shingle Type, Shingle Color, Ventilation Color, Drip Edge Color. Format each as: Field: Value' },
          { type: 'image_url', image_url: { url: `data:application/pdf;base64,${pdfBase64}` } }
        ]}],
        max_tokens: 2000
      })
    });
    
    if (!response.ok) {
      // If PDF fails, try converting first page to image
      // For now, return error asking for screenshot
      return res.status(400).json({ error: 'PDF not supported by AI. Please take a screenshot/photo of the contract and upload as a JPG or PNG image instead.' });
    }
    
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    
    const field = (n) => { const m = text.match(new RegExp(`(?:Field:\\s*)?${n}:\\s*(.+)`,'i')); return m ? m[1].trim() : ''; };
    const amounts = text.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
    
    const result = {
      owner: field('Owner') || field('Name') || '',
      salesperson: field('Printed Name') || field('Printed') || field('Salesperson') || '',
      address: field('Address') || field('Street') || '',
      phone: field('Phone') || '',
      email: field('Email') || '',
      totalCost: field('TOTAL COST') || field('Total Cost') || field('Total') || field('Total Contract') || amounts[0]?.replace(/[$,]/g, '') || '0',
      toooP: field('T.O.O.P') || field('Out of Pocket') || amounts[1]?.replace(/[$,]/g, '') || '0',
      contractDate: field('DATE') || field('Contract Date') || field('Date') || '' || '',
      manufacturer: field('Manufacturer') || '',
      shingleType: field('Type') || field('Shingle Type') || '',
      shingleColor: field('Color') || field('Shingle Color') || '',
      ventilationColor: field('Ventilation') || field('Ventilation Color') || '',
      dripEdgeColor: field('Drip Edge') || field('Drip Edge Color') || '',
      notes: (field('ROOFING WORK TO BE PERFORMED') ? field('ROOFING WORK TO BE PERFORMED') + ' ' : '') + (field('EXTERIOR/INTERIOR WORK TO BE PERFORMED') || field('Notes') || '') || field('Notes') || ''
    };
    
    res.json({ success: true, previewData: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Running - UPDATED'));
