import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

// Pure PDF/screenshot workloads don't need WebGL; disabling it speeds up cold starts.
chromium.setGraphicsMode = false;

const DEFAULT_FILENAME = 'document.pdf';

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

function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (Buffer.isBuffer(req.body)) {
    const text = req.body.toString('utf-8');
    return text.trim() ? JSON.parse(text) : {};
  }
  if (typeof req.body === 'string' && req.body.trim().length > 0) {
    return JSON.parse(req.body);
  }
  return {};
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
    body = parseBody(req);
  } catch (err) {
    return sendJsonError(res, 400, 'Invalid JSON body.', err.message);
  }

  const { html, filename, options = {} } = body;

  if (typeof html !== 'string' || html.trim().length === 0) {
    return sendJsonError(res, 400, 'Missing or empty "html" field in request body.');
  }

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
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
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
      return sendJsonError(res, 500, 'Failed to render HTML to PDF.', err.message);
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
