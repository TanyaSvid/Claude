// Design Review Plugin — Figma Sandbox Code
// Extracts design properties + exports frames for comparison

figma.showUI(__html__, { width: 960, height: 750, themeColors: true });

// ─── Message Router ───
figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case 'export-frame':
      await exportSelectedFrame(msg.scale || 2);
      break;
    case 'export-frame-with-props':
      await exportFrameWithProperties(msg.scale || 2);
      break;
    case 'export-all-frames':
      await exportAllTopLevelFrames(msg.scale || 2);
      break;
    case 'export-all-frames-with-props':
      await exportAllFramesWithProperties(msg.scale || 2);
      break;
    case 'get-selection':
      sendSelectionInfo();
      break;
    case 'resize-ui':
      figma.ui.resize(msg.width || 960, msg.height || 750);
      break;
    case 'notify':
      figma.notify(msg.message, { timeout: msg.timeout || 3000 });
      break;
    case 'close':
      figma.closePlugin();
      break;
  }
};

// ─── Selection Info ───
function sendSelectionInfo() {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    figma.ui.postMessage({
      type: 'selection-info',
      frames: [],
      message: 'No frames selected. Select one or more frames to compare.'
    });
    return;
  }

  const frames = selection
    .filter(n => n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE')
    .map(n => ({
      id: n.id,
      name: n.name,
      width: Math.round(n.width),
      height: Math.round(n.height),
    }));

  figma.ui.postMessage({
    type: 'selection-info',
    frames,
    message: frames.length === 0
      ? 'Selected nodes are not frames. Please select frames to compare.'
      : null
  });
}

// ─── Export frame + extract design tokens ───
async function exportFrameWithProperties(scale) {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: 'export-error', message: 'No frame selected' });
    return;
  }

  const node = selection[0];
  if (node.type !== 'FRAME' && node.type !== 'COMPONENT' && node.type !== 'INSTANCE') {
    figma.ui.postMessage({ type: 'export-error', message: 'Selected node is not a frame' });
    return;
  }

  try {
    const bytes = await node.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: scale }
    });

    const designData = extractDesignTree(node, 0, 3);

    figma.ui.postMessage({
      type: 'frame-exported-with-props',
      data: Array.from(bytes),
      name: node.name,
      width: Math.round(node.width),
      height: Math.round(node.height),
      scale: scale,
      id: node.id,
      designData: designData,
    });
  } catch (err) {
    figma.ui.postMessage({ type: 'export-error', message: String(err) });
  }
}

// ─── Export single frame (simple) ───
async function exportSelectedFrame(scale) {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: 'export-error', message: 'No frame selected' });
    return;
  }

  const node = selection[0];
  if (node.type !== 'FRAME' && node.type !== 'COMPONENT' && node.type !== 'INSTANCE') {
    figma.ui.postMessage({ type: 'export-error', message: 'Selected node is not a frame' });
    return;
  }

  try {
    const bytes = await node.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: scale }
    });

    figma.ui.postMessage({
      type: 'frame-exported',
      data: Array.from(bytes),
      name: node.name,
      width: Math.round(node.width),
      height: Math.round(node.height),
      scale: scale,
      id: node.id
    });
  } catch (err) {
    figma.ui.postMessage({ type: 'export-error', message: String(err) });
  }
}

// ─── Export all frames with properties (batch) ───
async function exportAllFramesWithProperties(scale) {
  const frames = figma.currentPage.children.filter(n => n.type === 'FRAME');

  if (frames.length === 0) {
    figma.ui.postMessage({ type: 'export-error', message: 'No frames found on current page' });
    return;
  }

  figma.ui.postMessage({ type: 'batch-export-start', total: frames.length });

  for (let i = 0; i < frames.length; i++) {
    const node = frames[i];
    try {
      const bytes = await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: scale }
      });

      const designData = extractDesignTree(node, 0, 3);

      figma.ui.postMessage({
        type: 'batch-frame-exported',
        data: Array.from(bytes),
        name: node.name,
        width: Math.round(node.width),
        height: Math.round(node.height),
        scale: scale,
        id: node.id,
        index: i,
        total: frames.length,
        designData: designData,
      });
    } catch (err) {
      figma.ui.postMessage({
        type: 'batch-frame-error',
        name: node.name, index: i, total: frames.length,
        message: String(err)
      });
    }
  }

  figma.ui.postMessage({ type: 'batch-export-done' });
}

// ─── Export all frames (simple batch) ───
async function exportAllTopLevelFrames(scale) {
  const frames = figma.currentPage.children.filter(n => n.type === 'FRAME');

  if (frames.length === 0) {
    figma.ui.postMessage({ type: 'export-error', message: 'No frames found on current page' });
    return;
  }

  figma.ui.postMessage({ type: 'batch-export-start', total: frames.length });

  for (let i = 0; i < frames.length; i++) {
    const node = frames[i];
    try {
      const bytes = await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: scale }
      });

      figma.ui.postMessage({
        type: 'batch-frame-exported',
        data: Array.from(bytes),
        name: node.name,
        width: Math.round(node.width),
        height: Math.round(node.height),
        scale: scale,
        id: node.id,
        index: i,
        total: frames.length
      });
    } catch (err) {
      figma.ui.postMessage({
        type: 'batch-frame-error',
        name: node.name, index: i, total: frames.length,
        message: String(err)
      });
    }
  }

  figma.ui.postMessage({ type: 'batch-export-done' });
}

// ═══════════════════════════════════════════════════════════
//  DESIGN PROPERTY EXTRACTION
//  Walks the Figma node tree and extracts everything useful
// ═══════════════════════════════════════════════════════════

function extractDesignTree(node, depth, maxDepth) {
  const data = extractNodeProps(node);

  if (depth < maxDepth && 'children' in node && node.children) {
    data.children = [];
    for (const child of node.children) {
      if (child.visible === false) continue;
      data.children.push(extractDesignTree(child, depth + 1, maxDepth));
    }
  }

  return data;
}

function extractNodeProps(node) {
  const props = {
    name: node.name,
    type: node.type,
    x: Math.round(node.x),
    y: Math.round(node.y),
    width: Math.round(node.width),
    height: Math.round(node.height),
    visible: node.visible !== false,
  };

  // ─── Opacity ───
  if ('opacity' in node && node.opacity !== 1) {
    props.opacity = Math.round(node.opacity * 100) / 100;
  }

  // ─── Corner radius ───
  if ('cornerRadius' in node && node.cornerRadius !== 0) {
    if (typeof node.cornerRadius === 'number') {
      props.borderRadius = node.cornerRadius;
    }
  }
  if ('topLeftRadius' in node) {
    const tl = node.topLeftRadius || 0;
    const tr = node.topRightRadius || 0;
    const br = node.bottomRightRadius || 0;
    const bl = node.bottomLeftRadius || 0;
    if (tl || tr || br || bl) {
      props.borderRadii = { tl, tr, br, bl };
    }
  }

  // ─── Auto Layout (spacing, padding) ───
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    props.layout = {
      mode: node.layoutMode, // HORIZONTAL or VERTICAL
      gap: node.itemSpacing || 0,
      paddingTop: node.paddingTop || 0,
      paddingRight: node.paddingRight || 0,
      paddingBottom: node.paddingBottom || 0,
      paddingLeft: node.paddingLeft || 0,
      primaryAlign: node.primaryAxisAlignItems,
      counterAlign: node.counterAxisAlignItems,
      wrap: node.layoutWrap || 'NO_WRAP',
    };
    if (node.primaryAxisSizingMode) props.layout.primarySizing = node.primaryAxisSizingMode;
    if (node.counterAxisSizingMode) props.layout.counterSizing = node.counterAxisSizingMode;
  }

  // ─── Fills (background colors, gradients, images) ───
  if ('fills' in node && Array.isArray(node.fills)) {
    const visibleFills = node.fills.filter(f => f.visible !== false);
    if (visibleFills.length > 0) {
      props.fills = visibleFills.map(extractPaint);
    }
  }

  // ─── Strokes (borders) ───
  if ('strokes' in node && Array.isArray(node.strokes)) {
    const visibleStrokes = node.strokes.filter(s => s.visible !== false);
    if (visibleStrokes.length > 0) {
      props.strokes = visibleStrokes.map(extractPaint);
      if (node.strokeWeight) props.strokeWeight = node.strokeWeight;
      if (node.strokeAlign) props.strokeAlign = node.strokeAlign;
    }
  }

  // ─── Effects (shadows, blurs) ───
  if ('effects' in node && Array.isArray(node.effects)) {
    const visibleEffects = node.effects.filter(e => e.visible !== false);
    if (visibleEffects.length > 0) {
      props.effects = visibleEffects.map(e => ({
        type: e.type,
        radius: e.radius,
        offset: e.offset ? { x: e.offset.x, y: e.offset.y } : undefined,
        spread: e.spread,
        color: e.color ? rgbaToString(e.color) : undefined,
      }));
    }
  }

  // ─── Text properties ───
  if (node.type === 'TEXT') {
    props.text = {
      characters: node.characters,
      truncated: node.characters.length > 200 ? true : undefined,
    };

    // Font properties — may be mixed (Symbol), handle gracefully
    const fontSize = safeGet(node, 'fontSize');
    const fontName = safeGet(node, 'fontName');
    const fontWeight = safeGet(node, 'fontWeight');
    const lineHeight = safeGet(node, 'lineHeight');
    const letterSpacing = safeGet(node, 'letterSpacing');
    const textAlign = safeGet(node, 'textAlignHorizontal');
    const textAlignV = safeGet(node, 'textAlignVertical');
    const textDecoration = safeGet(node, 'textDecoration');
    const textCase = safeGet(node, 'textCase');

    if (fontSize && typeof fontSize === 'number') props.text.fontSize = fontSize;
    if (fontName && fontName.family) {
      props.text.fontFamily = fontName.family;
      props.text.fontStyle = fontName.style;
    }
    if (fontWeight && typeof fontWeight === 'number') props.text.fontWeight = fontWeight;
    if (lineHeight && lineHeight.value !== undefined) {
      props.text.lineHeight = {
        value: Math.round(lineHeight.value * 100) / 100,
        unit: lineHeight.unit,
      };
    }
    if (letterSpacing && letterSpacing.value !== undefined && letterSpacing.value !== 0) {
      props.text.letterSpacing = {
        value: Math.round(letterSpacing.value * 100) / 100,
        unit: letterSpacing.unit,
      };
    }
    if (textAlign) props.text.textAlign = textAlign;
    if (textAlignV) props.text.textAlignVertical = textAlignV;
    if (textDecoration && textDecoration !== 'NONE') props.text.textDecoration = textDecoration;
    if (textCase && textCase !== 'ORIGINAL') props.text.textCase = textCase;
  }

  // ─── Image fills marker ───
  if ('fills' in node && Array.isArray(node.fills)) {
    const hasImage = node.fills.some(f => f.type === 'IMAGE' && f.visible !== false);
    if (hasImage) {
      props.hasImage = true;
    }
  }

  // ─── Constraints ───
  if ('constraints' in node) {
    props.constraints = {
      horizontal: node.constraints.horizontal,
      vertical: node.constraints.vertical,
    };
  }

  // ─── Clip content ───
  if ('clipsContent' in node && node.clipsContent) {
    props.clipsContent = true;
  }

  return props;
}

function extractPaint(paint) {
  const result = { type: paint.type };
  if (paint.type === 'SOLID' && paint.color) {
    result.color = rgbaToString(paint.color, paint.opacity);
  }
  if (paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL') {
    result.gradient = true;
    if (paint.gradientStops) {
      result.stops = paint.gradientStops.map(s => ({
        position: Math.round(s.position * 100) / 100,
        color: rgbaToString(s.color),
      }));
    }
  }
  if (paint.type === 'IMAGE') {
    result.imageRef = true;
    result.scaleMode = paint.scaleMode;
  }
  return result;
}

function rgbaToString(color, extraOpacity) {
  const r = Math.round((color.r || 0) * 255);
  const g = Math.round((color.g || 0) * 255);
  const b = Math.round((color.b || 0) * 255);
  let a = color.a !== undefined ? color.a : 1;
  if (extraOpacity !== undefined) a *= extraOpacity;
  a = Math.round(a * 100) / 100;

  if (a === 1) {
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function hex(n) {
  return n.toString(16).padStart(2, '0');
}

function safeGet(node, prop) {
  try {
    const val = node[prop];
    // figma.mixed is returned when text has mixed properties
    if (val === figma.mixed) return null;
    return val;
  } catch {
    return null;
  }
}

// ─── Selection change listener ───
figma.on('selectionchange', () => {
  sendSelectionInfo();
});

sendSelectionInfo();
