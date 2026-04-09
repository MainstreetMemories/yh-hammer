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

async function getJobsByMonth(month) {
  try {
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${month}!A4:Z`
    });
    return result.data.values || [];
  } catch (e) { return []; }
}

async function getAllMonths() {
  const result = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  return result.data.sheets.map(s => s.properties.title).filter(t => t !== 'Customer Information');
}

app.get('/api/jobs', async (req, res) => {
  try {
    const months = await getAllMonths();
    const allJobs = {};
    for (const month of months) {
      const jobs = await getJobsByMonth(month);
      allJobs[month] = jobs.map((job, idx) => ({
        row: idx + 4, address: job[0] || '', owner: job[5] || '', phone: job[15] || '', email: job[16] || '',
        contractDate: job[2] || '', estimateDate: job[3] || '', installDate: job[4] || '',
        totalCost: job[6] || '', downPayment: job[7] || '', balanceDue: job[10] || '', tooP: job[11] || '',
        pmntMethod: job[14] || '', manufacturer: job[21] || '', shingleType: job[22] || '', shingleColor: job[23] || '',
        dripEdge: job[19] || '', ventilation: job[20] || '', notes: job[25] || ''
      }));
    }
    res.json(allJobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs/update', async (req, res) => {
  try {
    const { month, row, field, value } = req.body;
    const fieldMap = {
      address: 'A', contractDate: 'C', estimateDate: 'D', installDate: 'E', owner: 'F',
      totalCost: 'G', downPayment: 'H', balanceDue: 'K', tooP: 'L', pmntMethod: 'O',
      phone: 'P', email: 'Q', datePaid: 'R', checkNum: 'S', amountPaid: 'T',
      dripEdge: 'U', ventilation: 'V', manufacturer: 'W', shingleType: 'X', shingleColor: 'Y', notes: 'Z'
    };
    const col = fieldMap[field];
    if (!col) return res.status(400).json({ error: 'Invalid field' });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${month}!${col}${row}`,
      valueInputOption: 'USER_ENTERED', requestBody: { values: [[value]] }
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// AI-powered OCR with better error handling
async function extractWithAI(pdfPath) {
  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const base64 = pdfBuffer.toString('base64');
    const apiKey = process.env.OPENROUTER_API_KEY;
    
    console.log('API Key exists:', !!apiKey);
    
    if (!apiKey) {
      console.log('No API key found, using fallback');
      return 'Contract Date: 03/18/26\nOwner: Test Owner\nAddress: 123 Test St\nTotal Cost: $10,000';
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://yh-hammer.onrender.com',
        'X-Title': 'Yellow Hammer Contract App'
      },
      body: JSON.stringify({
        model: 'anthropic/claude-3-haiku',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Extract these fields from the contract: Owner name, Address, Phone, Email, Total Cost, Contract Date, Shingle Manufacturer/Type/Color. Return each on its own line as "Field: Value"' },
            { type: 'image_url', image_url: { url: `data:application/pdf;base64,${base64}` } }
          ]
        }],
        max_tokens: 1500
      })
    });

    console.log('API Response status:', response.status);
    
    if (!response.ok) {
      const errText = await response.text();
      console.log('API Error:', errText);
      return '';
    }

    const data = await response.json();
    console.log('API Response data:', JSON.stringify(data).substring(0, 200));
    
    // Better error handling for response structure
    if (!data || !data.choices || !data.choices[0]) {
      console.log('Unexpected response structure');
      return '';
    }
    
    return data.choices[0]?.message?.content || '';
  } catch (e) {
    console.log('AI extraction error:', e.message, e.stack);
    return '';
  }
}

function parseOCR(text) {
  const amounts = text.match(/\$[\d,]+\.?\d{0,2}/g) || [];
  let owner = '', addrMatch = '', phoneMatch = '', emailMatch = '', shingleMatch = '', dateMatch = '';
  
  const namePatterns = [/Owner:?\s*([A-Z][a-z]+ [A-Z][a-z]+)/i, /Name:?\s*([A-Z][a-z]+ [A-Z][a-z]+)/i];
  for (const p of namePatterns) { const m = text.match(p); if (m) { owner = m[1]; break; } }
  addrMatch = text.match(/Address:?\s*([^\\n]+)/i) || text.match(/(\d+\s+[A-Za-z\s]+(?:Street|St|Ave|Rd|Dr|Ln))/i);
  phoneMatch = text.match(/(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})/);
  emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  shingleMatch = text.match(/(Tamko|Owens|Corning|Atlas)[^\\n]*/i);
  dateMatch = text.match(/Contract[\\s-]?Date:?\s*(\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4})/i);

  return {
    owner: owner || 'Unknown',
    address: addrMatch ? addrMatch[1].trim() : '',
    phone: phoneMatch ? phoneMatch[1] : '',
    email: emailMatch ? emailMatch[1] : '',
    totalCost: amounts[0]?.replace('$','').replace(',','') || '0',
    balanceDue: amounts[0]?.replace('$','').replace(',','') || '0',
    tooP: amounts[1]?.replace('$','').replace(',','') || '0',
    date: dateMatch ? dateMatch[1] : '',
    pmntMethod: 'Check',
    dripEdge: 'Black',
    ventilation: 'Black',
    manufacturer: shingleMatch ? shingleMatch[1].trim() : '',
    shingleType: '',
    shingleColor: ''
  };
}

function getMonth(dateStr) {
  if (!dateStr) return 'April';
  const parts = dateStr.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (!parts) return 'April';
  const m = parseInt(parts[1]);
  if (isNaN(m) || m < 1 || m > 12) return 'April';
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
    
    console.log('Processing upload:', newName);
    const text = await extractWithAI(newPath);
    console.log('Extracted text:', text ? text.substring(0, 200) : 'empty');
    
    const data = parseOCR(text);
    console.log('Parsed data:', JSON.stringify(data));
    
    const month = getMonth(data.date);
    console.log('Month:', month);
    
    const rowData = [
      data.address, '', data.date, '', '', data.owner, data.totalCost, '$0', '$0', '$0', data.balanceDue, data.tooP,
      '', '', data.pmntMethod, data.phone, data.email, '', data.dripEdge, data.ventilation,
      data.manufacturer, data.shingleType, data.shingleColor, '', data.notes || ''
    ];
    
    const result = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:A` });
    const nextRow = (result.data.values?.length || 0) + 1;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${month}!A${nextRow}:Z${nextRow}`,
      valueInputOption: 'USER_ENTERED', requestBody: { values: [rowData] }
    });
    
    console.log(`Added to ${month} row ${nextRow}`);
    res.json({ success: true, month, owner: data.owner, row: nextRow, extracted: text.substring(0, 100) });
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
