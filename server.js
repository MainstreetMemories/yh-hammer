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

// Convert PDF to images and extract with AI
async function extractFromPDF(pdfPath) {
  try {
    // Dynamic import for pdf.js
    const pdfjs = await import('pdfjs-dist');
    
    // Set worker
    pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;
    
    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfData = new Uint8Array(pdfBuffer);
    
    const pdfDoc = await pdfjs.getDocument({ data: pdfData }).promise;
    console.log(`PDF has ${pdfDoc.numPages} pages`);
    
    let allText = '';
    
    // Convert each page to image
    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.0 }); // Higher scale = better quality
      
      // Create canvas
      const canvas = new (await import('canvas')).createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');
      
      await page.render({
        canvasContext: ctx,
        viewport: viewport
      }).promise;
      
      // Convert to base64
      const imageBuffer = canvas.toBuffer('image/png');
      const base64 = imageBuffer.toString('base64');
      
      console.log(`Converting page ${pageNum} to image...`);
      
      // Send to AI
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        return 'Owner: Unknown';
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
              { type: 'text', text: 'Extract these fields from this contract image. Return each on its own line as "Field: Value": Owner, Address, Phone, Email, Total Cost, Contract Date, Shingle Manufacturer, Shingle Type, Insurance Deductible' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }
            ]
          }],
          max_tokens: 1500
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        const extracted = data.choices[0]?.message?.content || '';
        allText += extracted + '\n';
      }
    }
    
    return allText;
  } catch (e) {
    console.log('PDF extraction error:', e.message);
    return '';
  }
}

// Extract from image (JPG, PNG)
async function extractFromImage(imagePath, fileExt) {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64 = imageBuffer.toString('base64');
  const mimeType = fileExt === '.png' ? 'image/png' : 'image/jpeg';
  
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
        content: [
          { type: 'text', text: 'Extract these fields from this contract image. Return each on its own line as "Field: Value": Owner, Address, Phone, Email, Total Cost, Contract Date, Shingle Manufacturer, Shingle Type, Insurance Deductible' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
        ]
      }],
      max_tokens: 1500
    })
  });
  
  if (!response.ok) {
    const err = await response.text();
    console.log('API Error:', err);
    return '';
  }
  
  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

function parseOCR(text) {
  const amounts = text.match(/\$[\d,]+\.?\d{0,2}/g) || [];
  
  const fieldMatch = (fieldName) => {
    const m = text.match(new RegExp(`Field:?\\s*${fieldName}:?\\s*([^\\n]+)`, 'i'));
    if (m) return m[1].trim();
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
  
  const dateMatch = text.match(/(?:Contract Date|Date):?\s*([A-Za-z0-9\s,]+)/i) || text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
  const date = dateMatch ? dateMatch[1].trim() : '';
  
  const totalCost = amounts[0] ? amounts[0].replace('$','').replace(/,/g,'') : '0';
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
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  for (let i = 0; i < monthNames.length; i++) {
    if (dateStr.toLowerCase().includes(monthNames[i].toLowerCase())) {
      return monthNames[i];
    }
  }
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
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    
    let aiText = '';
    
    if (fileExt === '.pdf') {
      console.log('Processing PDF...');
      // Try to convert PDF to image and extract
      try {
        aiText = await extractFromPDF(newPath);
        console.log('PDF extracted:', aiText ? aiText.substring(0, 200) : 'empty');
      } catch (pdfErr) {
        console.log('PDF extraction failed:', pdfErr.message);
        // Fallback - try simple text extraction
        try {
          const { pdf } = await import('pdf-parse');
          const dataBuffer = fs.readFileSync(newPath);
          const data = await pdf(dataBuffer);
          aiText = data.text;
          console.log('Fallback text extraction:', aiText.substring(0, 200));
        } catch (e) {
          console.log('Text extraction also failed');
        }
      }
    } else if (['.jpg', '.jpeg', '.png'].includes(fileExt)) {
      console.log('Processing image...');
      aiText = await extractFromImage(newPath, fileExt);
      console.log('Image extracted:', aiText ? aiText.substring(0, 200) : 'empty');
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Please upload PDF or JPG/PNG.' });
    }
    
    if (!aiText || aiText.length < 10) {
      return res.status(400).json({ error: 'Could not extract text from file. Please use Edit Records to enter manually.' });
    }
    
    const data = parseOCR(aiText);
    console.log('Parsed data:', JSON.stringify(data));
    
    if (!data.owner || data.owner === 'Unknown' || data.owner.length < 3) {
      return res.status(400).json({ error: 'Could not extract valid contract data. Please enter manually using Edit Records.' });
    }
    
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
    
    console.log(`Added to ${month} row ${nextRow}`);
    res.json({ success: true, month, owner: data.owner, row: nextRow });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/uploads', (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR).filter(f => f.endsWith('.pdf') || f.endsWith('.jpg') || f.endsWith('.png'));
  res.json({ files });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`YH Contract App running on port ${PORT}`));