# How Claude Code Converts Input Files (PDF, Images, Notebooks)

Analysis of file conversion in Claude Code v2.1.72, extracted from the bundled `cli.js` source.

## Overview

Claude Code's Read tool handles several file types beyond plain text. The conversion strategy depends on the file type and the **provider mode** (first-party Anthropic API vs. third-party like Vertex/Foundry).

## File Type Detection

Files are classified by extension into categories:

| Category | Extensions | Handling |
|----------|-----------|----------|
| **Text** | `.js`, `.py`, `.md`, `.txt`, etc. | Read as UTF-8 text with line numbers |
| **Images** | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` | Resized via Sharp, sent as base64 image blocks |
| **PDF** | `.pdf` | Two paths: API document block or pdftoppm rendering |
| **Notebooks** | `.ipynb` | Parsed as JSON, cells extracted with outputs |
| **Binary** | `.exe`, `.dll`, `.zip`, `.docx`, `.xlsx`, etc. | **Rejected** — "This tool cannot read binary files" |

### Key finding: DOCX, XLSX, PPTX are NOT converted

These Office formats are in the binary file blocklist alongside executables and archives. Claude Code **cannot read them**. They are treated as opaque binary files and the Read tool returns an error message suggesting to use appropriate tools for binary file analysis.

## PDF Handling (Two Paths)

PDF is the only "document" format with built-in conversion. There are two distinct rendering paths:

### Path 1: First-Party API (Anthropic Direct) — Native PDF Support

When `Dh6()` returns true (provider is `"firstParty"`, i.e., direct Anthropic API):

```
Function: no7(filePath)
```

1. **Validate** — check file exists, is non-empty, has `%PDF-` header
2. **Size check** — must be ≤ 20 MB (`_P6 = 20971520`)
3. **Read entire file** into a Buffer via `fs.readFile`
4. **Base64 encode** — `buffer.toString("base64")`
5. **Send as document block** to the API:
   ```json
   {
     "type": "document",
     "source": {
       "type": "base64",
       "media_type": "application/pdf",
       "data": "<base64-encoded-pdf>"
     }
   }
   ```

This uses the Anthropic API's native PDF understanding — the PDF is sent as-is (base64) and Claude processes it directly. No text extraction or image conversion occurs.

### Path 2: Third-Party / Fallback — pdftoppm Rendering

When not using first-party API, or when specific page ranges are requested:

```
Function: ZZ8(filePath, pageRange?)
```

1. **Check pdftoppm availability** — runs `pdftoppm -v` to verify poppler-utils is installed
2. **Size check** — must be ≤ 100 MB (`f08 = 104857600`)
3. **Render pages to JPEG** via external command:
   ```
   pdftoppm -jpeg -r 100 [filePath] [outputDir]/page
   ```
   - Resolution: 100 DPI
   - Format: JPEG
   - Optional page range flags: `-f <first>` and `-l <last>`
4. **Collect output JPEGs** — reads the output directory, sorts alphabetically
5. **Resize each page image** via Sharp (`vL` function):
   - Max dimensions: 2000×2000 pixels (`Ks = 2000`, `Ys = 2000`)
   - Max file size: ~3.75 MB (`IC = 3932160` bytes)
   - If within limits, pass through unchanged
   - If too large, resize with Sharp and re-encode as JPEG (quality 80)
6. **Base64 encode** each page image
7. **Send as image blocks** to the API:
   ```json
   [
     {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "..."}},
     {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "..."}}
   ]
   ```

### PDF Size & Page Limits

| Constant | Value | Meaning |
|----------|-------|---------|
| `_P6` | 20 MB | Max PDF size for first-party API path |
| `f08` | 100 MB | Max PDF size for pdftoppm text extraction path |
| `ic7` | 3 MB | Size threshold — above this, attempt pdftoppm even on first-party |
| `wP6` | 20 | Max pages per read request |
| `$J1` | 10 | Max pages before requiring explicit `pages` parameter |
| `lc7` | 100 | Max total pages for a PDF to be readable |

### PDF Error Handling

- **Empty file** → "PDF file is empty"
- **Missing header** → "File is not a valid PDF (missing %PDF- header)"
- **Too large** → "PDF file exceeds maximum allowed size"
- **Password protected** → detected via `pdftoppm` stderr (`/password/i`)
- **Corrupted** → detected via `pdftoppm` stderr (`/damaged|corrupt|invalid/i`)
- **pdftoppm not installed** → "Install poppler-utils" error message
- **Too many pages** → "Use the pages parameter to read specific page ranges"

### PDF Page Count Detection

```
Function: zM1(filePath)
```

Uses `pdfinfo` CLI tool to extract page count:
- Runs `pdfinfo <file>` with 10s timeout
- Parses `Pages: <number>` from stdout via regex
- Falls back to estimating from file size: `Math.ceil(fileSize / 102400)` (~100KB per page)

### Large PDF References

For PDFs with more than 10 pages (`$J1`), instead of reading inline, a **reference** is created:
```json
{
  "type": "pdf_reference",
  "filename": "/path/to/file.pdf",
  "pageCount": 42,
  "fileSize": 1234567
}
```
The model is then instructed to use the Read tool with the `pages` parameter to access specific ranges.

## Image Handling

```
Function: vL(buffer, fileSize, format)
```

Images are processed via **Sharp** (libvips-based image processing library):

1. **Read metadata** — get width, height, format
2. **Size check**:
   - If file ≤ 3.75 MB AND dimensions ≤ 2000×2000 → pass through unchanged
   - Otherwise → resize proportionally to fit within 2000×2000
3. **Re-encode** as JPEG (quality 80) if resizing was needed
4. **Base64 encode** and send as image content block

Supported formats: PNG, JPEG, GIF, WebP, BMP (detected by extension set `ns7`).

## Jupyter Notebook Handling

```
Function: Fo7(filePath) → parses notebook
Function: go7(cell, index) → formats individual cell
```

Notebooks are parsed as JSON (`.ipynb` is a JSON format):

1. **Read file** as UTF-8 text
2. **Parse JSON** structure
3. **Extract cells** with their type (code/markdown), language, source, and outputs
4. **Format each cell** as structured XML-like text:
   - `<cell_type>` tag if not code
   - `<language>` tag if not Python
   - Source code content
   - Outputs (truncated if > 10K characters per cell)
5. **Return as structured data** with cell array

Output types handled: `stream` (stdout/stderr), `execute_result`, `display_data`, `error`.

## What Is NOT Supported

The following formats are explicitly treated as **binary/unsupported** by the Read tool:

- **Office documents**: `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.odt`, `.ods`, `.odp`
- **Archives**: `.zip`, `.tar`, `.gz`, `.7z`, `.rar`
- **Executables**: `.exe`, `.dll`, `.so`, `.dylib`
- **Fonts**: `.ttf`, `.otf`, `.woff`, `.woff2`
- **Design files**: `.psd`, `.ai`, `.sketch`, `.fig`
- **Media**: `.mp4`, `.mov`, `.mp3`, `.wav`, `.ogg`
- **Databases**: `.sqlite`, `.db`

For these formats, users need to convert them externally (e.g., using `pdftotext`, `python-docx`, `pandoc`) before Claude Code can read the content.

## Architecture Summary

```
Read Tool Input (file_path, offset, limit, pages)
         |
         v
    Extension Detection
         |
    +----+----+----+----+
    |    |    |    |    |
   Text  Image PDF  .ipynb  Binary
    |    |    |    |       |
    |    |    |    |       v
    |    |    |    |    ERROR: cannot
    |    |    |    |    read binary files
    |    |    |    |
    |    |    |    v
    |    |    |  JSON parse → cell extraction
    |    |    |    → structured text output
    |    |    |
    |    |    +-- First-party API?
    |    |    |   YES: base64 encode → document block
    |    |    |   NO:  pdftoppm → JPEG pages → Sharp resize → image blocks
    |    |    |
    |    v    v
    |  Sharp resize → base64 → image block
    |
    v
  UTF-8 read → line numbers → text content
```
