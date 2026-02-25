// ─────────────────────────────────────────
//  Design vs Implementation Comparator
//  Matches Figma tokens to DOM elements
//  and compares properties
// ─────────────────────────────────────────

/**
 * Compare Figma design tokens with live site elements
 * Returns structured issues list
 */
export function compareDesignWithSite(figmaTokens, siteElements) {
  const issues = [];
  const matched = new Set();

  // ── 1. Match & compare text elements ──
  const figmaTexts = figmaTokens.filter(t => t.text && t.font);
  const siteTexts = siteElements.filter(e => e.text && e.font);

  for (const ft of figmaTexts) {
    const match = findTextMatch(ft, siteTexts, matched);
    if (!match) {
      // Text exists in design but not found on site
      if (ft.text.trim().length > 2) {
        issues.push({
          type: 'content',
          severity: 'warning',
          figmaNode: ft.name,
          figmaPath: ft.path,
          property: 'text-content',
          message: `Текст «${ft.text.slice(0, 60)}» из макета не найден на сайте`,
        });
      }
      continue;
    }

    matched.add(match);

    // Compare font properties
    if (ft.font.size && match.font.size) {
      const diff = Math.abs(ft.font.size - match.font.size);
      if (diff > 0.5) {
        issues.push({
          type: 'typography',
          severity: diff > 2 ? 'error' : 'warning',
          figmaNode: ft.name,
          siteElement: match.selector,
          text: ft.text.slice(0, 60),
          property: 'font-size',
          expected: `${ft.font.size}px`,
          actual: `${match.font.size}px`,
          diff: `${diff > 0 ? '+' : ''}${(match.font.size - ft.font.size).toFixed(1)}px`,
        });
      }
    }

    if (ft.font.weight && match.font.weight) {
      const diff = Math.abs(ft.font.weight - match.font.weight);
      if (diff >= 100) {
        issues.push({
          type: 'typography',
          severity: 'warning',
          figmaNode: ft.name,
          siteElement: match.selector,
          text: ft.text.slice(0, 60),
          property: 'font-weight',
          expected: String(ft.font.weight),
          actual: String(match.font.weight),
        });
      }
    }

    if (ft.font.lineHeight?.value && match.font.lineHeight) {
      const figmaLH = ft.font.lineHeight.value;
      const siteLH = match.font.lineHeight;
      const diff = Math.abs(figmaLH - siteLH);
      if (diff > 1) {
        issues.push({
          type: 'typography',
          severity: diff > 4 ? 'error' : 'warning',
          figmaNode: ft.name,
          siteElement: match.selector,
          text: ft.text.slice(0, 60),
          property: 'line-height',
          expected: `${figmaLH}px`,
          actual: `${siteLH}px`,
        });
      }
    }

    if (ft.font.letterSpacing?.value && ft.font.letterSpacing.value !== 0) {
      const figmaLS = ft.font.letterSpacing.unit === 'PERCENT'
        ? (ft.font.letterSpacing.value / 100) * (ft.font.size || 16)
        : ft.font.letterSpacing.value;
      const siteLS = match.font.letterSpacing || 0;
      if (Math.abs(figmaLS - siteLS) > 0.3) {
        issues.push({
          type: 'typography',
          severity: 'info',
          figmaNode: ft.name,
          siteElement: match.selector,
          text: ft.text.slice(0, 60),
          property: 'letter-spacing',
          expected: `${figmaLS.toFixed(1)}px`,
          actual: `${siteLS}px`,
        });
      }
    }

    // Text alignment
    if (ft.font.textAlign && match.font.textAlign) {
      const figmaAlign = ft.font.textAlign.toLowerCase();
      const siteAlign = match.font.textAlign.toLowerCase();
      if (figmaAlign !== siteAlign && figmaAlign !== 'left') {
        // Don't flag left-alignment mismatches as that's the default
        issues.push({
          type: 'typography',
          severity: 'warning',
          figmaNode: ft.name,
          siteElement: match.selector,
          text: ft.text.slice(0, 60),
          property: 'text-align',
          expected: figmaAlign,
          actual: siteAlign,
        });
      }
    }

    // Text color
    if (ft.fills?.length > 0 && match.font.color) {
      const figmaColor = ft.fills[0].color;
      if (figmaColor) {
        const siteRgb = parseRgb(match.font.color);
        const figmaRgb = hexToRgb(figmaColor);
        if (figmaRgb && siteRgb) {
          const diff = colorDistance(figmaRgb, siteRgb);
          if (diff > 10) {
            issues.push({
              type: 'color',
              severity: diff > 30 ? 'error' : 'warning',
              figmaNode: ft.name,
              siteElement: match.selector,
              text: ft.text.slice(0, 60),
              property: 'color',
              expected: figmaColor,
              actual: match.font.color,
            });
          }
        }
      }
    }
  }

  // ── 2. Compare layout containers ──
  const figmaLayouts = figmaTokens.filter(t => t.layout);
  const siteLayouts = siteElements.filter(e => e.layout);

  for (const fl of figmaLayouts) {
    if (!fl.rect) continue;
    const candidates = siteLayouts.filter(se =>
      se.rect && rectsOverlap(fl.rect, se.rect)
    );
    if (candidates.length === 0) continue;

    // Best match by overlap area
    const siteEl = candidates.sort((a, b) => overlapArea(fl.rect, b.rect) - overlapArea(fl.rect, a.rect))[0];

    // Compare gap
    if (fl.layout.gap > 0 && siteEl.layout.gap !== undefined) {
      const diff = Math.abs(fl.layout.gap - siteEl.layout.gap);
      if (diff > 1) {
        issues.push({
          type: 'spacing',
          severity: diff > 8 ? 'error' : 'warning',
          figmaNode: fl.name,
          siteElement: siteEl.selector,
          property: 'gap',
          expected: `${fl.layout.gap}px`,
          actual: `${siteEl.layout.gap}px`,
        });
      }
    }

    // Compare padding
    if (siteEl.padding) {
      const padMap = [
        ['top', 'paddingTop'], ['right', 'paddingRight'],
        ['bottom', 'paddingBottom'], ['left', 'paddingLeft'],
      ];
      for (const [side, figmaKey] of padMap) {
        const figmaVal = fl.layout[figmaKey] || 0;
        const siteVal = siteEl.padding[side] || 0;
        const diff = Math.abs(figmaVal - siteVal);
        if (diff > 1) {
          issues.push({
            type: 'spacing',
            severity: diff > 8 ? 'error' : 'warning',
            figmaNode: fl.name,
            siteElement: siteEl.selector,
            property: `padding-${side}`,
            expected: `${figmaVal}px`,
            actual: `${siteVal}px`,
          });
        }
      }
    }

    // Compare flex direction
    if (fl.layout.mode && siteEl.layout.flexDirection) {
      const figmaDir = fl.layout.mode === 'HORIZONTAL' ? 'row' : 'column';
      const siteDir = siteEl.layout.flexDirection;
      if (figmaDir !== siteDir) {
        issues.push({
          type: 'layout',
          severity: 'error',
          figmaNode: fl.name,
          siteElement: siteEl.selector,
          property: 'flex-direction',
          expected: figmaDir,
          actual: siteDir,
        });
      }
    }
  }

  // ── 3. Compare colors (backgrounds) ──
  const figmaWithBg = figmaTokens.filter(t => t.fills?.length > 0 && !t.text && t.rect);
  const siteWithBg = siteElements.filter(e => e.backgroundColor);

  for (const fb of figmaWithBg) {
    const candidates = siteWithBg.filter(se =>
      se.rect && rectsOverlap(fb.rect, se.rect)
    );
    if (candidates.length === 0) continue;

    const siteEl = candidates.sort((a, b) => overlapArea(fb.rect, b.rect) - overlapArea(fb.rect, a.rect))[0];
    const figmaColor = fb.fills[0].color;
    if (!figmaColor) continue;

    const figmaRgb = hexToRgb(figmaColor);
    const siteRgb = parseRgb(siteEl.backgroundColor);
    if (figmaRgb && siteRgb) {
      const diff = colorDistance(figmaRgb, siteRgb);
      if (diff > 15) {
        issues.push({
          type: 'color',
          severity: diff > 40 ? 'error' : 'warning',
          figmaNode: fb.name,
          siteElement: siteEl.selector,
          property: 'background-color',
          expected: figmaColor,
          actual: siteEl.backgroundColor,
        });
      }
    }
  }

  // ── 4. Compare border radius ──
  const figmaWithRadius = figmaTokens.filter(t => (t.borderRadius || t.borderRadii) && t.rect);
  for (const fr of figmaWithRadius) {
    const candidates = siteElements.filter(se =>
      se.rect && se.borderRadius && rectsOverlap(fr.rect, se.rect)
    );
    if (candidates.length === 0) continue;

    const siteEl = candidates.sort((a, b) => overlapArea(fr.rect, b.rect) - overlapArea(fr.rect, a.rect))[0];
    const figmaR = fr.borderRadius || fr.borderRadii?.topLeft || 0;
    const siteR = siteEl.borderRadius?.topLeft || 0;
    const diff = Math.abs(figmaR - siteR);

    if (diff > 1) {
      issues.push({
        type: 'styling',
        severity: diff > 8 ? 'error' : 'warning',
        figmaNode: fr.name,
        siteElement: siteEl.selector,
        property: 'border-radius',
        expected: `${figmaR}px`,
        actual: `${siteR}px`,
      });
    }
  }

  // ── 5. Compare sizes (width/height for key elements) ──
  for (const ft of figmaTokens) {
    if (!ft.rect || ft.type === 'TEXT') continue;
    if (!ft.rect.width || ft.rect.width < 20) continue;

    const candidates = siteElements.filter(se =>
      se.rect && rectsOverlap(ft.rect, se.rect)
    );
    if (candidates.length === 0) continue;

    const siteEl = candidates.sort((a, b) => overlapArea(ft.rect, b.rect) - overlapArea(ft.rect, a.rect))[0];

    const wDiff = Math.abs(ft.rect.width - siteEl.rect.width);
    const hDiff = Math.abs(ft.rect.height - siteEl.rect.height);

    if (wDiff > 10 && wDiff / ft.rect.width > 0.05) {
      issues.push({
        type: 'sizing',
        severity: wDiff / ft.rect.width > 0.15 ? 'error' : 'warning',
        figmaNode: ft.name,
        siteElement: siteEl.selector,
        property: 'width',
        expected: `${ft.rect.width}px`,
        actual: `${siteEl.rect.width}px`,
      });
    }

    if (hDiff > 10 && hDiff / ft.rect.height > 0.05) {
      issues.push({
        type: 'sizing',
        severity: hDiff / ft.rect.height > 0.15 ? 'error' : 'warning',
        figmaNode: ft.name,
        siteElement: siteEl.selector,
        property: 'height',
        expected: `${ft.rect.height}px`,
        actual: `${siteEl.rect.height}px`,
      });
    }
  }

  // Sort: errors first
  issues.sort((a, b) => {
    const sev = { error: 0, warning: 1, info: 2 };
    return (sev[a.severity] || 2) - (sev[b.severity] || 2);
  });

  return issues;
}

// ─── Matching helpers ───

function findTextMatch(figmaToken, siteTexts, alreadyMatched) {
  const figmaStr = figmaToken.text.trim().toLowerCase();
  if (!figmaStr) return null;

  // Try exact match first
  for (const se of siteTexts) {
    if (alreadyMatched.has(se)) continue;
    const siteStr = se.text.trim().toLowerCase();
    if (siteStr === figmaStr) return se;
  }

  // Try contains match
  for (const se of siteTexts) {
    if (alreadyMatched.has(se)) continue;
    const siteStr = se.text.trim().toLowerCase();
    if (figmaStr.length > 3 && (siteStr.includes(figmaStr) || figmaStr.includes(siteStr))) return se;
  }

  // Try fuzzy match (first N chars)
  const prefix = figmaStr.slice(0, 20);
  if (prefix.length >= 4) {
    for (const se of siteTexts) {
      if (alreadyMatched.has(se)) continue;
      if (se.text.trim().toLowerCase().startsWith(prefix)) return se;
    }
  }

  return null;
}

function rectsOverlap(a, b) {
  const t = 20; // tolerance
  return !(a.x + a.width + t < b.x || b.x + b.width + t < a.x ||
    a.y + a.height + t < b.y || b.y + b.height + t < a.y);
}

function overlapArea(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function hexToRgb(hex) {
  const m = hex.match(/^#([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})/i);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function parseRgb(str) {
  const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) };
}

function colorDistance(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}
