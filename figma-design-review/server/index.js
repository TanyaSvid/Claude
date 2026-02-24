const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3742;

app.use(express.json({ limit: '50mb' }));
app.use(cors());

let browser = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
        ],
        timeout: 30000,
      });
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('WS endpoint') || msg.includes('ENOENT') || msg.includes('spawn')) {
        throw new Error(
          'Could not launch browser. Chromium may not be installed.\n' +
          'Run this command to fix it:\n' +
          '  npx puppeteer browsers install chrome\n' +
          'Or on Mac: brew install --cask chromium'
        );
      }
      throw err;
    }
  }
  return browser;
}

// ═══════════════════════════════════════════
//  POST /compare  — pixel comparison
// ═══════════════════════════════════════════
app.post('/compare', async (req, res) => {
  const {
    url, figmaImage, viewport, scale = 2,
    threshold = 0.1, includeAA = true,
    delay = 1000, hideSelectors, fullPage = true,
  } = req.body;

  if (!url || !figmaImage) {
    return res.status(400).json({ error: 'Missing required fields: url, figmaImage' });
  }

  try {
    const screenshotBuffer = await takeScreenshot({
      url,
      width: viewport?.width || 1440,
      height: viewport?.height || 900,
      scale, delay, hideSelectors, fullPage,
    });

    const figmaBuffer = Buffer.from(figmaImage, 'base64');
    const { figmaPng, screenshotPng, normalizedWidth, normalizedHeight } =
      await normalizeImages(figmaBuffer, screenshotBuffer);

    const diffPng = new PNG({ width: normalizedWidth, height: normalizedHeight });
    const mismatchedPixels = pixelmatch(
      figmaPng.data, screenshotPng.data, diffPng.data,
      normalizedWidth, normalizedHeight,
      {
        threshold, includeAA, alpha: 0.3,
        diffColor: [255, 72, 34],
        diffColorAlt: [255, 184, 0],
      }
    );

    const totalPixels = normalizedWidth * normalizedHeight;
    const matchPercent = ((totalPixels - mismatchedPixels) / totalPixels) * 100;

    const diffBuffer = PNG.sync.write(diffPng);
    const figmaMeta = await sharp(figmaBuffer).metadata();
    const screenshotMeta = await sharp(screenshotBuffer).metadata();

    res.json({
      matchPercent: Math.round(matchPercent * 10) / 10,
      mismatchedPixels,
      totalPixels,
      screenshot: screenshotBuffer.toString('base64'),
      diff: diffBuffer.toString('base64'),
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

// ═══════════════════════════════════════════
//  POST /review  — full design review
//  Pixel diff + CSS extraction + report
// ═══════════════════════════════════════════
app.post('/review', async (req, res) => {
  const {
    url, figmaImage, viewport, scale = 2,
    threshold = 0.1, includeAA = true,
    delay = 1000, hideSelectors, fullPage = true,
    designData,    // Figma design tree from plugin
    states,        // [{ name, scroll?, click?, url?, waitFor? }]
  } = req.body;

  if (!url || !figmaImage) {
    return res.status(400).json({ error: 'Missing required fields: url, figmaImage' });
  }

  try {
    const br = await getBrowser();
    const page = await br.newPage();
    const vw = viewport?.width || 1440;
    const vh = viewport?.height || 900;

    await page.setViewport({ width: vw, height: vh, deviceScaleFactor: scale });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    if (delay > 0) await sleep(delay);

    if (hideSelectors) {
      await hideElements(page, hideSelectors);
    }

    // 1. Screenshot default state
    const screenshotBuffer = Buffer.from(await page.screenshot({ type: 'png', fullPage }));

    // 2. Extract CSS from live site
    const siteCSS = await extractSiteCSS(page);

    // 3. Multi-state screenshots
    const stateResults = [];
    if (states && states.length > 0) {
      for (const st of states) {
        try {
          const stateShot = await captureState(page, st, scale, fullPage);
          stateResults.push({ name: st.name, screenshot: stateShot.toString('base64'), ok: true });
        } catch (err) {
          stateResults.push({ name: st.name, ok: false, error: err.message });
        }
      }
    }

    await page.close();

    // 4. Pixel comparison
    const figmaBuffer = Buffer.from(figmaImage, 'base64');
    const { figmaPng, screenshotPng, normalizedWidth, normalizedHeight } =
      await normalizeImages(figmaBuffer, screenshotBuffer);

    const diffPng = new PNG({ width: normalizedWidth, height: normalizedHeight });
    const mismatchedPixels = pixelmatch(
      figmaPng.data, screenshotPng.data, diffPng.data,
      normalizedWidth, normalizedHeight,
      { threshold, includeAA, alpha: 0.3, diffColor: [255, 72, 34], diffColorAlt: [255, 184, 0] }
    );

    const totalPixels = normalizedWidth * normalizedHeight;
    const matchPercent = ((totalPixels - mismatchedPixels) / totalPixels) * 100;
    const diffBuffer = PNG.sync.write(diffPng);

    // 5. Generate report: compare Figma design tokens vs live CSS
    const report = generateReport(designData, siteCSS, matchPercent);

    res.json({
      matchPercent: Math.round(matchPercent * 10) / 10,
      mismatchedPixels,
      totalPixels,
      screenshot: screenshotBuffer.toString('base64'),
      diff: diffBuffer.toString('base64'),
      siteCSS,
      report,
      states: stateResults,
    });
  } catch (err) {
    console.error('Review error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
//  POST /screenshot  — screenshot only
// ═══════════════════════════════════════════
app.post('/screenshot', async (req, res) => {
  const { url, width = 1440, height = 900, scale = 2, delay = 1000, hideSelectors, fullPage = true } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  try {
    const buffer = await takeScreenshot({ url, width, height, scale, delay, hideSelectors, fullPage });
    res.json({ screenshot: buffer.toString('base64') });
  } catch (err) {
    console.error('Screenshot error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════
//  GET /health
// ═══════════════════════════════════════════
app.get('/health', async (req, res) => {
  try {
    await getBrowser();
    res.json({ status: 'ok', version: '2.0.0', browser: 'ready' });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});


// ─────────────────────────────────────────
//  SCREENSHOT
// ─────────────────────────────────────────
async function takeScreenshot({ url, width, height, scale, delay, hideSelectors, fullPage }) {
  const br = await getBrowser();
  const page = await br.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: scale });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    if (delay > 0) await sleep(delay);
    if (hideSelectors) await hideElements(page, hideSelectors);
    return Buffer.from(await page.screenshot({ type: 'png', fullPage }));
  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────
//  CSS EXTRACTION from live site
// ─────────────────────────────────────────
async function extractSiteCSS(page) {
  return await page.evaluate(() => {
    const results = [];

    // Extract all visible, meaningful elements
    const allElements = document.querySelectorAll('body *');

    for (const el of allElements) {
      // Skip invisible/script/style elements
      if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'br', 'wbr', 'meta', 'link'].includes(tag)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const cs = window.getComputedStyle(el);

      const info = {
        tag,
        selector: buildSelector(el),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };

      // Text nodes
      const isText = ['h1','h2','h3','h4','h5','h6','p','span','a','li','td','th','label','button','input','textarea','blockquote','figcaption','dt','dd'].includes(tag);
      if (isText || el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
        const text = el.textContent.trim();
        if (text) {
          info.text = text.slice(0, 200);
          info.font = {
            family: cs.fontFamily.split(',')[0].trim().replace(/['"]/g, ''),
            size: cs.fontSize,
            weight: cs.fontWeight,
            lineHeight: cs.lineHeight,
            letterSpacing: cs.letterSpacing !== 'normal' ? cs.letterSpacing : undefined,
            color: cs.color,
            textAlign: cs.textAlign,
            textDecoration: cs.textDecorationLine !== 'none' ? cs.textDecorationLine : undefined,
            textTransform: cs.textTransform !== 'none' ? cs.textTransform : undefined,
          };
        }
      }

      // Spacing
      const mt = px(cs.marginTop), mr = px(cs.marginRight), mb = px(cs.marginBottom), ml = px(cs.marginLeft);
      const pt = px(cs.paddingTop), pr = px(cs.paddingRight), pb = px(cs.paddingBottom), pl = px(cs.paddingLeft);

      if (mt || mr || mb || ml) {
        info.margin = { top: mt, right: mr, bottom: mb, left: ml };
      }
      if (pt || pr || pb || pl) {
        info.padding = { top: pt, right: pr, bottom: pb, left: pl };
      }

      // Gap (flexbox/grid)
      if (cs.display === 'flex' || cs.display === 'inline-flex' || cs.display === 'grid' || cs.display === 'inline-grid') {
        info.display = cs.display;
        info.flexDirection = cs.flexDirection;
        info.alignItems = cs.alignItems;
        info.justifyContent = cs.justifyContent;
        const gap = cs.gap;
        if (gap && gap !== 'normal' && gap !== '0px') info.gap = gap;
      }

      // Background
      const bg = cs.backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        info.backgroundColor = bg;
      }
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        info.hasBackgroundImage = true;
      }

      // Borders
      const bw = px(cs.borderTopWidth) || px(cs.borderRightWidth) || px(cs.borderBottomWidth) || px(cs.borderLeftWidth);
      if (bw) {
        info.border = {
          width: cs.borderWidth,
          style: cs.borderStyle,
          color: cs.borderColor,
        };
      }

      // Border radius
      const br = cs.borderRadius;
      if (br && br !== '0px') info.borderRadius = br;

      // Box shadow
      if (cs.boxShadow && cs.boxShadow !== 'none') {
        info.boxShadow = cs.boxShadow;
      }

      // Opacity
      if (cs.opacity !== '1') info.opacity = cs.opacity;

      // Overflow
      if (cs.overflow !== 'visible') info.overflow = cs.overflow;

      // Images
      if (tag === 'img') {
        info.isImage = true;
        info.src = el.src;
        info.naturalWidth = el.naturalWidth;
        info.naturalHeight = el.naturalHeight;
        info.objectFit = cs.objectFit;
      }

      // SVG / icons
      if (tag === 'svg') {
        info.isSVG = true;
      }

      results.push(info);
    }

    return results;

    function px(val) {
      const n = parseFloat(val);
      return isNaN(n) ? 0 : Math.round(n);
    }

    function buildSelector(el) {
      const parts = [];
      let current = el;
      let depth = 0;
      while (current && current !== document.body && depth < 4) {
        let part = current.tagName.toLowerCase();
        if (current.id) {
          part += '#' + current.id;
          parts.unshift(part);
          break;
        }
        if (current.className && typeof current.className === 'string') {
          const cls = current.className.trim().split(/\s+/).slice(0, 2).join('.');
          if (cls) part += '.' + cls;
        }
        parts.unshift(part);
        current = current.parentElement;
        depth++;
      }
      return parts.join(' > ');
    }
  });
}

// ─────────────────────────────────────────
//  MULTI-STATE CAPTURE
// ─────────────────────────────────────────
async function captureState(page, stateConfig, scale, fullPage) {
  // Navigate to different URL if specified
  if (stateConfig.url) {
    await page.goto(stateConfig.url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(500);
  }

  // Scroll to position
  if (stateConfig.scroll !== undefined) {
    await page.evaluate((y) => window.scrollTo(0, y), stateConfig.scroll);
    await sleep(300);
  }

  // Click element (for dropdowns, menus, filters)
  if (stateConfig.click) {
    try {
      await page.click(stateConfig.click);
      await sleep(stateConfig.clickWait || 500);
    } catch (e) {
      // Element not found — continue
    }
  }

  // Hover element
  if (stateConfig.hover) {
    try {
      await page.hover(stateConfig.hover);
      await sleep(300);
    } catch (e) {
      // Element not found — continue
    }
  }

  // Wait for selector
  if (stateConfig.waitFor) {
    try {
      await page.waitForSelector(stateConfig.waitFor, { timeout: 5000 });
    } catch (e) {
      // Timeout — continue
    }
  }

  // Additional delay
  if (stateConfig.delay) {
    await sleep(stateConfig.delay);
  }

  return Buffer.from(await page.screenshot({ type: 'png', fullPage }));
}

// ─────────────────────────────────────────
//  REPORT GENERATION
// ─────────────────────────────────────────
function generateReport(designData, siteCSS, matchPercent) {
  if (!designData || !siteCSS || siteCSS.length === 0) {
    return {
      summary: `Pixel match: ${Math.round(matchPercent * 10) / 10}%. No design data provided for detailed comparison.`,
      issues: [],
    };
  }

  const issues = [];

  // Collect all Figma text nodes
  const figmaTexts = [];
  walkDesignTree(designData, (node) => {
    if (node.text) figmaTexts.push(node);
  });

  // Collect all site text elements
  const siteTexts = siteCSS.filter(el => el.font);

  // Match by text content and compare properties
  for (const figmaNode of figmaTexts) {
    const figmaStr = figmaNode.text.characters.trim().toLowerCase().slice(0, 100);
    if (!figmaStr) continue;

    // Find matching site element
    const siteMatch = siteTexts.find(el => {
      const siteStr = (el.text || '').trim().toLowerCase().slice(0, 100);
      return siteStr === figmaStr || siteStr.includes(figmaStr) || figmaStr.includes(siteStr);
    });

    if (!siteMatch) continue;

    const nodeIssues = compareTextNode(figmaNode, siteMatch);
    issues.push(...nodeIssues);
  }

  // Compare layout containers (Figma auto-layout vs site flex/grid)
  const figmaLayouts = [];
  walkDesignTree(designData, (node) => {
    if (node.layout) figmaLayouts.push(node);
  });

  // Check for general spacing issues
  const siteContainers = siteCSS.filter(el => el.display && (el.display.includes('flex') || el.display.includes('grid')));

  for (const figmaLayout of figmaLayouts) {
    // Try to match by position overlap
    const candidates = siteContainers.filter(el => {
      return rectsOverlap(
        { x: figmaLayout.x, y: figmaLayout.y, w: figmaLayout.width, h: figmaLayout.height },
        { x: el.rect.x, y: el.rect.y, w: el.rect.width, h: el.rect.height }
      );
    });

    if (candidates.length === 0) continue;
    const siteEl = candidates[0];

    // Compare gap
    if (figmaLayout.layout.gap > 0 && siteEl.gap) {
      const siteGap = parseFloat(siteEl.gap);
      if (!isNaN(siteGap) && Math.abs(figmaLayout.layout.gap - siteGap) > 1) {
        issues.push({
          type: 'spacing',
          severity: 'warning',
          element: siteEl.selector,
          property: 'gap',
          expected: `${figmaLayout.layout.gap}px`,
          actual: siteEl.gap,
          message: `Gap: expected ${figmaLayout.layout.gap}px (Figma), got ${siteEl.gap} on site`,
        });
      }
    }

    // Compare padding
    const lp = figmaLayout.layout;
    if (siteEl.padding) {
      compareSides('padding', lp, siteEl.padding, siteEl.selector, issues);
    }
  }

  // Check images — look for missing or wrongly sized images
  const siteImages = siteCSS.filter(el => el.isImage);
  const figmaImages = [];
  walkDesignTree(designData, (node) => {
    if (node.hasImage) figmaImages.push(node);
  });

  if (figmaImages.length > 0 && siteImages.length > 0) {
    // Check aspect ratio / sizing issues
    for (const siteImg of siteImages) {
      if (siteImg.naturalWidth && siteImg.rect.width) {
        const displayW = siteImg.rect.width;
        const displayH = siteImg.rect.height;
        const natW = siteImg.naturalWidth;
        const natH = siteImg.naturalHeight;

        // Check if image is stretched/squished
        const displayRatio = displayW / displayH;
        const naturalRatio = natW / natH;
        if (Math.abs(displayRatio - naturalRatio) > 0.1 && siteImg.objectFit !== 'cover' && siteImg.objectFit !== 'contain') {
          issues.push({
            type: 'image',
            severity: 'error',
            element: siteImg.selector,
            property: 'aspect-ratio',
            message: `Image may be distorted: natural ${natW}x${natH} (${naturalRatio.toFixed(2)}), displayed ${displayW}x${displayH} (${displayRatio.toFixed(2)}). Consider object-fit: cover.`,
          });
        }
      }
    }
  }

  // Sort: errors first, then warnings
  issues.sort((a, b) => {
    const sev = { error: 0, warning: 1, info: 2 };
    return (sev[a.severity] || 2) - (sev[b.severity] || 2);
  });

  // Build summary
  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;

  return {
    summary: `Pixel match: ${Math.round(matchPercent * 10) / 10}% | Found ${issues.length} issues (${errors} errors, ${warnings} warnings)`,
    issues,
    stats: {
      matchPercent: Math.round(matchPercent * 10) / 10,
      totalIssues: issues.length,
      errors,
      warnings,
      textsCompared: figmaTexts.length,
      layoutsCompared: figmaLayouts.length,
      imagesChecked: siteImages.length,
    },
  };
}

function compareTextNode(figmaNode, siteEl) {
  const issues = [];
  const ft = figmaNode.text;
  const sf = siteEl.font;

  // Font size
  if (ft.fontSize && sf.size) {
    const sitePx = parseFloat(sf.size);
    if (!isNaN(sitePx) && Math.abs(ft.fontSize - sitePx) > 0.5) {
      issues.push({
        type: 'typography',
        severity: Math.abs(ft.fontSize - sitePx) > 2 ? 'error' : 'warning',
        element: siteEl.selector,
        text: (siteEl.text || '').slice(0, 60),
        property: 'font-size',
        expected: `${ft.fontSize}px`,
        actual: sf.size,
        message: `Font size: expected ${ft.fontSize}px (Figma), got ${sf.size}`,
      });
    }
  }

  // Font weight
  if (ft.fontWeight && sf.weight) {
    const siteWeight = parseInt(sf.weight);
    if (!isNaN(siteWeight) && Math.abs(ft.fontWeight - siteWeight) >= 100) {
      issues.push({
        type: 'typography',
        severity: 'warning',
        element: siteEl.selector,
        text: (siteEl.text || '').slice(0, 60),
        property: 'font-weight',
        expected: String(ft.fontWeight),
        actual: sf.weight,
        message: `Font weight: expected ${ft.fontWeight} (Figma), got ${sf.weight}`,
      });
    }
  }

  // Line height
  if (ft.lineHeight && ft.lineHeight.unit === 'PIXELS' && sf.lineHeight) {
    const siteLineHeight = parseFloat(sf.lineHeight);
    if (!isNaN(siteLineHeight) && Math.abs(ft.lineHeight.value - siteLineHeight) > 1) {
      issues.push({
        type: 'typography',
        severity: 'warning',
        element: siteEl.selector,
        text: (siteEl.text || '').slice(0, 60),
        property: 'line-height',
        expected: `${ft.lineHeight.value}px`,
        actual: sf.lineHeight,
        message: `Line-height: expected ${ft.lineHeight.value}px (Figma), got ${sf.lineHeight}`,
      });
    }
  }

  // Letter spacing
  if (ft.letterSpacing && ft.letterSpacing.value !== 0 && sf.letterSpacing) {
    const siteLs = parseFloat(sf.letterSpacing);
    if (!isNaN(siteLs)) {
      const figmaLs = ft.letterSpacing.unit === 'PERCENT'
        ? (ft.letterSpacing.value / 100) * (ft.fontSize || 16)
        : ft.letterSpacing.value;
      if (Math.abs(figmaLs - siteLs) > 0.3) {
        issues.push({
          type: 'typography',
          severity: 'info',
          element: siteEl.selector,
          text: (siteEl.text || '').slice(0, 60),
          property: 'letter-spacing',
          expected: `${figmaLs.toFixed(1)}px`,
          actual: sf.letterSpacing,
          message: `Letter-spacing: expected ~${figmaLs.toFixed(1)}px (Figma), got ${sf.letterSpacing}`,
        });
      }
    }
  }

  // Text alignment
  if (ft.textAlign && sf.textAlign) {
    const figmaAlign = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }[ft.textAlign];
    if (figmaAlign && figmaAlign !== sf.textAlign) {
      issues.push({
        type: 'typography',
        severity: 'warning',
        element: siteEl.selector,
        text: (siteEl.text || '').slice(0, 60),
        property: 'text-align',
        expected: figmaAlign,
        actual: sf.textAlign,
        message: `Text align: expected ${figmaAlign} (Figma), got ${sf.textAlign}`,
      });
    }
  }

  // Color
  if (figmaNode.fills && figmaNode.fills.length > 0 && sf.color) {
    const figmaFill = figmaNode.fills[0];
    if (figmaFill.color && figmaFill.color.startsWith('#')) {
      const figmaRgb = hexToRgb(figmaFill.color);
      const siteRgb = parseRgb(sf.color);
      if (figmaRgb && siteRgb) {
        const diff = colorDiff(figmaRgb, siteRgb);
        if (diff > 10) {
          issues.push({
            type: 'color',
            severity: diff > 30 ? 'error' : 'warning',
            element: siteEl.selector,
            text: (siteEl.text || '').slice(0, 60),
            property: 'color',
            expected: figmaFill.color,
            actual: sf.color,
            message: `Text color: expected ${figmaFill.color} (Figma), got ${sf.color}`,
          });
        }
      }
    }
  }

  return issues;
}

function compareSides(propName, figmaLayout, siteSides, selector, issues) {
  const map = {
    padding: {
      top: 'paddingTop',
      right: 'paddingRight',
      bottom: 'paddingBottom',
      left: 'paddingLeft',
    },
  };
  const keys = map[propName];
  if (!keys) return;

  for (const [side, figmaKey] of Object.entries(keys)) {
    const figmaVal = figmaLayout[figmaKey] || 0;
    const siteVal = siteSides[side] || 0;
    if (Math.abs(figmaVal - siteVal) > 1) {
      issues.push({
        type: 'spacing',
        severity: Math.abs(figmaVal - siteVal) > 8 ? 'error' : 'warning',
        element: selector,
        property: `${propName}-${side}`,
        expected: `${figmaVal}px`,
        actual: `${siteVal}px`,
        message: `${propName}-${side}: expected ${figmaVal}px (Figma), got ${siteVal}px`,
      });
    }
  }
}

// ─── Helpers ───
function walkDesignTree(node, fn) {
  if (!node) return;
  fn(node);
  if (node.children) {
    for (const child of node.children) {
      walkDesignTree(child, fn);
    }
  }
}

function rectsOverlap(a, b) {
  const tolerance = 20;
  return !(a.x + a.w + tolerance < b.x || b.x + b.w + tolerance < a.x ||
           a.y + a.h + tolerance < b.y || b.y + b.h + tolerance < a.y);
}

function hexToRgb(hex) {
  const m = hex.match(/^#([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function parseRgb(str) {
  const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) };
}

function colorDiff(a, b) {
  return Math.sqrt(Math.pow(a.r - b.r, 2) + Math.pow(a.g - b.g, 2) + Math.pow(a.b - b.b, 2));
}

async function normalizeImages(figmaBuffer, screenshotBuffer) {
  const figmaMeta = await sharp(figmaBuffer).metadata();
  const screenshotMeta = await sharp(screenshotBuffer).metadata();

  const targetWidth = Math.min(figmaMeta.width, screenshotMeta.width);
  const targetHeight = Math.min(figmaMeta.height, screenshotMeta.height);

  const figmaResized = await sharp(figmaBuffer)
    .resize(targetWidth, targetHeight, { fit: 'cover', position: 'top' })
    .png().toBuffer();

  const screenshotResized = await sharp(screenshotBuffer)
    .resize(targetWidth, targetHeight, { fit: 'cover', position: 'top' })
    .png().toBuffer();

  return {
    figmaPng: PNG.sync.read(figmaResized),
    screenshotPng: PNG.sync.read(screenshotResized),
    normalizedWidth: targetWidth,
    normalizedHeight: targetHeight,
  };
}

async function hideElements(page, selectors) {
  const list = selectors.split(',').map(s => s.trim()).filter(Boolean);
  for (const sel of list) {
    await page.evaluate((s) => {
      document.querySelectorAll(s).forEach(el => { el.style.display = 'none'; });
    }, sel);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Start ───
app.listen(PORT, async () => {
  console.log(`\n  Design Review Server v2.0 — http://localhost:${PORT}`);
  console.log(`  ────────────────────────────────────────────────────`);
  console.log(`  POST /compare     — Pixel comparison only`);
  console.log(`  POST /review      — Full review (pixel + CSS + report)`);
  console.log(`  POST /screenshot  — Screenshot only`);
  console.log(`  GET  /health      — Health check\n`);

  // Pre-launch browser to catch errors early
  try {
    console.log('  Launching browser...');
    await getBrowser();
    console.log('  Browser ready!\n');
  } catch (err) {
    console.error('\n  ERROR: ' + err.message + '\n');
  }
});

process.on('SIGINT', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
