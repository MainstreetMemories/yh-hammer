import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';
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

app.get('/api/jobs', async (req, res) => {
  try {
    const result = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const months = result.data.sheets.map(s => s.properties.title).filter(t => t !== 'Customer Information');
    const allJobs = {};
    for (const month of months) {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A4:Z` });
      allJobs[month] = (r.data.values || []).map((job, idx) => ({
        row: idx + 4, address: job[0] || '', owner: job[5] || '', phone: job[15] || '', email: job[16] || '',
        contractDate: job[2] || '', totalCost: job[6] || '', manufacturer: job[21] || '', shingleType: job[22] || ''
      }));
    }
    res.json(allJobs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/update', async (req, res) => {
  const { month, row, field, value } = req.body;
  const fieldMap = { address: 'A', owner: 'F', totalCost: 'G', phone: 'P', email: 'Q', manufacturer: 'W', shingleType: 'X' };
  if (!fieldMap[field]) return res.status(400).json({ error: 'Invalid field' });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${month}!${fieldMap[field]}${row}`,
    valueInputOption: 'USER_ENTERED', requestBody: { values: [[value]] }
  });
  res.json({ success: true });
});

// Use Tesseract.js for OCR
async function extractTextWithOCR(filePath) {
  try {
    const Tesseract = await import('tesseract.js');
    console.log('Starting OCR on:', filePath);
    const result = await Tesseract.recognize(filePath, 'eng', {
      logger: m => console.log('OCR:', m.status, m.progress)
    });
    return result.data.text || '';
  } catch (e) {
    console.log('OCR error:', e.message);
    return '';
  }
}

// Extract text from PDF using pdf-parse
async function extractTextFromPDF(pdfPath) {
  try {
    const { default: pdf } = await import('pdf-parse');
    const dataBuffer = fs.readFileSync(pdfPath);
    const data = await pdf(dataBuffer);
    return data.text || '';
  } catch (e) {
    return '';
  }
}

// Send text to AI for parsing
async function parseWithAI(text) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return 'Owner: Unknown';
  
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
        content: `Extract from this contract: Owner, Address, Phone, Email, Total Cost, Contract Date, Shingle Manufacturer, Shingle Type. Return as "Field: Value" on each line.\n\n${text.substring(0, 8000)}`
      }],
      max_tokens: 1500
    })
  });
  
  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

function parseOCR(text) {
  const amounts = text.match(/\$[\d,]+\.?\d{0,2}/g) || [];
  const fieldMatch = (name) => {
    const m = text.match(new RegExp(`(?:Field:\\s*)?${name}:?\\s*([^\\n]+)`, 'i'));
    return m ? m[1].trim() : '';
  };
  
  return {
    owner: fieldMatch('Owner') || 'Unknown',
    address: fieldMatch('Address') || '',
    phone: fieldMatch('Phone') || fieldMatch('Tel') || '',
    email: fieldMatch('Email') || '',
    totalCost: amounts[0] ? amounts[0].replace(/[$,]/g, '') : '0',
    balanceDue: amounts[0] ? amounts[0].replace(/[$,]/g, '') : '0',
    tooP: amounts[1] ? amounts[1].replace(/[$,]/g, '') : fieldMatch('Deductible') || '0',
    date: fieldMatch('Date') || fieldMatch('Contract Date') || '',
    pmntMethod: 'Check',
    manufacturer: fieldMatch('Manufacturer') || fieldMatch('Shingle Manufacturer') || '',
    shingleType: fieldMatch('Type') || fieldMatch('Shingle Type') || ''
  };
}

function getMonth(dateStr) {
  if (!dateStr) return 'April';
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  for (let i = 0; i < months.length; i++) {
    if (dateStr.toLowerCase().includes(months[i].toLowerCase())) return months[i];
  }
  const m = dateStr.match(/(\d{1,2})[\/\-]/);
  if (m) { const n = parseInt(m[1]); if (n >= 1 && n <= 12) return months[n - 1]; }
  return 'April';
}

app.post('/api/upload', upload.single('contract'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const tempPath = req.file.path;
    const newPath = path.join(UPLOAD_DIR, `${Date.now()}_${req.file.originalname}`);
    fs.renameSync(tempPath, newPath);
    
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    console.log('Processing:', req.file.originalname);
    
    let text = '';
    
    if (fileExt === '.pdf') {
      // Try PDF text extraction first
      text = await extractTextFromPDF(newPath);
      console.log('PDF text length:', text.length);
      
      if (!text || text.length < 50) {
        // PDF has no text - use OCR
        console.log('No text found, using OCR...');
        text = await extractTextWithOCR(newPath);
        console.log('OCR text length:', text.length);
      }
    } else if (['.jpg', '.jpeg', '.png'].includes(fileExt)) {
      // For images, use OCR
      text = await extractTextWithOCR(newPath);
      console.log('Image OCR length:', text.length);
    }
    
    if (!text || text.length < 20) {
      return res.status(400).json({ error: 'Could not read this file. Please try a clearer image.' });
    }
    
    // Parse with AI
    console.log('Parsing with AI...');
    const aiResult = await parseWithAI(text);
    console.log('AI result:', aiResult.substring(0, 200));
    
    const data = parseOCR(aiResult || text);
    console.log('Parsed:', JSON.stringify(data));
    
    if (!data.owner || data.owner === 'Unknown' || data.owner.length < 3) {
      return res.status(400).json({ error: 'Could not extract data. Please enter manually.' });
    }
    
    const month = getMonth(data.date);
    const rowData = [data.address, '', data.date, '', '', data.owner, data.totalCost, '$0', '$0', '$0', data.balanceDue, data.tooP, '', '', data.pmntMethod, data.phone, data.email, '', 'Black', 'Black', data.manufacturer, data.shingleType, '', '', ''];
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:A` });
    const nextRow = (r.data.values?.length || 0) + 1;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${month}!A${nextRow}:Z${nextRow}`,
      valueInputOption: 'USER_ENTERED', requestBody: { values: [rowData] }
    });
    
    console.log(`Saved to ${month} row ${nextRow}`);
    res.json({ success: true, month, owner: data.owner });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));