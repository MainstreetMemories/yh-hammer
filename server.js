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

async function getAllMonths() {
  const result = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  return result.data.sheets.map(s => s.properties.title).filter(t => t !== 'Customer Information');
}

app.get('/api/jobs', async (req, res) => {
  try {
    const months = await getAllMonths();
    const allJobs = {};
    for (const month of months) {
      const result = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A4:Z` });
      const jobs = result.data.values || [];
      allJobs[month] = jobs.map((job, idx) => ({
        row: idx + 4, address: job[0] || '', owner: job[5] || '', phone: job[15] || '', email: job[16] || '',
        contractDate: job[2] || '', totalCost: job[6] || '', balanceDue: job[10] || '', tooP: job[11] || '',
        manufacturer: job[21] || '', shingleType: job[22] || '', notes: job[25] || ''
      }));
    }
    res.json(allJobs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/update', async (req, res) => {
  const { month, row, field, value } = req.body;
  const fieldMap = {
    address: 'A', contractDate: 'C', owner: 'F', totalCost: 'G', balanceDue: 'K', tooP: 'L',
    pmntMethod: 'O', phone: 'P', email: 'Q', manufacturer: 'W', shingleType: 'X', notes: 'Z'
  };
  if (!fieldMap[field]) return res.status(400).json({ error: 'Invalid field' });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${month}!${fieldMap[field]}${row}`,
    valueInputOption: 'USER_ENTERED', requestBody: { values: [[value]] }
  });
  res.json({ success: true });
});

// Simple text extraction from PDF
async function extractTextFromPDF(pdfPath) {
  try {
    const { default: pdf } = await import('pdf-parse');
    const dataBuffer = fs.readFileSync(pdfPath);
    const data = await pdf(dataBuffer);
    return data.text || '';
  } catch (e) {
    console.log('PDF parse error:', e.message);
    return '';
  }
}

// Send to AI for extraction
async function extractWithAI(content, contentType = 'text/plain') {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return 'Owner: Unknown';
  
  let contentArray;
  
  if (contentType.startsWith('image/')) {
    // It's an image - send directly to AI
    contentArray = [
      { type: 'text', text: 'Extract these fields from this contract. Return each on its own line as "Field: Value": Owner, Address, Phone, Email, Total Cost, Contract Date, Shingle Manufacturer, Shingle Type, Insurance Deductible' },
      { type: 'image_url', image_url: { url: `data:${contentType};base64,${content}` } }
    ];
  } else {
    // It's text - send to AI with prompt
    contentArray = [
      { type: 'text', text: `Extract these fields from this contract. Return each on its own line as "Field: Value": Owner, Address, Phone, Email, Total Cost, Contract Date, Shingle Manufacturer, Shingle Type, Insurance Deductible\n\nContract text:\n${content.substring(0, 10000)}` }
    ];
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
      messages: [{ role: 'user', content: contentArray }],
      max_tokens: 1500
    })
  });
  
  if (!response.ok) return '';
  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

function parseOCR(text) {
  const amounts = text.match(/\$[\d,]+\.?\d{0,2}/g) || [];
  
  const fieldMatch = (name) => {
    const patterns = [
      new RegExp(`Field:?\\s*${name}:?\\s*([^\\n]+)`, 'i'),
      new RegExp(`${name}:?\\s*([^\\n]+)`, 'i')
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1].trim();
    }
    return '';
  };
  
  return {
    owner: fieldMatch('Owner') || 'Unknown',
    address: fieldMatch('Address') || fieldMatch('Property') || '',
    phone: fieldMatch('Phone') || '',
    email: fieldMatch('Email') || '',
    totalCost: amounts[0] ? amounts[0].replace(/[$,]/g, '') : '0',
    balanceDue: amounts[0] ? amounts[0].replace(/[$,]/g, '') : '0',
    tooP: amounts[1] ? amounts[1].replace(/[$,]/g, '') : fieldMatch('Deductible') || '0',
    date: fieldMatch('Date') || fieldMatch('Contract Date') || '',
    pmntMethod: 'Check',
    dripEdge: 'Black',
    ventilation: 'Black',
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
  if (m) {
    const monthNum = parseInt(m[1]);
    if (monthNum >= 1 && monthNum <= 12) return months[monthNum - 1];
  }
  return 'April';
}

app.post('/api/upload', upload.single('contract'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const tempPath = req.file.path;
    const newPath = path.join(UPLOAD_DIR, `${Date.now()}_${req.file.originalname}`);
    fs.renameSync(tempPath, newPath);
    
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    console.log('Processing file:', req.file.originalname, 'type:', fileExt);
    
    let aiText = '';
    
    // Handle based on file type
    if (fileExt === '.pdf') {
      // Try PDF text extraction
      console.log('Extracting text from PDF...');
      const pdfText = await extractTextFromPDF(newPath);
      console.log('PDF text length:', pdfText.length);
      
      if (pdfText && pdfText.length > 50) {
        // Got text - use AI to parse
        console.log('Sending to AI...');
        aiText = await extractWithAI(pdfText, 'text/plain');
      } else {
        // Couldn't extract text - need to ask for image
        return res.status(400).json({ 
          error: 'This PDF appears to be a scanned image. Please take a photo of the contract and upload as JPG/PNG instead.',
          needsImage: true
        });
      }
    } else if (['.jpg', '.jpeg', '.png'].includes(fileExt)) {
      // Handle image directly
      console.log('Processing image...');
      const imageBuffer = fs.readFileSync(newPath);
      const base64 = imageBuffer.toString('base64');
      const mimeType = fileExt === '.png' ? 'image/png' : 'image/jpeg';
      aiText = await extractWithAI(base64, mimeType);
    }
    
    console.log('AI result:', aiText ? aiText.substring(0, 200) : 'empty');
    
    const data = parseOCR(aiText);
    console.log('Parsed:', JSON.stringify(data));
    
    if (!data.owner || data.owner === 'Unknown' || data.owner.length < 3) {
      return res.status(400).json({ error: 'Could not extract valid data. Please use Edit Records to enter manually.' });
    }
    
    const month = getMonth(data.date);
    const rowData = [
      data.address, '', data.date, '', '', data.owner, data.totalCost, '$0', '$0', '$0', data.balanceDue, data.tooP,
      '', '', data.pmntMethod, data.phone, data.email, '', data.dripEdge, data.ventilation,
      data.manufacturer, data.shingleType, '', '', ''
    ];
    
    const result = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:A` });
    const nextRow = (result.data.values?.length || 0) + 1;
    
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