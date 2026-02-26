// ─────────────────────────────────────────
//  Figma REST API Client
//  Extracts design tokens from Figma files
// ─────────────────────────────────────────

const FIGMA_API = 'https://api.figma.com/v1';

/**
 * Parse a Figma URL into fileKey and nodeId
 * Supports:
 *   https://www.figma.com/design/FILE_KEY/Title?node-id=1-2
 *   https://www.figma.com/file/FILE_KEY/Title?node-id=1-2
 *   Just a file key string
 */
export function parseFigmaUrl(input) {
  if (!input) throw new Error('Figma URL or file key is required');

  // Direct file key (no slashes)
  if (!input.includes('/') && !input.includes('?')) {
    return { fileKey: input, nodeId: null };
  }

  const url = new URL(input);
  const parts = url.pathname.split('/').filter(Boolean);

  // /design/FILE_KEY/... or /file/FILE_KEY/...
  let fileKey = null;
  for (let i = 0; i < parts.length; i++) {
    if ((parts[i] === 'file' || parts[i] === 'design') && parts[i + 1]) {
      fileKey = parts[i + 1];
      break;
    }
  }

  if (!fileKey) throw new Error(`Could not extract file key from URL: ${input}`);

  // node-id from query params
  let nodeId = url.searchParams.get('node-id');
  if (nodeId) {
    // Figma URLs use "1-2" format, API uses "1:2"
    nodeId = nodeId.replace(/-/g, ':');
  }

  return { fileKey, nodeId };
}

/**
 * Fetch a Figma file or specific nodes
 */
export async function fetchFigmaFile(token, fileKey, nodeIds = null) {
  let url = `${FIGMA_API}/files/${fileKey}`;
  const params = new URLSearchParams();
  params.set('geometry', 'paths');

  if (nodeIds) {
    const ids = Array.isArray(nodeIds) ? nodeIds.join(',') : nodeIds;
    url = `${FIGMA_API}/files/${fileKey}/nodes`;
    params.set('ids', ids);
  }

  const resp = await fetch(`${url}?${params}`, {
    headers: { 'X-Figma-Token': token },
  });

  if (!resp.ok) {
    const body = await resp.text();
    if (resp.status === 403) throw new Error('Invalid Figma token or no access to this file');
    if (resp.status === 404) throw new Error('Figma file not found');
    throw new Error(`Figma API error ${resp.status}: ${body}`);
  }

  return resp.json();
}

/**
 * Extract all design tokens from a Figma node tree
 * Returns a flat array of elements with their properties
 */
export function extractDesignTokens(node, parentPath = '') {
  const tokens = [];
  processNode(node, parentPath, tokens);
  return tokens;
}

function processNode(node, parentPath, tokens) {
  if (!node || node.visible === false) return;

  const path = parentPath ? `${parentPath} > ${node.name}` : node.name;
  const token = {
    id: node.id,
    name: node.name,
    type: node.type,
    path,
  };

  // ── Position & Size ──
  if (node.absoluteBoundingBox) {
    const bb = node.absoluteBoundingBox;
    token.rect = {
      x: Math.round(bb.x),
      y: Math.round(bb.y),
      width: Math.round(bb.width),
      height: Math.round(bb.height),
    };
  }

  // ── Text Properties ──
  if (node.type === 'TEXT') {
    token.text = node.characters || '';
    const style = node.style || {};
    token.font = {
      family: style.fontFamily,
      size: style.fontSize,
      weight: style.fontWeight,
      lineHeight: extractLineHeight(style),
      letterSpacing: extractLetterSpacing(style),
      textAlign: (style.textAlignHorizontal || '').toLowerCase(),
      textDecoration: (style.textDecoration || 'none').toLowerCase(),
      textTransform: (style.textCase || 'none').toLowerCase(),
    };

    // Per-character styles (style overrides)
    if (node.characterStyleOverrides && node.styleOverrideTable) {
      token.styleOverrides = node.styleOverrideTable;
    }
  }

  // ── Fills (background/text colors) ──
  if (node.fills && node.fills.length > 0) {
    token.fills = node.fills
      .filter(f => f.visible !== false && f.type === 'SOLID')
      .map(f => ({
        color: rgbaToHex(f.color, f.opacity),
        opacity: f.opacity ?? 1,
      }));
  }

  // ── Strokes (borders) ──
  if (node.strokes && node.strokes.length > 0) {
    const visibleStrokes = node.strokes.filter(s => s.visible !== false);
    if (visibleStrokes.length > 0) {
      token.strokes = visibleStrokes.map(s => ({
        color: s.type === 'SOLID' ? rgbaToHex(s.color, s.opacity) : null,
        weight: node.strokeWeight,
        align: node.strokeAlign, // INSIDE, OUTSIDE, CENTER
      }));
    }
  }

  // ── Border Radius ──
  if (node.cornerRadius !== undefined && node.cornerRadius > 0) {
    token.borderRadius = node.cornerRadius;
  }
  if (node.rectangleCornerRadii) {
    const [tl, tr, br, bl] = node.rectangleCornerRadii;
    if (tl || tr || br || bl) {
      token.borderRadii = { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl };
    }
  }

  // ── Effects (shadows, blur) ──
  if (node.effects && node.effects.length > 0) {
    token.effects = node.effects
      .filter(e => e.visible !== false)
      .map(e => ({
        type: e.type, // DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, BACKGROUND_BLUR
        color: e.color ? rgbaToHex(e.color, e.color.a) : null,
        offset: e.offset ? { x: e.offset.x, y: e.offset.y } : null,
        radius: e.radius,
        spread: e.spread || 0,
      }));
  }

  // ── Auto Layout (Flexbox equivalent) ──
  if (node.layoutMode) {
    token.layout = {
      mode: node.layoutMode, // HORIZONTAL, VERTICAL
      gap: node.itemSpacing || 0,
      paddingTop: node.paddingTop || 0,
      paddingRight: node.paddingRight || 0,
      paddingBottom: node.paddingBottom || 0,
      paddingLeft: node.paddingLeft || 0,
      counterAxisAlignItems: node.counterAxisAlignItems, // MIN, CENTER, MAX
      primaryAxisAlignItems: node.primaryAxisAlignItems, // MIN, CENTER, MAX, SPACE_BETWEEN
      wrap: node.layoutWrap || 'NO_WRAP',
    };
  }

  // ── Sizing constraints ──
  if (node.layoutSizingHorizontal) {
    token.sizing = {
      horizontal: node.layoutSizingHorizontal, // FIXED, HUG, FILL
      vertical: node.layoutSizingVertical,
    };
  }

  // ── Opacity ──
  if (node.opacity !== undefined && node.opacity < 1) {
    token.opacity = node.opacity;
  }

  // ── Blend mode ──
  if (node.blendMode && node.blendMode !== 'PASS_THROUGH') {
    token.blendMode = node.blendMode;
  }

  // ── Images ──
  if (node.type === 'RECTANGLE' || node.type === 'ELLIPSE' || node.type === 'FRAME') {
    const imageFills = (node.fills || []).filter(f => f.type === 'IMAGE' && f.visible !== false);
    if (imageFills.length > 0) {
      token.hasImage = true;
      token.imageScaleMode = imageFills[0].scaleMode; // FILL, FIT, CROP, TILE
    }
  }

  // ── Component info ──
  if (node.type === 'INSTANCE') {
    token.componentId = node.componentId;
  }

  // Only include tokens with meaningful properties
  const hasData = token.text || token.fills || token.strokes || token.layout ||
    token.effects || token.borderRadius || token.hasImage || token.font;

  if (hasData) {
    tokens.push(token);
  }

  // Recurse into children
  if (node.children) {
    for (const child of node.children) {
      processNode(child, path, tokens);
    }
  }
}

/**
 * Export Figma node(s) as PNG image, returns base64 string
 */
export async function exportFigmaImage(token, fileKey, nodeId, scale = 2) {
  // If no specific node, get the first page
  let ids = nodeId;
  if (!ids) {
    const fileData = await fetchFigmaFile(token, fileKey);
    const firstPage = fileData.document?.children?.[0];
    if (!firstPage) throw new Error('No pages found in Figma file');
    // Get the first top-level frame on the page
    const firstFrame = firstPage.children?.find(c =>
      c.type === 'FRAME' || c.type === 'COMPONENT' || c.type === 'SECTION'
    ) || firstPage;
    ids = firstFrame.id;
  }

  // Request image render from Figma
  const params = new URLSearchParams({
    ids,
    format: 'png',
    scale: String(scale),
  });

  const resp = await fetch(`${FIGMA_API}/images/${fileKey}?${params}`, {
    headers: { 'X-Figma-Token': token },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Figma Image API error ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  const imageUrl = data.images?.[ids];
  if (!imageUrl) throw new Error('Figma did not return an image URL');

  // Download the image and convert to base64
  const imgResp = await fetch(imageUrl);
  if (!imgResp.ok) throw new Error(`Failed to download Figma image: ${imgResp.status}`);

  const buffer = Buffer.from(await imgResp.arrayBuffer());
  return buffer.toString('base64');
}

// ── Helpers ──

function extractLineHeight(style) {
  if (!style.lineHeightPx) return null;
  return {
    value: Math.round(style.lineHeightPx * 10) / 10,
    unit: style.lineHeightUnit || 'PIXELS',
  };
}

function extractLetterSpacing(style) {
  if (!style.letterSpacing) return null;
  return {
    value: Math.round(style.letterSpacing * 100) / 100,
    unit: style.letterSpacingUnit || 'PIXELS',
  };
}

function rgbaToHex(color, opacity) {
  if (!color) return null;
  const r = Math.round((color.r || 0) * 255);
  const g = Math.round((color.g || 0) * 255);
  const b = Math.round((color.b || 0) * 255);
  const a = opacity ?? color.a ?? 1;

  const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;

  if (a < 1) {
    const alpha = Math.round(a * 255);
    return `${hex}${alpha.toString(16).padStart(2, '0')}`;
  }
  return hex;
}
