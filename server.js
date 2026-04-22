 
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

const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'] });
const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

// Google Drive folder IDs
const DRIVE_CONTRACTS_FOLDER_ID = '1q17eaOYiSijt76DWDgbsaL6nf3W8QimE';

const SPREADSHEET_ID = '1YmEsM3AvtIbNqto8DoYLMO48tH13UY23niGvRz5vOtU';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Temporary storage for uploaded contract files (cleared after save)
let pendingContractFile = null;

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
    
    // Store file temporarily for later upload to Google Drive
    pendingContractFile = { file: req.body.file, isPdf: req.body.isPdf };
    
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
    
    // Create Google Drive folder and upload contract
    if (pendingContractFile) {
      try {
        // Create folder name: "Owner - Address"
        const folderName = `${owner} - ${address}`;
        
        // Create folder in the CONTRACTS folder
        const folderMeta = {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [DRIVE_CONTRACTS_FOLDER_ID]
        };
        const folder = await drive.files.create({ resource: folderMeta, fields: 'id' });
        const folderId = folder.data.id;
        
        // Convert base64 file to buffer
        const fileBuffer = Buffer.from(pendingContractFile.file, 'base64');
        const mimeType = pendingContractFile.isPdf ? 'application/pdf' : 'image/jpeg';
        const ext = pendingContractFile.isPdf ? 'pdf' : 'jpg';
        
        // Upload file to the folder
        const fileMeta = {
          name: `contract_${Date.now()}.${ext}`,
          parents: [folderId]
        };
        await drive.files.create({
          resource: fileMeta,
          media: {
            mimeType: mimeType,
            body: Buffer.from(pendingContractFile.file, 'base64')
          }
        });
        
        console.log('Contract saved to Google Drive:', folderName);
        
        // Clear the pending file
        pendingContractFile = null;
      } catch (driveErr) {
        console.log('Google Drive save error:', driveErr.message);
        // Don't fail the whole operation if Drive fails
      }
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
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A' + row + ':AL' + row });
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
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A' + row + ':AL' + row });
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
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A' + row + ':AL' + row });
    const job = r.data.values?.[0] || [];
    
    res.json({
      row: row, // <-- Add row to the returned object
      address: job[0] || '', certOfComp: job[1] || '', contractDate: job[2] || '',
      estimateDate: job[3] || '', installDate: job[4] || '', owner: job[5] || '',
      totalCost: job[6] || '', requiredDownPayment: job[7] || '', financeAmount: job[8] || '',
      additionalExpense: job[9] || '', totalBalanceDue: job[10] || '', toooP: job[11] || '',
      depAmtHeld: job[12] || '', amountDue: job[13] || '', pmntMethod: job[14] || '',
      phone: job[15] || '', email: job[16] || '', datePaid: job[16] || '', checkNum: job[17] || '',
      amountPaid: job[18] || '', dripEdgeColor: job[19] || '', ventilationColor: job[20] || '',
      manufacturer: job[21] || '', shingleType: job[22] || '', shingleColor: job[23] || '',
      estimatedSquares: job[24] || '', notes: job[25] || '',
      // Payment fields
      laborContractor: job[28] || '', laborCheckNum: job[29] || '', laborPaid: job[30] || '',
      salesCheckNum: job[31] || '', salesperson: job[32] || '', salesPaid: job[33] || '',
      depCheckNum: job[34] || '', depAmount: job[35] || '',
      salesDepCheckNum: job[36] || '', salesDepAmount: job[37] || '',
      paid: job[30] || ''
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
    if (!row) return res.status(400).json({ error: 'Missing row' });
    
    // First, read the existing row to preserve all other data
    const getResp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: month + '!A' + row + ':AL' + row });
    const existingRow = getResp.data.values?.[0] || [];
    
    // Initialize rowData with existing values (extend to 38 columns if needed)
    let rowData = [...existingRow];
    while (rowData.length < 38) rowData.push('');
    
    // Update only the fields that were sent in the request
    // A=0, B=1, C=2, D=3, E=4, F=5, G=6, H=7, I=8, J=9, K=10, L=11, M=12, N=13, O=14, P=15, Q=16, R=17, S=18, T=19, U=20, V=21, W=22, X=23, Y=24, Z=25
    if (data.address !== undefined) rowData[0] = data.address;
    if (data.certOfComp !== undefined) rowData[1] = data.certOfComp;
    if (data.contractDate !== undefined) rowData[2] = data.contractDate;
    if (data.estimateDate !== undefined) rowData[3] = data.estimateDate;
    if (data.installDate !== undefined) rowData[4] = data.installDate;
    if (data.owner !== undefined) rowData[5] = data.owner;
    if (data.totalCost !== undefined) rowData[6] = data.totalCost;
    if (data.requiredDownPayment !== undefined) rowData[7] = data.requiredDownPayment;
    if (data.financeAmount !== undefined) rowData[8] = data.financeAmount;
    if (data.additionalExpense !== undefined) rowData[9] = data.additionalExpense;
    if (data.totalBalanceDue !== undefined) rowData[10] = data.totalBalanceDue;
    if (data.toooP !== undefined) rowData[11] = data.toooP;
    if (data.depAmtHeld !== undefined) rowData[12] = data.depAmtHeld;
    if (data.amountDue !== undefined) rowData[13] = data.amountDue;
    if (data.pmntMethod !== undefined) rowData[14] = data.pmntMethod;
    if (data.phone !== undefined) rowData[15] = data.phone;
    if (data.email !== undefined) rowData[15] = data.email; // P = column 16, index 15
    if (data.datePaid !== undefined) rowData[16] = data.datePaid; // Q = column 17, index 16
    if (data.checkNum !== undefined) rowData[17] = data.checkNum; // R = column 18, index 17
    if (data.amountPaid !== undefined) rowData[18] = data.amountPaid; // S = column 19, index 18
    if (data.dripEdgeColor !== undefined) rowData[19] = data.dripEdgeColor; // T = 19
    if (data.ventilationColor !== undefined) rowData[20] = data.ventilationColor; // U = 20
    if (data.manufacturer !== undefined) rowData[21] = data.manufacturer; // V = 21
    if (data.shingleType !== undefined) rowData[22] = data.shingleType; // W = 22
    if (data.shingleColor !== undefined) rowData[23] = data.shingleColor; // X = 23
    if (data.estimatedSquares !== undefined) rowData[24] = data.estimatedSquares; // Y = 24
    if (data.notes !== undefined) rowData[25] = data.notes; // Z = 25
    // Labor: AC=28, AD=29, AE=30
    if (data.laborContractor !== undefined) rowData[28] = data.laborContractor;
    if (data.laborCheckNum !== undefined) rowData[29] = data.laborCheckNum;
    if (data.laborPaid !== undefined) rowData[30] = data.laborPaid;
    // Salesperson Commission: AF=31, AG=32, AH=33
    if (data.salesCheckNum !== undefined) rowData[31] = data.salesCheckNum;
    if (data.salesperson !== undefined) rowData[32] = data.salesperson;
    if (data.salesPaid !== undefined) rowData[33] = data.salesPaid;
    // Depreciation: AI=34, AJ=35
    if (data.depCheckNum !== undefined) rowData[34] = data.depCheckNum;
    if (data.depAmount !== undefined) rowData[35] = data.depAmount;
    // Salesperson Depreciation: AK=36, AL=37
    if (data.salesDepCheckNum !== undefined) rowData[36] = data.salesDepCheckNum;
    if (data.salesDepAmount !== undefined) rowData[37] = data.salesDepAmount;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: month + '!A' + row + ':AL' + row,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] }
    });
    
    // Log payments to Payments tab
    const paymentsToLog = [];
    const today = new Date().toLocaleDateString('en-US');
    const address = rowData[0] || '';
    
    // Homeowner payment (Q, R, S = indices 16, 17, 18)
    if (data.datePaid !== undefined && data.datePaid !== (existingRow[16] || '') && data.datePaid) {
      paymentsToLog.push({ date: data.datePaid, check: data.checkNum || '', amount: data.amountPaid || '', type: 'Receivable', category: 'Homeowner' });
    }
    // Depreciation payment (AI, AJ = indices 34, 35)
    if (data.depCheckNum !== undefined && data.depCheckNum !== (existingRow[34] || '') && data.depCheckNum) {
      paymentsToLog.push({ date: today, check: data.depCheckNum || '', amount: data.depAmount || '', type: 'Receivable', category: 'Depreciation' });
    }
    // Labor payment (AC, AD, AE = indices 28, 29, 30)
    if (data.laborPaid !== undefined && data.laborPaid !== (existingRow[30] || '') && data.laborPaid) {
      paymentsToLog.push({ date: today, check: data.laborCheckNum || '', amount: data.laborPaid || '', type: 'Payable', category: 'Labor' });
    }
    // Salesperson Commission (AF, AG, AH = indices 31, 32, 33)
    if (data.salesPaid !== undefined && data.salesPaid !== (existingRow[33] || '') && data.salesPaid) {
      paymentsToLog.push({ date: today, check: data.salesCheckNum || '', amount: data.salesPaid || '', type: 'Payable', category: 'Salesperson Commission' });
    }
    // Salesperson Depreciation (AK, AL = indices 36, 37)
    if (data.salesDepAmount !== undefined && data.salesDepAmount !== (existingRow[37] || '') && data.salesDepAmount) {
      paymentsToLog.push({ date: today, check: data.salesDepCheckNum || '', amount: data.salesDepAmount || '', type: 'Payable', category: 'Salesperson Depreciation' });
    }
    
    // Write to Payments tab
    if (paymentsToLog.length > 0) {
      try {
        // Get next row in Payments tab
        const payR = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Payments!A:F' });
        const payNextRow = (payR.data.values?.length || 0) + 1;
        
        for (const p of paymentsToLog) {
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `Payments!A${payNextRow}:F${payNextRow}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[address, p.date, p.check, p.amount, p.type, p.category]] }
          });
          payNextRow++;
        }
      } catch (payErr) {
        console.log('Payment log error:', payErr.message);
      }
    }
    
    res.json({ success: true, month: month, row: row });
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
app.get('/api/contractors', async (req, res) => {
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Contractor!A:A' });
    const contractors = (r.data.values || []).map(row => row[0]).filter(c => c);
    res.json(contractors);
  } catch (err) {
    res.json(['Joshua Hall', 'Dylan Hall', 'Jesse Hall', 'Austin Hall', 'Jason Hall', 'Caleb Hall', 'Nathan Hall']);
  }
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

// Vercel export
module.exports = app;

// Also start server locally if not in Vercel environment
if (process.env.VERCEL === undefined) {
  app.listen(process.env.PORT || 3000, () => console.log('Running locally on port 3000'));
}
