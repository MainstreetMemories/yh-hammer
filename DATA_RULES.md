# Yellow Hammer App - Data Handling Rules

## Contract Upload Flow

### 1. File Upload
- User uploads PDF (including scanned images)
- PDF.js converts first 2 pages to images
- Images sent to AI for extraction

### 2. AI Extraction (from first 2 pages)
**From Page 1:**
- Owner (Field: Owner or Name)
- Address + City + State + Zip → Combined into Column A
- Phone
- Email
- Total Cost
- T.O.O.P

**From Page 2:**
- Contract Date (date after "YHP Representative Signature")

### 3. Spreadsheet Columns (A-AE)

| Column | Field | Source |
|--------|-------|--------|
| A | Address | Combined: Address, City, State, Zip |
| B | Cert Of Comp | User enters later |
| C | Contract Date | From page 2 |
| D | Estimate Date | User enters later |
| E | Install Date | User enters later |
| F | Owner | From page 1 |
| G | Total Cost | From page 1 |
| L | T.O.O.P | From page 1 |

### 4. Save Flow
- Shows extracted data in editable form
- User can edit any field
- User selects month
- Click Save → writes to Google Sheets row 2 (first data row)

## Data Alignment Notes
- Header row: Row 1
- First data row: Row 2
- 31 columns total (A through AE)
