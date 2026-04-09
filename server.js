import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const credentials = JSON.parse(fs.readFileSync(path.join(__dirname, 'credentials.json')));

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = '1YmEsM3AvtIbNqto8DoYLMO48tH13UY23niGvRz5vOtU';

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const upload = multer({ dest: UPLOAD_DIR });

app.use(express.static('public'));
app.use(express.json());

// Get all months with data
async function getJobsByMonth(month) {
  try {
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${month}!A4:Z`
    });
    return result.data.values || [];
  } catch (e) {
    return [];
  }
}

// Get all months
async function getAllMonths() {
  const result = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID
  });
  return result.data.sheets.map(s => s.properties.title).filter(t => t !== 'Customer Information');
}

// API: Get all jobs grouped by month
app.get('/api/jobs', async (req, res) => {
  try {
    const months = await getAllMonths();
    const allJobs = {};
    
    for (const month of months) {
      const jobs = await getJobsByMonth(month);
      allJobs[month] = jobs.map((job, idx) => ({
        row: idx + 4,
        address: job[0] || '',
        owner: job[5] || '',
        phone: job[15] || '',
        email: job[16] || '',
        contractDate: job[2] || '',
        estimateDate: job[3] || '',
        installDate: job[4] || '',
        totalCost: job[6] || '',
        downPayment: job[7] || '',
        financeAmount: job[8] || '',
        additionalExpense: job[9] || '',
        balanceDue: job[10] || '',
        tooP: job[11] || '',
        depAmtHeld: job[12] || '',
        amountDue: job[13] || '',
        pmntMethod: job[14] || '',
        datePaid: job[16] || '',
        checkNum: job[17] || '',
        amountPaid: job[18] || '',
        dripEdge: job[19] || '',
        ventilation: job[20] || '',
        manufacturer: job[21] || '',
        shingleType: job[22] || '',
        shingleColor: job[23] || '',
        estSquares: job[24] || '',
        notes: job[25] || ''
      }));
    }
    
    res.json(allJobs);
  } catch (err) {
    console.error('Error fetching jobs:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: Get single job by month and row
app.get('/api/jobs/:month/:row', async (req, res) => {
  try {
    const { month, row } = req.params;
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${month}!A${row}:Z${row}`
    });
    const job = result.data.values?.[0] || [];
    
    res.json({
      row: parseInt(row),
      address: job[0] || '',
      certOfComp: job[1] || '',
      contractDate: job[2] || '',
      estimateDate: job[3] || '',
      installDate: job[4] || '',
      owner: job[5] || '',
      totalCost: job[6] || '',
      downPayment: job[7] || '',
      financeAmount: job[8] || '',
      additionalExpense: job[9] || '',
      balanceDue: job[10] || '',
      tooP: job[11] || '',
      depAmtHeld: job[12] || '',
      amountDue: job[13] || '',
      pmntMethod: job[14] || '',
      phone: job[15] || '',
      email: job[16] || '',
      datePaid: job[17] || '',
      checkNum: job[18] || '',
      amountPaid: job[19] || '',
      dripEdge: job[20] || '',
      ventilation: job[21] || '',
      manufacturer: job[22] || '',
      shingleType: job[23] || '',
      shingleColor: job[24] || '',
      estSquares: job[25] || '',
      notes: job[26] || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Update job field
app.post('/api/jobs/update', async (req, res) => {
  try {
    const { month, row, field, value } = req.body;
    const fieldMap = {
      address: 'A', certOfComp: 'B', contractDate: 'C', estimateDate: 'D', installDate: 'E',
      owner: 'F', totalCost: 'G', downPayment: 'H', financeAmount: 'I', additionalExpense: 'J',
      balanceDue: 'K', tooP: 'L', depAmtHeld: 'M', amountDue: 'N', pmntMethod: 'O',
      phone: 'P', email: 'Q', datePaid: 'R', checkNum: 'S', amountPaid: 'T',
      dripEdge: 'U', ventilation: 'V', manufacturer: 'W', shingleType: 'X', shingleColor: 'Y',
      estSquares: 'Y', notes: 'Z'
    };
    
    const col = fieldMap[field];
    if (!col) return res.status(400).json({ error: 'Invalid field' });
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${month}!${col}${row}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[value]] }
    });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI-powered OCR
async function extractWithAI(pdfPath) {
  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const base64 = pdfBuffer.toString('base64');
    const apiKey = process.env.OPENROUTER_API_KEY;
    
    if (!apiKey) return extractWithTesseract(pdfPath);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'anthropic/claude-3-haiku',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Extract ALL text from this roofing contract. Include: property owner name, address, phone, email, contract price, total cost, insurance deductible, shingle manufacturer, shingle type, shingle color, installation date. Return as plain text with labels.' },
            { type: 'image_url', image_url: { url: `data:application/pdf;base64,${base64}` } }
          ]
        }],
        max_tokens: 2000
      })
    });

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  } catch (e) {
    console.log('AI extraction error:', e.message);
    return '';
  }
}

function extractWithTesseract(pdfPath) {
  try {
    const result = execSync(`python3 -c "import sys; sys.path.insert(0, '/root/.openclaw/workspace/yh-app'); from ocr import extract_text_from_pdf; print(extract_text_from_pdf('${pdfPath}'))"`, { encoding: 'utf-8', maxBuffer: 10*1024*1024 });
    return result;
  } catch (e) { return ''; }
}

function parseOCR(text) {
  const amounts = text.match(/\$[\d,]+\.?\d{0,2}/g) || [];
  let owner = '', addrMatch = '', phoneMatch = '', emailMatch = '', shingleMatch = '', dateMatch = '';
  
  const namePatterns = [/Property Owner[s]?:?\s*([A-Z][a-z]+ [A-Z][a-z]+)/i, /Owner:?\s*([A-Z][a-z]+ [A-Z][a-z]+)/i];
  for (const p of namePatterns) { const m = text.match(p); if (m) { owner = m[1]; break; } }
  addrMatch = text.match(/(\d+\s+[A-Za-z\s]+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Cape Rd))/i);
  phoneMatch = text.match(/(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})/);
  emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  shingleMatch = text.match(/(Tamko|Owens|Corning|Atlas|Heritage)[^.\n]*/i);
  dateMatch = text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);

  return {
    owner, address: addrMatch ? addrMatch[1] : '', phone: phoneMatch ? phoneMatch[1] : '',
    email: emailMatch ? emailMatch[1] : '', totalCost: amounts[0]?.replace('$','') || '0',
    balanceDue: amounts[0]?.replace('$','') || '0', tooP: amounts[1]?.replace('$','') || '0',
    date: dateMatch ? dateMatch[1] : '', pmntMethod: 'Check', dripEdge: 'Black', ventilation: 'Black',
    manufacturer: shingleMatch ? shingleMatch[1] : '', shingleType: '', shingleColor: ''
  };
}

function getMonth(dateStr) {
  if (!dateStr) return 'March';
  const m = parseInt(dateStr.split(/[\/\-]/)[0]);
  if (isNaN(m) || m < 1 || m > 12) return 'March';
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return months[m - 1];
}

app.post('/api/upload', upload.single('contract'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const tempPath = req.file.path;
    const newName = `${Date.now()}_${req.file.originalname}`;
    const newPath = path.join(UPLOAD_DIR, newName);
    fs.renameSync(tempPath, newPath);
    
    const text = await extractWithAI(newPath);
    const data = parseOCR(text);
    const month = getMonth(data.date);
    
    const rowData = [
      data.address, '', data.date, '', '', data.owner, data.totalCost, '$0', '$0', '$0', data.balanceDue, data.tooP,
      '', '', data.pmntMethod, data.phone, data.email, '', data.dripEdge, data.ventilation,
      data.manufacturer, data.shingleType, data.shingleColor, '', ''
    ];
    
    const result = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:A` });
    const nextRow = (result.data.values?.length || 0) + 1;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${month}!A${nextRow}:Z${nextRow}`,
      valueInputOption: 'USER_ENTERED', requestBody: { values: [rowData] }
    });
    
    res.json({ success: true, month, owner: data.owner, row: nextRow });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/uploads', (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR).filter(f => f.endsWith('.pdf'));
  res.json({ files });
});

app.get('/api/download/:filename', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.filename);
  if (fs.existsSync(filePath)) res.download(filePath);
  else res.status(404).json({ error: 'File not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`YH Contract App running on port ${PORT}`));