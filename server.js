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

app.get('/api/jobs', async (req, res) => {
  const result = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const months = result.data.sheets.map(s => s.properties.title).filter(t => t !== 'Customer Information');
  const allJobs = {};
  for (const month of months) {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A4:Z` });
    allJobs[month] = (r.data.values || []).map((job, idx) => ({ row: idx + 4, address: job[0] || '', owner: job[5] || '', phone: job[15] || '', email: job[16] || '', contractDate: job[2] || '', totalCost: job[6] || '', manufacturer: job[21] || '', shingleType: job[22] || '' }));
  }
  res.json(allJobs);
});

app.post('/api/jobs/update', async (req, res) => {
  const { month, row, field, value } = req.body;
  const map = { address: 'A', owner: 'F', totalCost: 'G', phone: 'P', email: 'Q', manufacturer: 'W', shingleType: 'X' };
  if (!map[field]) return res.status(400).json({ error: 'Invalid field' });
  await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${month}!${map[field]}${row}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[value]] } });
  res.json({ success: true });
});

// Convert PDF to image using ImageMagick
async function convertPdfToImage(pdfPath) {
  const outputPath = pdfPath.replace('.pdf', '.png');
  try {
    execSync(`convert -density 200 "${pdfPath}" -quality 100 -resize 2000x "${outputPath}"`, { encoding: 'utf-8' });
    if (fs.existsSync(outputPath)) {
      console.log('Converted PDF to:', outputPath);
      return outputPath;
    }
  } catch (e) {
    console.log('ImageMagick convert failed:', e.message);
  }
  return null;
}

// Use Tesseract.js for OCR on images
async function extractWithOCR(imagePath) {
  try {
    const Tesseract = await import('tesseract.js');
    const result = await Tesseract.recognize(imagePath, 'eng', { logger: m => console.log('OCR:', m.status) });
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
    const data = await pdf(fs.readFileSync(pdfPath));
    return data.text || '';
  } catch (e) { return ''; }
}

// Use AI to parse extracted text
async function parseWithAI(text) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return '';
  
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'HTTP-Referer': 'https://yh-hammer.onrender.com', 'X-Title': 'Yellow Hammer' },
    body: JSON.stringify({
      model: 'anthropic/claude-3-haiku',
      messages: [{ role: 'user', content: `Extract: Owner, Address, Phone, Email, Total Cost, Date, Shingle. Format: Field: Value\n\n${text.substring(0, 8000)}` }],
      max_tokens: 1500
    })
  });
  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

function parseOCR(text) {
  const amounts = text.match(/\$[\d,]+\.?\d{0,2}/g) || [];
  const field = (name) => { const m = text.match(new RegExp(`(?:Field:\\s*)?${name}:?\\s*([^\\n]+)`, 'i')); return m ? m[1].trim() : ''; };
  return { owner: field('Owner') || 'Unknown', address: field('Address') || '', phone: field('Phone') || '', email: field('Email') || '', totalCost: amounts[0]?.replace(/[$,]/g, '') || '0', balanceDue: amounts[0]?.replace(/[$,]/g, '') || '0', tooP: amounts[1]?.replace(/[$,]/g, '') || field('Deductible') || '0', date: field('Date') || field('Contract Date') || '', manufacturer: field('Manufacturer') || field('Shingle') || '', shingleType: field('Type') || '' };
}

function getMonth(dateStr) {
  if (!dateStr) return 'April';
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  for (let i = 0; i < months.length; i++) if (dateStr.toLowerCase().includes(months[i].toLowerCase())) return months[i];
  const m = dateStr.match(/(\d{1,2})[\/\-]/); if (m) { const n = parseInt(m[1]); if (n >= 1 && n <= 12) return months[n - 1]; }
  return 'April';
}

app.post('/api/upload', upload.single('contract'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const newPath = path.join(UPLOAD_DIR, `${Date.now()}_${req.file.originalname}`);
    fs.renameSync(req.file.path, newPath);
    
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    console.log('Processing:', req.file.originalname);
    
    let text = '';
    
    if (fileExt === '.pdf') {
      // Try text extraction first
      text = await extractTextFromPDF(newPath);
      console.log('PDF text length:', text.length);
      
      if (!text || text.length < 50) {
        // Try converting PDF to image using ImageMagick
        const imagePath = await convertPdfToImage(newPath);
        if (imagePath) {
          text = await extractWithOCR(imagePath);
          console.log('OCR text length:', text.length);
        }
      }
    } else if (['.jpg', '.jpeg', '.png'].includes(fileExt)) {
      text = await extractWithOCR(newPath);
    }
    
    if (!text || text.length < 20) {
      return res.status(400).json({ error: 'Could not read file. Please try a clearer image.' });
    }
    
    const aiResult = await parseWithAI(text);
    const data = parseOCR(aiResult || text);
    
    if (!data.owner || data.owner === 'Unknown' || data.owner.length < 3) {
      return res.status(400).json({ error: 'Could not extract data. Please enter manually.' });
    }
    
    const month = getMonth(data.date);
    const rowData = [data.address, '', data.date, '', '', data.owner, data.totalCost, '$0', '$0', '$0', data.balanceDue, data.tooP, '', '', 'Check', data.phone, data.email, '', 'Black', 'Black', data.manufacturer, data.shingleType, '', '', ''];
    
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A:A` });
    const nextRow = (r.data.values?.length || 0) + 1;
    
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${month}!A${nextRow}:Z${nextRow}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [rowData] } });
    
    res.json({ success: true, month, owner: data.owner });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));