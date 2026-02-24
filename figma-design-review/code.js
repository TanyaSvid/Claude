// Design Review Plugin — Figma Sandbox Code
// Communicates with ui.html via postMessage

figma.showUI(__html__, { width: 900, height: 700, themeColors: true });

// Listen for messages from the UI
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'export-frame') {
    await exportSelectedFrame(msg.scale || 2);
  }

  if (msg.type === 'export-all-frames') {
    await exportAllTopLevelFrames(msg.scale || 2);
  }

  if (msg.type === 'get-selection') {
    sendSelectionInfo();
  }

  if (msg.type === 'resize-ui') {
    figma.ui.resize(msg.width || 900, msg.height || 700);
  }

  if (msg.type === 'notify') {
    figma.notify(msg.message, { timeout: msg.timeout || 3000 });
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};

// Send info about current selection to UI
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
    .filter(node => node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE')
    .map(node => ({
      id: node.id,
      name: node.name,
      width: Math.round(node.width),
      height: Math.round(node.height),
    }));

  figma.ui.postMessage({
    type: 'selection-info',
    frames: frames,
    message: frames.length === 0
      ? 'Selected nodes are not frames. Please select frames to compare.'
      : null
  });
}

// Export a single selected frame as PNG
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

// Export all top-level frames on current page
async function exportAllTopLevelFrames(scale) {
  const frames = figma.currentPage.children.filter(
    node => node.type === 'FRAME'
  );

  if (frames.length === 0) {
    figma.ui.postMessage({ type: 'export-error', message: 'No frames found on current page' });
    return;
  }

  figma.ui.postMessage({
    type: 'batch-export-start',
    total: frames.length
  });

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
        name: node.name,
        index: i,
        total: frames.length,
        message: String(err)
      });
    }
  }

  figma.ui.postMessage({ type: 'batch-export-done' });
}

// Watch for selection changes
figma.on('selectionchange', () => {
  sendSelectionInfo();
});

// Send initial selection info
sendSelectionInfo();
