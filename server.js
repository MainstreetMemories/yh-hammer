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

// AI-powered OCR using OpenRouter
async function extractWithAI(pdfPath) {
  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const base64 = pdfBuffer.toString('base64');
    
    const apiKey = process.env.OPENROUTER_API_KEY;
    
    if (!apiKey) {
      console.log('No API key, falling back to tesseract');
      return extractWithTesseract(pdfPath);
    }
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'anthropic/claude-3-haiku',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Extract ALL text from this roofing contract. Include: property owner name, address (street, city, state, zip), phone, email, contract price, total cost, insurance deductible, shingle manufacturer, shingle type, shingle color, installation date, and any other important details. Return as plain text with labels.'
                              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:application/pdf;base64,${base64}`
                }
              }
            ]
          }
        ],
        max_tokens: 2000
      })
    });

    if (!response.ok) {
            throw new Error(`AI API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  } catch (e) {
    console.log('AI extraction error:', e.message);
    return extractWithTesseract(pdfPath);
  }
}

function extractWithTesseract(pdfPath) {
  try {
    const result = execSync(
      `python3 -c "
      import sys
sys.path.insert(0, '/root/.openclaw/workspace/yh-app')
from ocr import extract_text_from_pdf
text = extract_text_from_pdf('${pdfPath}')
print(text)
"`,
      { encoding: 'utf-8', maxBuffer: 10*1024*1024 }
    );
    return result;
  } catch (e) {
    console.log('OCR error:', e.message);
    return '';
  }
}
function parseOCR(text) {
  const amounts = text.match(/\$[\d,]+\.?\d{0,2}/g) || [];
  
  const namePatterns = [
    /Property Owner[s]?:?\s*([A-Z][a-z]+ [A-Z][a-z]+)/i,
    /Owner:?\s*([A-Z][a-z]+ [A-Z][a-z]+)/i,
    /Name:?\s*([A-Z][a-z]+ [A-Z][a-z]+)/i
  ];
  let owner = '';
  for (const p of namePatterns) {
    const m = text.match(p);
    if (m) { owner = m[1]; break; }
  }
  
  const dateMatch = text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
    const date = dateMatch ? dateMatch[1] : '';
  
  const addrMatch = text.match(/(\d+\s+[A-Za-z\s]+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Cape Rd))/i);
  const phoneMatch = text.match(/(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})/);
  const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  const shingleMatch = text.match(/(Tamko|Owens|Corning|Atlas|Heritage)[^.\n]*/i);
  
  return {
    owner: owner,
    address: addrMatch ? addrMatch[1] : '',
    phone: phoneMatch ? phoneMatch[1] : '',
    email: emailMatch ? emailMatch[1] : '',
    totalCost: amounts[0]?.replace('$','') || '0',
    balanceDue: amounts[0]?.replace('$','') || '0',
    tooP: amounts[1]?.replace('$','') || '0',
        date: date,
    pmntMethod: 'Check',
    dripEdge: 'Black',
    ventilation: 'Black',
    manufacturer: shingleMatch ? shingleMatch[1] : '',
    shingleType: '',
    shingleColor: ''
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
    
    console.log('Extracting text from PDF...');
    const text = await extractWithAI(newPath);
    console.log('Extracted text length:', text.length);
        
    const data = parseOCR(text);
    console.log('Parsed data:', data);
    
    const month = getMonth(data.date);
    
    const rowData = [
      data.address, '',
      data.date, '', '', data.owner, data.totalCost, '$0', '$0', '$0', data.balanceDue, data.tooP,
      '', '', data.pmntMethod, data.phone, data.email, '', data.dripEdge, data.ventilation,
      data.manufacturer, data.shingleType, data.shingleColor, '', ''
    ];
    
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
            range: `${month}!A:A`
    });
    const nextRow = (result.data.values?.length || 0) + 1;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${month}!A${nextRow}:Z${nextRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] }
    });
    
    console.log(`Added to ${month} row ${nextRow}`);
    res.json({ success: true, month, owner: data.owner, file: newName, extractedText: text.substring(0, 500) });
  } catch (err) {
    console.error('Error:', err);
        res.status(500).json({ error: err.message });
  }
});

app.get('/api/uploads', (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR).filter(f => f.endsWith('.pdf'));
  res.json({ files });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`YH Contract App running on port ${PORT}`));
