# html-to-pdf-api

A minimal, secure HTML → PDF conversion API built for n8n Cloud. Deploys as a
single Vercel serverless function using `puppeteer-core` + `@sparticuz/chromium`
(no paid PDF service, no database, no auth system beyond a shared API key).

```
POST /api/pdf
```

## How it works

1. Send `{ html }`, `{ type: "file", file: "<base64_or_text>" }`, `{ type: "url", url: "https://..." }`, or upload a file via multipart form-data along with an `X-API-Key` header.
2. The function validates the API key and resolves the HTML payload.
3. It launches headless Chromium (via `@sparticuz/chromium`), loads the HTML/URL,
   and renders a PDF with custom options (format, margins, landscape, etc.).
4. It returns the raw PDF bytes with `Content-Type: application/pdf` and a
   `Content-Disposition: attachment` header.
5. n8n (or any HTTP client) receives it as binary data.

## Project structure

```
html-to-pdf-api/
├── api/
│   └── pdf.js        # the serverless function
├── package.json
├── vercel.json        # sets function maxDuration
├── .gitignore
└── README.md
```

## Version compatibility (checked at time of writing)

- `puppeteer-core@^25.0.4`
- `@sparticuz/chromium@^149.0.0` (the version this puppeteer-core release is
  tested against upstream)

These two packages must be upgraded **together**. If you bump one, check the
[@sparticuz/chromium releases](https://github.com/Sparticuz/chromium/releases)
for the matching `puppeteer-core` version before deploying — a mismatch is
the most common cause of "Failed to launch PDF renderer" errors on Vercel.

---

## 1. Create the project locally

```bash
mkdir html-to-pdf-api && cd html-to-pdf-api
```

Then create the files exactly as shown in this repo (`api/pdf.js`,
`package.json`, `vercel.json`, `.gitignore`, `README.md`).

## 2. Install dependencies

```bash
npm install
```

This installs `puppeteer-core` and `@sparticuz/chromium` into `node_modules`
(they're only needed for the Vercel build — there's no separate build step).

### Local testing (optional)

`@sparticuz/chromium` ships a Linux binary meant for Vercel/Lambda, so it
won't launch a browser on your Mac/Windows dev machine out of the box. To
test the handler logic locally without fighting local Chromium binaries, the
simplest path is to deploy to a Vercel **Preview** deployment (step 6/7) and
test against that URL. If you want full local execution, install a full
`puppeteer` (not `-core`) as a dev-only dependency and branch the launch
config on `process.env.VERCEL` — but that's optional and not required to
ship this.

## 3. Push it to GitHub

```bash
git init
git add .
git commit -m "Initial commit: html-to-pdf API"
gh repo create html-to-pdf-api --private --source=. --remote=origin --push
```

(If you don't use the `gh` CLI, create an empty repo on GitHub, then
`git remote add origin <your-repo-url>` and `git push -u origin main`.)

## 4. Import it into Vercel

1. Go to [vercel.com/new](https://vercel.com/new).
2. Import the `html-to-pdf-api` GitHub repo.
3. Framework preset: **Other** (no build command needed — it's just an
   `api/` function).
4. Do **not** deploy yet — add the environment variable first (next step),
   or add it right after the first deploy and redeploy.

## 5. Add `PDF_API_KEY` as a Vercel Environment Variable

1. In the Vercel project → **Settings → Environment Variables**.
2. Name: `PDF_API_KEY`
3. Value: a long random secret, e.g. generate one with:
   ```bash
   openssl rand -hex 32
   ```
4. Environment: check **Production**, **Preview**, and **Development**.
5. Save.

Never commit this value to the repo — it's read only from
`process.env.PDF_API_KEY` at runtime.

## 6. Deploy

If you already imported the project, either click **Deploy** in the
dashboard, or from the CLI:

```bash
npm i -g vercel   # if you don't have it
vercel login
vercel --prod
```

## 7. Test the deployed endpoint

### cURL examples
 
#### 1. Raw HTML (Default / `type: "html"`)
```bash
curl -X POST https://MY-APP.vercel.app/api/pdf \
  -H "Content-Type: application/json" \
  -H "X-API-Key: MY_SECRET" \
  -d '{
    "type": "html",
    "html": "<html><body><h1>PDF Test</h1></body></html>",
    "filename": "test.pdf"
  }' \
  --output test.pdf
```

#### 2. HTML File as Base64 (`type: "file"`)
```bash
# Encode a local .html file to base64
BASE64_HTML=$(base64 -i my_template.html)

curl -X POST https://MY-APP.vercel.app/api/pdf \
  -H "Content-Type: application/json" \
  -H "X-API-Key: MY_SECRET" \
  -d '{
    "type": "file",
    "file": "'"$BASE64_HTML"'",
    "filename": "from_file.pdf"
  }' \
  --output from_file.pdf
```

#### 3. Direct HTML File Upload (`multipart/form-data`)
```bash
curl -X POST https://MY-APP.vercel.app/api/pdf \
  -H "X-API-Key: MY_SECRET" \
  -F "type=file" \
  -F "file=@my_template.html" \
  --output uploaded.pdf
```

#### 4. Web Page URL (`type: "url"`)
```bash
curl -X POST https://MY-APP.vercel.app/api/pdf \
  -H "Content-Type: application/json" \
  -H "X-API-Key: MY_SECRET" \
  -d '{
    "type": "url",
    "url": "https://example.com",
    "filename": "webpage.pdf"
  }' \
  --output webpage.pdf
```

Open `test.pdf` — you should see a one-page A4 PDF with "PDF Test".

### Quick failure checks

```bash
# Missing API key -> 401
curl -i -X POST https://MY-APP.vercel.app/api/pdf \
  -H "Content-Type: application/json" \
  -d '{"html":"<h1>x</h1>"}'

# Missing html -> 400
curl -i -X POST https://MY-APP.vercel.app/api/pdf \
  -H "Content-Type: application/json" \
  -H "X-API-Key: MY_SECRET" \
  -d '{}'
```

---

## n8n HTTP Request node configuration

Add an **HTTP Request** node with:

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `https://MY-APP.vercel.app/api/pdf` |
| Authentication | None (key goes in a header below) |
| Send Headers | On |
| Header 1 | `Content-Type: application/json` |
| Header 2 | `X-API-Key: MY_SECRET` (use an n8n Credential or Environment Variable for this in production, not a hardcoded string) |
| Send Body | On, as **JSON** |
| Body | see below |
| Response Format | **File** (binary) |
| Put Output File in Field | `soa` (this becomes `binary.soa`) |

### Example dynamic body (Expression / JSON mode)

```javascript
{{
{
  html: $json.soa_html,
  filename: `SOA_${$json.account_no}.pdf`
}
}}
```

### Result

The node's output will contain the PDF at `binary.soa`, which you can wire
directly into the **Outlook → Send Email** node's **Attachments** field
(binary property name `soa`).

---

## Error handling reference

| Situation | Response |
|---|---|
| Wrong HTTP method | `405` `{ "error": "Method not allowed. Use POST." }` |
| `PDF_API_KEY` not configured on the server | `500` `{ "error": "Server misconfigured: PDF_API_KEY is not set." }` |
| Missing/invalid `X-API-Key` | `401` `{ "error": "Unauthorized: missing or invalid X-API-Key header." }` |
| Malformed JSON body | `400` `{ "error": "Invalid JSON body.", "details": "..." }` |
| Missing/empty `html` | `400` `{ "error": "Missing or empty \"html\" field in request body." }` |
| Chromium fails to launch | `500` `{ "error": "Failed to launch PDF renderer.", "details": "..." }` |
| Rendering/PDF generation fails (e.g. bad HTML, image fetch timeout) | `500` `{ "error": "Failed to render HTML to PDF.", "details": "..." }` |

The browser is always closed in a `finally` block, whether the request
succeeds or fails, so a crashed render never leaves a Chromium process
hanging around for the next invocation.

## Notes on Vercel limits (current as of this writing)

- **Function bundle size**: uncompressed limit is 250 MB on Vercel — Chromium
  + puppeteer-core comfortably fits.
- **Memory**: Hobby plan functions get a fixed 2 GB / 1 vCPU (not
  configurable). Pro/Enterprise can raise this to 4 GB in project settings if
  you generate very large/complex documents.
- **Duration**: `vercel.json` sets `maxDuration: 60` (seconds) for
  `api/pdf.js`, well under the Hobby plan's 300s cap. Increase it if you
  render very large documents with many external images.
- **Request body size**: Vercel Functions cap request bodies at 4.5 MB. If
  your HTML (e.g. base64-embedded images) regularly exceeds that, host the
  images externally over HTTPS and reference them by URL instead of inlining
  base64.

## HTML support

`page.setContent()` renders full HTML documents, so all of this works
out of the box:

- inline CSS and `<style>` blocks
- tables (great for Statement of Account line items)
- `<img>` logos/signatures via `https://` URLs (loaded before the PDF is
  generated, thanks to `waitUntil: 'networkidle0'`) or `data:` base64 URIs
- CSS `page-break-before` / `page-break-after` / `page-break-inside` for
  multi-page financial documents
- `printBackground: true` ensures background colors/images (e.g. letterhead,
  watermark) show up in the PDF instead of being stripped

---

## Using this for two dynamic PDFs in one n8n workflow

Since the API is stateless and only cares about the `html` you send it, you
can call it twice in the same workflow — once per document — and attach both
to the same email:

1. **Build the HTML for each document** with two separate **Set** / **Code**
   nodes (or a templating node), e.g. `reminder_html` and `soa_html`, using
   your existing data (`$json.account_no`, line items, balances, etc.).
2. **First HTTP Request node** → call `/api/pdf` with:
   ```javascript
   { html: $json.reminder_html, filename: `Reminder_${$json.account_no}.pdf` }
   ```
   Response Format: File, output field: `reminder`.
3. **Second HTTP Request node** → call `/api/pdf` again with:
   ```javascript
   { html: $json.soa_html, filename: `SOA_${$json.account_no}.pdf` }
   ```
   Response Format: File, output field: `soa`.
4. Because each HTTP Request node writes to its own binary property
   (`binary.reminder`, `binary.soa`), you don't need to merge items — as long
   as both nodes run in the same branch/item, both binaries are present on
   the item by the time it reaches the **Outlook → Send Email** node.
5. In the **Send Email** node, set **Attachments** to both binary property
   names, comma-separated: `reminder,soa`.

If the reminder and SOA HTML come from different upstream branches (e.g. two
separate database lookups), use a **Merge** node (mode: "Combine" by
matching a key like `account_no`) before the two HTTP Request nodes so both
attachments land on the same item before the email is sent.

No changes to the API itself are needed — it's already a generic
"HTML in, PDF out" endpoint, so any number of differently-templated
documents can reuse the same `/api/pdf` call.
