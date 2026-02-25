// ─────────────────────────────────────────
//  Live Site CSS/DOM Extractor
//  Uses Puppeteer to extract real styles
// ─────────────────────────────────────────

import puppeteer from 'puppeteer';

let browser = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-extensions',
      ],
      timeout: 30000,
    });
  }
  return browser;
}

export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/**
 * Extract all visible elements with their computed styles from a live URL
 */
export async function extractSiteElements(url, options = {}) {
  const {
    width = 1440,
    height = 900,
    delay = 2000,
    dismissPopups: shouldDismiss = true,
  } = options;

  const br = await getBrowser();
  const page = await br.newPage();

  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    if (delay > 0) await sleep(delay);
    if (shouldDismiss) await dismissPopups(page);

    const elements = await page.evaluate(() => {
      const results = [];
      const allElements = document.querySelectorAll('body *');

      for (const el of allElements) {
        if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
        const tag = el.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'br', 'wbr', 'meta', 'link', 'svg', 'path'].includes(tag)) continue;

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

        // ── Text ──
        const textTags = ['h1','h2','h3','h4','h5','h6','p','span','a','li','td','th',
          'label','button','input','textarea','blockquote','figcaption','dt','dd','small','strong','em','b','i'];
        const isTextEl = textTags.includes(tag) || (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3);

        if (isTextEl) {
          const text = el.textContent?.trim();
          if (text) {
            info.text = text.slice(0, 300);
            info.font = {
              family: cs.fontFamily.split(',')[0].trim().replace(/['"]/g, ''),
              size: parseFloat(cs.fontSize),
              weight: parseInt(cs.fontWeight),
              lineHeight: cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight),
              letterSpacing: cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing),
              textAlign: cs.textAlign,
              textDecoration: cs.textDecorationLine,
              textTransform: cs.textTransform,
              color: cs.color,
            };
          }
        }

        // ── Spacing ──
        const mt = px(cs.marginTop), mr = px(cs.marginRight), mb = px(cs.marginBottom), ml = px(cs.marginLeft);
        const pt = px(cs.paddingTop), pr = px(cs.paddingRight), pb = px(cs.paddingBottom), pl = px(cs.paddingLeft);

        if (mt || mr || mb || ml) info.margin = { top: mt, right: mr, bottom: mb, left: ml };
        if (pt || pr || pb || pl) info.padding = { top: pt, right: pr, bottom: pb, left: pl };

        // ── Layout (flex/grid) ──
        const display = cs.display;
        if (display.includes('flex') || display.includes('grid')) {
          info.layout = {
            display,
            flexDirection: cs.flexDirection,
            alignItems: cs.alignItems,
            justifyContent: cs.justifyContent,
            gap: cs.gap !== 'normal' ? parseFloat(cs.gap) || 0 : 0,
            wrap: cs.flexWrap,
          };
        }

        // ── Background ──
        const bg = cs.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          info.backgroundColor = bg;
        }

        // ── Borders ──
        const bw = px(cs.borderTopWidth) || px(cs.borderRightWidth) || px(cs.borderBottomWidth) || px(cs.borderLeftWidth);
        if (bw) {
          info.border = {
            top: px(cs.borderTopWidth), right: px(cs.borderRightWidth),
            bottom: px(cs.borderBottomWidth), left: px(cs.borderLeftWidth),
            color: cs.borderColor,
            style: cs.borderStyle,
          };
        }

        // ── Border Radius ──
        const brTL = px(cs.borderTopLeftRadius), brTR = px(cs.borderTopRightRadius);
        const brBR = px(cs.borderBottomRightRadius), brBL = px(cs.borderBottomLeftRadius);
        if (brTL || brTR || brBR || brBL) {
          info.borderRadius = { topLeft: brTL, topRight: brTR, bottomRight: brBR, bottomLeft: brBL };
        }

        // ── Box Shadow ──
        if (cs.boxShadow && cs.boxShadow !== 'none') {
          info.boxShadow = cs.boxShadow;
        }

        // ── Opacity ──
        const opacity = parseFloat(cs.opacity);
        if (opacity < 1) info.opacity = opacity;

        // ── Images ──
        if (tag === 'img') {
          info.isImage = true;
          info.src = el.src;
          info.naturalWidth = el.naturalWidth;
          info.naturalHeight = el.naturalHeight;
          info.objectFit = cs.objectFit;
        }

        results.push(info);
      }

      return results;

      function px(val) {
        const n = parseFloat(val);
        return isNaN(n) ? 0 : Math.round(n * 10) / 10;
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

    return elements;
  } finally {
    await page.close();
  }
}

// ─── Dismiss popups before extraction ───
async function dismissPopups(page) {
  const closed = await page.evaluate(() => {
    let closed = 0;
    const closeSelectors = [
      '[class*="cookie"] button', '[id*="cookie"] button',
      '[class*="consent"] button', '[id*="consent"] button',
      '[class*="modal"] [class*="close"]', '[class*="popup"] [class*="close"]',
      '[class*="overlay"] [class*="close"]', '[role="dialog"] [class*="close"]',
      'button[aria-label*="Close" i]', 'button[aria-label*="Dismiss" i]',
      'button[aria-label*="Accept" i]',
      '.close-button', '.btn-close', '.close-btn', '.modal-close',
      '[class*="newsletter"] [class*="close"]',
      '[class*="subscribe"] [class*="close"]',
    ];

    for (const sel of closeSelectors) {
      try {
        for (const btn of document.querySelectorAll(sel)) {
          if (btn.offsetWidth > 0) { btn.click(); closed++; }
        }
      } catch (e) { /* ignore */ }
    }

    const allButtons = document.querySelectorAll('button, [role="button"]');
    const words = /^(accept|accept all|agree|got it|ok|okay|close|dismiss|no thanks|not now|maybe later|reject all)$/i;
    for (const btn of allButtons) {
      const text = (btn.textContent || '').trim();
      if (text.length < 30 && words.test(text) && btn.offsetWidth > 0) {
        btn.click();
        closed++;
      }
    }
    return closed;
  });

  if (closed > 0) await sleep(500);

  await page.evaluate(() => {
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    for (const el of document.querySelectorAll('body > *, body > * > *')) {
      const style = window.getComputedStyle(el);
      const pos = style.position;
      const z = parseInt(style.zIndex) || 0;
      const rect = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      if (['html', 'body', 'main', 'header', 'footer', 'nav', 'script', 'style'].includes(tag)) continue;
      const covers = rect.width >= viewW * 0.8 && rect.height >= viewH * 0.8;
      if ((pos === 'fixed' || pos === 'absolute') && z >= 10 && covers) el.remove();
    }
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
