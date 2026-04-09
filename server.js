import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { execSync } from 'child_process';

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

// Simple text extraction from PDF
function extractTextFromPDF(pdfPath) {
  try {
    // Use execSync to run python with pdf parser
    const result = execSync(`python3 -c "
import sys
try:
    import pdfplumber
    with pdfplumber.open('${pdfPath}') as pdf:
        text = ''
        for page in pdf.pages:
            text += page.extract_text() or ''
        print(text)
except Exception as e:
    print('ERROR:' + str(e))
"`, { encoding: 'utf-8', maxBuffer: 10*1024*1024 });
    return result;
  } catch (e) {
    return '';
  }
}

// AI-powered extraction using text (not image)
async function extractWithAI(text) {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return 'Owner: Unknown\nAddress: \nTotal Cost: $0';

    // Send text instead of image
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
          content: `Extract these fields from this roofing contract. Return each on its own line as "Field: Value":\n- Owner (property owner name)\n- Address (full property address)\n- Phone\n- Email\n- Total Cost (dollar amount)\n- Contract Date\n- Shingle Manufacturer\n- Shingle Type\n- Insurance Deductible\n\nContract text:\n${text.substring(0, 8000)}`
        }],
        max_tokens: 1500
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.log('API Error:', errText);
      return '';
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  } catch (e) {
    console.log('AI extraction error:', e.message);
    return '';
  }
}

function parseOCR(text) {
  const amounts = text.match(/\$[\d,]+\.?\d{0,2}/g) || [];
  
  // Handle "Field: Value" format from AI
  const fieldMatch = (fieldName) => {
    // Try "Field: Value" format first
    const m = text.match(new RegExp(`Field:?\\s*${fieldName}:?\\s*([^\\n]+)`, 'i'));
    if (m) return m[1].trim();
    // Try plain "Value:" format
    const m2 = text.match(new RegExp(`${fieldName}:?\\s*([^\\n]+)`, 'i'));
    if (m2) return m2[1].trim();
    return '';
  };
  
  const owner = fieldMatch('Owner') || 'Unknown';
  const address = fieldMatch('Address') || fieldMatch('Property') || '';
  const phone = fieldMatch('Phone') || '';
  const email = fieldMatch('Email') || '';
  const manufacturer = fieldMatch('Shingle Manufacturer') || fieldMatch('Manufacturer') || '';
  const shingleType = fieldMatch('Shingle Type') || fieldMatch('Type') || '';
  const deductible = fieldMatch('Insurance Deductible') || fieldMatch('Deductible') || '0';
  
  // Extract dates - look for dates in the text
  const dateMatch = text.match(/(?:Contract Date|Date):?\s*([A-Za-z0-9\s,]+)/i) || text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
  const date = dateMatch ? dateMatch[1].trim() : '';
  
  // Get first dollar amount for total cost
  const totalCost = amounts[0] ? amounts[0].replace('$','').replace(/,/g,'') : '0';
  
  // Second amount is usually deductible
  const tooP = amounts[1] ? amounts[1].replace('$','').replace(/,/g,'') : deductible;

  return {
    owner, address, phone, email,
    totalCost,
    balanceDue: totalCost,
    tooP,
    date,
    pmntMethod: 'Check',
    dripEdge: 'Black',
    ventilation: 'Black',
    manufacturer,
    shingleType,
    shingleColor: ''
  };
}

function getMonth(dateStr) {
  if (!dateStr) return 'April';
  
  // Handle "Month DD, YYYY" format
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  for (let i = 0; i < monthNames.length; i++) {
    if (dateStr.toLowerCase().includes(monthNames[i].toLowerCase())) {
      return monthNames[i];
    }
  }
  
  // Handle MM/DD/YYYY format
  const parts = dateStr.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (parts) {
    const m = parseInt(parts[1]);
    if (!isNaN(m) && m >= 1 && m <= 12) {
      return monthNames[m - 1];
    }
  }
  
  return 'April';
}

app.post('/api/upload', upload.single('contract'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const tempPath = req.file.path;
    const newName = `${Date.now()}_${req.file.originalname}`;
    const newPath = path.join(UPLOAD_DIR, newName);
    fs.renameSync(tempPath, newPath);
    
    console.log('Processing upload:', newName);
    
    // Step 1: Extract text from PDF (works for text-based PDFs)
    let pdfText = '';
    try {
      const result = execSync(`python3 -c "
import sys
try:
    import pdfplumber
    with pdfplumber.open('${newPath}') as pdf:
        for page in pdf.pages:
            t = page.extract_text()
            if t:
                print(t)
except:
    try:
        import fitz
        doc = fitz.open('${newPath}')
        for page in doc:
            print(page.get_text())
    except:
        print('')
"`, { encoding: 'utf-8', maxBuffer: 10*1024*1024 });
      pdfText = result;
    } catch (e) {
      console.log('Text extraction failed:', e.message);
    }
    
    console.log('Extracted PDF text length:', pdfText.length);
    
    // Check if PDF has real text content
    if (pdfText.length < 10) {
      console.log('PDF text extraction failed - cannot read scanned PDF');
      return res.status(400).json({ error: 'Cannot read this PDF. It may be a scanned image. Please use Edit Records to enter manually.' });
    }
    
    // Step 2: Use AI to parse the text
    const aiText = await extractWithAI(pdfText);
    console.log('AI Extracted:', aiText ? aiText.substring(0, 300) : 'empty');
    
    // Step 3: Parse into fields
    const data = parseOCR(aiText || pdfText);
    console.log('Parsed data:', JSON.stringify(data));
    
    const month = getMonth(data.date);
    console.log('Month:', month);
    
    // Validate we have real data before saving
    if (!data.owner || data.owner === 'Unknown' || data.owner.length < 3) {
      console.log('No valid data extracted - not saving to spreadsheet');
      return res.status(400).json({ error: 'Could not extract valid contract data. Please enter manually using Edit Records.' });
    }
    
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
    
    console.log(`Added to ${month} row ${nextRow}`);
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
