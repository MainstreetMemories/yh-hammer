Let me give you a super simple version that will definitely work:

**Replace `server.js` with this:**

```javascript
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { google } = require('googleapis');
const path = require('path');

// Get credentials from environment variable
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = '1YmEsM3AvtIbNqto8DoYLMO48tH13UY23niGvRz5vOtU';

const app = express();
const upload = multer({ dest: '/tmp' });

app.use(express.static('public'));
app.use(express.json());

app.post('/api/upload', upload.single('contract'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    
    const month = 'March';
    const rowData = ['Test Address', '', '3/15/26', '', '', 'Test Owner', '$5000', '$0', '$0', '$0', '$5000', '$500', '', 'Check', '', '', '', '', '', '', '', '', '', '', ''];
    
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
    
    res.json({ success: true, month, owner: 'Test' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('App running on port ' + PORT));
```

**Also update `package.json`** to remove `"type": "module"` so it's:
```json
{
  "name": "yh-hammer",
  "version": "1.0.0",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "express": "^4.18.2",
    "multer": "^1.4.5-lts.1",
    "googleapis": "^129.0.0"
  }
}
```

Make both changes in GitHub and redeploy!
