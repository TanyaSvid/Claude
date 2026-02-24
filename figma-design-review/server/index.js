const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3742;

// Allow large payloads (Figma frames can be big)
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// Reuse browser instance
let browser = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }
  return browser;
}

// ─── Main comparison endpoint ───
app.post('/compare', async (req, res) => {
  const {
    url,
    figmaImage,       // base64 PNG from Figma
    viewport,         // { width, height }
    scale = 2,
    threshold = 0.1,
    includeAA = true,
    delay = 1000,
    hideSelectors,     // CSS selectors to hide before screenshot
    fullPage = true,
  } = req.body;

  if (!url || !figmaImage) {
    return res.status(400).json({ error: 'Missing required fields: url, figmaImage' });
  }

  try {
    // 1. Take screenshot of the live site
    const screenshotBuffer = await takeScreenshot({
      url,
      width: viewport?.width || 1440,
      height: viewport?.height || 900,
      scale,
      delay,
      hideSelectors,
      fullPage,
    });

    // 2. Decode Figma image
    const figmaBuffer = Buffer.from(figmaImage, 'base64');

    // 3. Normalize both images to same dimensions for comparison
    const { figmaPng, screenshotPng, normalizedWidth, normalizedHeight } =
      await normalizeImages(figmaBuffer, screenshotBuffer);

    // 4. Run pixelmatch
    const diffPng = new PNG({ width: normalizedWidth, height: normalizedHeight });

    const mismatchedPixels = pixelmatch(
      figmaPng.data,
      screenshotPng.data,
      diffPng.data,
      normalizedWidth,
      normalizedHeight,
      {
        threshold: threshold,
        includeAA: includeAA,
        alpha: 0.3,
        diffColor: [255, 72, 34],       // Red for differences
        diffColorAlt: [255, 184, 0],    // Orange for anti-aliased diffs
      }
    );

    const totalPixels = normalizedWidth * normalizedHeight;
    const matchPercent = ((totalPixels - mismatchedPixels) / totalPixels) * 100;

    // 5. Encode results
    const diffBuffer = PNG.sync.write(diffPng);
    const diffBase64 = diffBuffer.toString('base64');
    const screenshotBase64 = screenshotBuffer.toString('base64');

    // Get original dimensions for info
    const figmaMeta = await sharp(figmaBuffer).metadata();
    const screenshotMeta = await sharp(screenshotBuffer).metadata();

    res.json({
      matchPercent: Math.round(matchPercent * 10) / 10,
      mismatchedPixels,
      totalPixels,
      screenshot: screenshotBase64,
      diff: diffBase64,
      dimensions: {
        figma: { width: figmaMeta.width, height: figmaMeta.height },
        screenshot: { width: screenshotMeta.width, height: screenshotMeta.height },
        compared: { width: normalizedWidth, height: normalizedHeight },
      },
    });
  } catch (err) {
    console.error('Comparison error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Screenshot only endpoint ───
app.post('/screenshot', async (req, res) => {
  const { url, width = 1440, height = 900, scale = 2, delay = 1000, hideSelectors, fullPage = true } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Missing required field: url' });
  }

  try {
    const buffer = await takeScreenshot({ url, width, height, scale, delay, hideSelectors, fullPage });
    res.json({ screenshot: buffer.toString('base64') });
  } catch (err) {
    console.error('Screenshot error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ───
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// ─── Take screenshot with Puppeteer ───
async function takeScreenshot({ url, width, height, scale, delay, hideSelectors, fullPage }) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Set viewport
    await page.setViewport({
      width: width,
      height: height,
      deviceScaleFactor: scale,
    });

    // Navigate
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Wait additional delay for animations/lazy-loaded content
    if (delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }

    // Hide elements if specified (cookie banners, chat widgets, etc.)
    if (hideSelectors) {
      const selectors = hideSelectors.split(',').map(s => s.trim()).filter(Boolean);
      for (const selector of selectors) {
        await page.evaluate((sel) => {
          document.querySelectorAll(sel).forEach(el => {
            el.style.display = 'none';
          });
        }, selector);
      }
    }

    // Take screenshot
    const screenshotBuffer = await page.screenshot({
      type: 'png',
      fullPage: fullPage,
    });

    return Buffer.from(screenshotBuffer);
  } finally {
    await page.close();
  }
}

// ─── Normalize images to same dimensions ───
async function normalizeImages(figmaBuffer, screenshotBuffer) {
  const figmaMeta = await sharp(figmaBuffer).metadata();
  const screenshotMeta = await sharp(screenshotBuffer).metadata();

  // Use the smaller dimensions to crop/compare
  // Usually the width should match (same viewport), height may differ
  const targetWidth = Math.min(figmaMeta.width, screenshotMeta.width);
  const targetHeight = Math.min(figmaMeta.height, screenshotMeta.height);

  // Resize/crop both images to same dimensions
  const figmaResized = await sharp(figmaBuffer)
    .resize(targetWidth, targetHeight, {
      fit: 'cover',
      position: 'top',
    })
    .png()
    .toBuffer();

  const screenshotResized = await sharp(screenshotBuffer)
    .resize(targetWidth, targetHeight, {
      fit: 'cover',
      position: 'top',
    })
    .png()
    .toBuffer();

  // Decode to PNG for pixelmatch
  const figmaPng = PNG.sync.read(figmaResized);
  const screenshotPng = PNG.sync.read(screenshotResized);

  return {
    figmaPng,
    screenshotPng,
    normalizedWidth: targetWidth,
    normalizedHeight: targetHeight,
  };
}

// ─── Start server ───
app.listen(PORT, () => {
  console.log(`\n  Design Review Server running on http://localhost:${PORT}`);
  console.log(`  ─────────────────────────────────────────────────`);
  console.log(`  POST /compare     — Compare Figma frame with live site`);
  console.log(`  POST /screenshot  — Take screenshot only`);
  console.log(`  GET  /health      — Health check\n`);
});

// Cleanup on exit
process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
