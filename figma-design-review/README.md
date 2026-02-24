# Design Review — Figma Plugin

Figma plugin for pixel-level comparison of design frames with live websites.
Finds spacing differences, layout shifts, and visual discrepancies across pages and breakpoints.

## How it works

1. **Figma Plugin** reads selected frame, exports as PNG
2. **Local server** (Puppeteer) takes screenshot of the live site at matching viewport
3. **pixelmatch** compares images pixel-by-pixel
4. Plugin shows: side-by-side, overlay slider, diff view + match percentage

## Setup

### 1. Start the comparison server

```bash
cd server
npm install
npm start
```

Server runs on `http://localhost:3742`.

### 2. Load the plugin in Figma

1. Open Figma Desktop
2. Go to **Plugins > Development > Import plugin from manifest**
3. Select `figma-design-review/manifest.json`
4. The plugin appears in Plugins > Development > Design Review

### 3. Use

1. Select a frame in Figma
2. Open the plugin (Plugins > Development > Design Review)
3. Enter the URL of the live page
4. Click **Compare**
5. Toggle between Side-by-Side, Overlay, and Diff views

### Batch mode

For comparing multiple pages at once:

1. Click **Batch**
2. Click **Load Frames** — loads all top-level frames from the current page
3. Enter URLs for each frame (auto-guessed from frame names)
4. Click **Run All**
5. Review summary with per-frame match percentages

## Settings

| Setting | Description |
|---------|-------------|
| **Scale** | Export scale (1x, 2x retina, 3x) |
| **Threshold** | pixelmatch sensitivity: 0 = strict, 1 = lenient. Default 0.1 |
| **Anti-aliasing** | Detect and tolerate anti-aliasing differences |
| **Delay** | Wait time (ms) before screenshot for animations/lazy content |
| **Hide selectors** | CSS selectors to hide before screenshot (e.g. `.cookie-banner, .chat-widget`) |

## Tips

- Name frames to match URL slugs for auto-URL detection in batch mode (e.g. "about", "contacts", "pricing")
- Use **Hide selectors** to remove cookie banners, chat widgets, and other overlays
- Increase **Delay** for pages with heavy animations or lazy loading
- Set **Threshold** to 0.2–0.3 if you get too many false positives from font rendering differences
- For responsive review: create frames at 1440, 1024, 768, 375 widths and batch-compare all at once

## Server API

```
POST /compare
  body: { url, figmaImage (base64), viewport: { width, height }, scale, threshold, delay, hideSelectors }
  returns: { matchPercent, mismatchedPixels, totalPixels, screenshot (base64), diff (base64), dimensions }

POST /screenshot
  body: { url, width, height, scale, delay, hideSelectors }
  returns: { screenshot (base64) }

GET /health
  returns: { status: "ok" }
```
