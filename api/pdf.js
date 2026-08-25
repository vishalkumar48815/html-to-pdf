import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import Handlebars from 'handlebars';

// Pure PDF/screenshot workloads don't need WebGL; disabling it speeds up cold starts.
chromium.setGraphicsMode = false;

const DEFAULT_FILENAME = 'document.pdf';

// Register Handlebars Helpers
Handlebars.registerHelper('money', function (val) {
  if (val === null || val === undefined || val === '') return '';
  const num = typeof val === 'number' ? val : parseFloat(String(val).replace(/,/g, ''));
  if (isNaN(num)) return val;
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
});

Handlebars.registerHelper('blankZero', function (val) {
  if (val === null || val === undefined || val === '') return '';
  const num = typeof val === 'number' ? val : parseFloat(String(val).replace(/,/g, ''));
  if (isNaN(num) || num === 0) return '';
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
});

Handlebars.registerHelper('eq', (a, b) => a === b);
Handlebars.registerHelper('ne', (a, b) => a !== b);
Handlebars.registerHelper('gt', (a, b) => a > b);
Handlebars.registerHelper('gte', (a, b) => a >= b);
Handlebars.registerHelper('lt', (a, b) => a < b);
Handlebars.registerHelper('lte', (a, b) => a <= b);
Handlebars.registerHelper('and', (...args) => args.slice(0, -1).every(Boolean));
Handlebars.registerHelper('or', (...args) => args.slice(0, -1).some(Boolean));
Handlebars.registerHelper('not', (val) => !val);
Handlebars.registerHelper('uppercase', (str) => (typeof str === 'string' ? str.toUpperCase() : str));
Handlebars.registerHelper('lowercase', (str) => (typeof str === 'string' ? str.toLowerCase() : str));

function sendJsonError(res, statusCode, message, details) {
  res.status(statusCode).json({
    error: message,
    ...(details ? { details } : {}),
  });
}

function isAuthorized(req) {
  const expected = process.env.PDF_API_KEY;
  if (!expected) return false;

  const provided = req.headers['x-api-key'];
  if (typeof provided !== 'string' || provided.length === 0) return false;

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function sanitizeFilename(rawFilename) {
  if (typeof rawFilename !== 'string' || rawFilename.trim().length === 0) {
    return DEFAULT_FILENAME;
  }

  let name = rawFilename.trim();
  // Strip path separators and control characters to prevent header injection
  // and directory traversal in the Content-Disposition header.
  name = name.replace(/[\/\\]/g, '_').replace(/[\x00-\x1f\x7f"]/g, '');

  if (!name.toLowerCase().endsWith('.pdf')) {
    name += '.pdf';
  }

  return name || DEFAULT_FILENAME;
}

function inlineLocalAssets(htmlContent) {
  return htmlContent.replace(/src=["'](\.?\/?(?:assets\/|templates\/|images\/)?[^"']+\.(?:png|jpg|jpeg|svg|gif|webp))["']/gi, (match, imagePath) => {
    if (imagePath.startsWith('data:') || imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
      return match;
    }

    const cleanPath = imagePath.replace(/^\.?\//, '');
    const filename = path.basename(cleanPath);

    const candidatePaths = [
      path.join(process.cwd(), cleanPath),
      path.join(process.cwd(), 'assets', cleanPath),
      path.join(process.cwd(), 'assets', 'images', filename),
      path.join(process.cwd(), 'templates', cleanPath),
      path.join(process.cwd(), 'templates', 'images', filename),
    ];

    for (const candidate of candidatePaths) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const ext = path.extname(candidate).slice(1).toLowerCase();
        const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
        const b64 = fs.readFileSync(candidate).toString('base64');
        return `src="data:${mime};base64,${b64}"`;
      }
    }
    return match;
  });
}

function findTemplate(templateName) {
  if (!templateName || typeof templateName !== 'string') {
    throw new Error('Missing or invalid "template" parameter.');
  }

  const cleanName = path.basename(templateName.trim());
  const candidateNames = [
    cleanName,
    cleanName.toLowerCase().endsWith('.html') ? cleanName : `${cleanName}.html`,
    cleanName.replace(/\.html$/i, ''),
  ];

  const searchDirs = [
    path.join(process.cwd(), 'templates'),
    path.join(process.cwd(), 'assets'),
    path.join(process.cwd(), 'assets', 'templates'),
    process.cwd(),
  ];

  for (const dir of searchDirs) {
    for (const name of candidateNames) {
      const fullPath = path.join(dir, name);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        return fs.readFileSync(fullPath, 'utf-8');
      }
    }
  }

  throw new Error(`Template "${templateName}" not found. Searched in templates/ and assets/`);
}

async function getRawBodyBuffer(req) {
  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === 'string') {
    return Buffer.from(req.body, 'utf-8');
  }
  if (req.body && typeof req.body === 'object') {
    return null;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : null;
}

function parseMultipart(buffer, boundary) {
  const boundaryDelimiter = Buffer.from(`--${boundary}`);
  const result = {};
  let start = 0;

  while (start < buffer.length) {
    const boundaryIdx = buffer.indexOf(boundaryDelimiter, start);
    if (boundaryIdx === -1) break;

    const nextStart = boundaryIdx + boundaryDelimiter.length;
    const headerEndIdx = buffer.indexOf('\r\n\r\n', nextStart);
    if (headerEndIdx === -1) break;

    const headersStr = buffer.subarray(nextStart, headerEndIdx).toString('utf-8');
    const nameMatch = headersStr.match(/name="([^"]+)"/);
    const filenameMatch = headersStr.match(/filename="([^"]+)"/);

    const bodyStart = headerEndIdx + 4;
    const nextBoundaryIdx = buffer.indexOf(boundaryDelimiter, bodyStart);
    if (nextBoundaryIdx === -1) break;

    let bodyEnd = nextBoundaryIdx;
    if (bodyEnd >= 2 && buffer[bodyEnd - 2] === 13 && buffer[bodyEnd - 1] === 10) {
      bodyEnd -= 2;
    }

    const valueBuffer = buffer.subarray(bodyStart, bodyEnd);
    if (nameMatch) {
      const fieldName = nameMatch[1];
      result[fieldName] = valueBuffer.toString('utf-8');
      if (filenameMatch && !result.filename) {
        result.filename = filenameMatch[1];
      }
    }

    start = nextBoundaryIdx;
  }
  return result;
}

async function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  const contentType = req.headers['content-type'] || '';
  const rawBuffer = await getRawBodyBuffer(req);
  if (!rawBuffer || rawBuffer.length === 0) {
    return {};
  }

  if (contentType.includes('multipart/form-data')) {
    const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1].trim().replace(/^["']|["']$/g, '');
      return parseMultipart(rawBuffer, boundary);
    }
  }

  const text = rawBuffer.toString('utf-8').trim();
  if (text.length > 0) {
    try {
      return JSON.parse(text);
    } catch {
      if (text.startsWith('<') || contentType.includes('text/html')) {
        return { type: 'html', html: text };
      }
      throw new Error('Invalid JSON or request payload.');
    }
  }

  return {};
}

function resolveRenderPayload(body) {
  const type = (body.type || (body.template ? 'html_file' : body.url ? 'url' : body.file ? 'file' : 'html')).toLowerCase();

  // 1. Template from server file system: type: "html_file" or "template"
  if (type === 'html_file' || type === 'template') {
    const templateName = body.template || body.file || body.name;
    if (!templateName) {
      throw new Error('Missing "template" field in request body for type "html_file".');
    }

    const rawTemplate = findTemplate(templateName);
    const inlinedTemplate = inlineLocalAssets(rawTemplate);

    let renderedHtml;
    if (body.data && typeof body.data === 'object') {
      const compiled = Handlebars.compile(inlinedTemplate);
      renderedHtml = compiled(body.data);
    } else {
      renderedHtml = inlinedTemplate;
    }

    return { mode: 'html', source: renderedHtml };
  }

  // 2. Direct Web Page URL: type: "url"
  if (type === 'url') {
    const url = body.url || body.link || body.html;
    if (!url || typeof url !== 'string' || !url.trim().startsWith('http')) {
      throw new Error('Missing or invalid "url" parameter. Must be a valid HTTP or HTTPS URL.');
    }
    return { mode: 'url', source: url.trim() };
  }

  // 3. User-Provided File Payload: type: "file"
  if (type === 'file') {
    const rawFile = body.file || body.data || body.content || body.html;
    if (!rawFile || typeof rawFile !== 'string' || rawFile.trim().length === 0) {
      throw new Error('Missing or empty "file" parameter for type "file".');
    }

    let trimmed = rawFile.trim();
    if (trimmed.startsWith('data:')) {
      const commaIdx = trimmed.indexOf(',');
      if (commaIdx !== -1) {
        trimmed = trimmed.slice(commaIdx + 1).trim();
      }
    }

    let decodedHtml;
    try {
      const buffer = Buffer.from(trimmed, 'base64');
      const isBase64 = !trimmed.includes('<') && buffer.toString('base64').replace(/=/g, '') === trimmed.replace(/[\s=]/g, '');
      if (isBase64) {
        decodedHtml = buffer.toString('utf-8');
      } else {
        decodedHtml = trimmed;
      }
    } catch {
      decodedHtml = trimmed;
    }

    if (!decodedHtml || decodedHtml.trim().length === 0) {
      throw new Error('Could not extract valid HTML content from the provided file.');
    }

    let finalHtml = inlineLocalAssets(decodedHtml);
    if (body.data && typeof body.data === 'object') {
      const compiled = Handlebars.compile(finalHtml);
      finalHtml = compiled(body.data);
    }

    return { mode: 'html', source: finalHtml };
  }

  // 4. Raw HTML String: type: "html" (default)
  const html = body.html || body.content || body.file;
  if (!html || typeof html !== 'string' || html.trim().length === 0) {
    throw new Error('Missing or empty "html" field in request body.');
  }

  let finalHtml = inlineLocalAssets(html);
  if (body.data && typeof body.data === 'object') {
    const compiled = Handlebars.compile(finalHtml);
    finalHtml = compiled(body.data);
  }

  return { mode: 'html', source: finalHtml };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJsonError(res, 405, 'Method not allowed. Use POST.');
  }

  if (!process.env.PDF_API_KEY) {
    return sendJsonError(res, 500, 'Server misconfigured: PDF_API_KEY is not set.');
  }

  if (!isAuthorized(req)) {
    return sendJsonError(res, 401, 'Unauthorized: missing or invalid X-API-Key header.');
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    return sendJsonError(res, 400, 'Invalid request body.', err.message);
  }

  let renderTarget;
  try {
    renderTarget = resolveRenderPayload(body);
  } catch (err) {
    return sendJsonError(res, 400, err.message);
  }

  const { filename, options = {} } = body;
  const safeFilename = sanitizeFilename(filename);

  let browser;
  try {
    try {
      browser = await puppeteer.launch({
        args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
        defaultViewport: { width: 1920, height: 1080 },
        executablePath: await chromium.executablePath(),
        headless: 'shell',
      });
    } catch (err) {
      console.error('Chromium launch failed:', err);
      return sendJsonError(res, 500, 'Failed to launch PDF renderer.', err.message);
    }

    let pdfBuffer;
    try {
      const page = await browser.newPage();

      if (renderTarget.mode === 'url') {
        await page.goto(renderTarget.source, { waitUntil: 'networkidle0', timeout: 30000 });
      } else {
        await page.setContent(renderTarget.source, { waitUntil: 'networkidle0', timeout: 30000 });
      }

      await page.emulateMediaType('print');

      pdfBuffer = await page.pdf({
        format: options.format || 'A4',
        landscape: Boolean(options.landscape),
        printBackground: options.printBackground !== undefined ? options.printBackground : true,
        scale: typeof options.scale === 'number' ? options.scale : 1,
        margin: options.margin || {
          top: '20mm',
          bottom: '20mm',
          left: '15mm',
          right: '15mm',
        },
      });
    } catch (err) {
      console.error('PDF rendering failed:', err);
      return sendJsonError(res, 500, 'Failed to render PDF.', err.message);
    }

    const binaryData = Buffer.from(pdfBuffer);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Content-Length', binaryData.length);
    return res.status(200).send(binaryData);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        console.error('Failed to close browser:', err);
      }
    }
  }
}
