#!/usr/bin/env node

// ═══════════════════════════════════════════
//  Figma Design Review — MCP Server
//  No screenshots. Real data comparison.
//
//  Tools:
//    compare_design  — Full comparison: Figma ↔ live site
//    get_figma_tokens — Extract design tokens from Figma
//    get_site_styles  — Extract CSS from live site
// ═══════════════════════════════════════════

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v3';

import { parseFigmaUrl, fetchFigmaFile, extractDesignTokens } from './figma-api.js';
import { extractSiteElements, closeBrowser } from './site-extractor.js';
import { compareDesignWithSite } from './comparator.js';
import { generateDesignerReport, generateStructuredReport } from './designer-report.js';

// ─── Load .env file if present ───
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envFile = readFileSync(join(__dirname, '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* no .env file — that's fine */ }

const server = new McpServer({
  name: 'figma-design-review',
  version: '1.0.0',
  description: 'Compare Figma designs with live websites using real data — no screenshots needed',
});

// ─── Helper: get Figma token from env ───
function getFigmaToken() {
  const token = process.env.FIGMA_ACCESS_TOKEN || process.env.FIGMA_TOKEN;
  if (!token) {
    throw new Error(
      'FIGMA_ACCESS_TOKEN not set. Get a personal access token from:\n' +
      'Figma → Settings → Personal Access Tokens\n' +
      'Then set it: export FIGMA_ACCESS_TOKEN=your_token'
    );
  }
  return token;
}

// ═══════════════════════════════════════════
//  Tool: compare_design
//  Full comparison of Figma design vs live site
// ═══════════════════════════════════════════
server.tool(
  'compare_design',
  {
    description: 'Compare a Figma design with a live website. Extracts real design tokens from Figma and computed CSS from the live site, then compares them directly — no screenshots. Returns a detailed report in Russian written as a designer\'s commentary.',
    figma_url: z.string().describe('Figma file URL or file key. Example: https://www.figma.com/design/ABC123/MyProject?node-id=1-2'),
    site_url: z.string().url().describe('Live website URL to compare against. Example: https://example.com'),
    viewport_width: z.number().optional().default(1440).describe('Viewport width for site extraction (default: 1440)'),
    viewport_height: z.number().optional().default(900).describe('Viewport height for site extraction (default: 900)'),
    page_name: z.string().optional().describe('Page name for the report header'),
  },
  async ({ figma_url, site_url, viewport_width, viewport_height, page_name }) => {
    try {
      const token = getFigmaToken();
      const { fileKey, nodeId } = parseFigmaUrl(figma_url);

      // 1. Fetch Figma data
      const figmaData = await fetchFigmaFile(token, fileKey, nodeId ? [nodeId] : null);

      // Extract the root node
      let rootNode;
      if (figmaData.nodes) {
        // Node-specific response
        const firstNodeData = Object.values(figmaData.nodes)[0];
        rootNode = firstNodeData?.document;
      } else {
        // Full file response — find the first page
        rootNode = figmaData.document?.children?.[0];
      }

      if (!rootNode) {
        return { content: [{ type: 'text', text: 'Could not find the specified Figma node. Check the URL and node-id.' }] };
      }

      // 2. Extract design tokens
      const figmaTokens = extractDesignTokens(rootNode);

      // 3. Extract site CSS
      const siteElements = await extractSiteElements(site_url, {
        width: viewport_width,
        height: viewport_height,
      });

      // 4. Compare
      const issues = compareDesignWithSite(figmaTokens, siteElements);

      // 5. Generate reports
      const designerNote = generateDesignerReport(issues, {
        pageName: page_name || rootNode.name,
        figmaUrl: figma_url,
        siteUrl: site_url,
      });

      const structured = generateStructuredReport(issues, figmaTokens, siteElements);

      const output = [
        designerNote,
        '\n═══════════════════════════════════════════',
        `Элементов в Figma: ${figmaTokens.length}`,
        `Элементов на сайте: ${siteElements.length}`,
        `Всего расхождений: ${structured.summary.totalIssues}`,
        `  Критичных: ${structured.summary.errors}`,
        `  Предупреждений: ${structured.summary.warnings}`,
      ];

      if (Object.keys(structured.summary.issuesByType).length > 0) {
        output.push('\nПо категориям:');
        for (const [type, count] of Object.entries(structured.summary.issuesByType)) {
          output.push(`  ${type}: ${count}`);
        }
      }

      return {
        content: [{
          type: 'text',
          text: output.join('\n'),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ═══════════════════════════════════════════
//  Tool: get_figma_tokens
//  Extract design tokens from a Figma file
// ═══════════════════════════════════════════
server.tool(
  'get_figma_tokens',
  {
    description: 'Extract design tokens (fonts, colors, spacing, layout, etc.) from a Figma file or specific node. Returns structured data about all design elements.',
    figma_url: z.string().describe('Figma file URL or file key'),
  },
  async ({ figma_url }) => {
    try {
      const token = getFigmaToken();
      const { fileKey, nodeId } = parseFigmaUrl(figma_url);
      const figmaData = await fetchFigmaFile(token, fileKey, nodeId ? [nodeId] : null);

      let rootNode;
      if (figmaData.nodes) {
        rootNode = Object.values(figmaData.nodes)[0]?.document;
      } else {
        rootNode = figmaData.document?.children?.[0];
      }

      if (!rootNode) {
        return { content: [{ type: 'text', text: 'Node not found' }], isError: true };
      }

      const tokens = extractDesignTokens(rootNode);

      // Format as readable output
      const lines = [`Design tokens from: ${rootNode.name}`, `Total elements: ${tokens.length}`, ''];

      // Group by type
      const texts = tokens.filter(t => t.text);
      const layouts = tokens.filter(t => t.layout);
      const colored = tokens.filter(t => t.fills?.length > 0);

      if (texts.length > 0) {
        lines.push(`📝 Text elements (${texts.length}):`);
        for (const t of texts.slice(0, 20)) {
          lines.push(`  "${t.text.slice(0, 50)}" — ${t.font?.family || '?'} ${t.font?.size || '?'}px / ${t.font?.weight || '?'}`);
          if (t.fills?.length > 0) lines.push(`    Color: ${t.fills[0].color}`);
        }
        lines.push('');
      }

      if (layouts.length > 0) {
        lines.push(`📐 Layout containers (${layouts.length}):`);
        for (const l of layouts.slice(0, 15)) {
          lines.push(`  ${l.name}: ${l.layout.mode} gap=${l.layout.gap}px padding=${l.layout.paddingTop}/${l.layout.paddingRight}/${l.layout.paddingBottom}/${l.layout.paddingLeft}`);
        }
        lines.push('');
      }

      if (colored.length > 0) {
        const uniqueColors = [...new Set(colored.flatMap(c => c.fills.map(f => f.color)).filter(Boolean))];
        lines.push(`🎨 Colors used (${uniqueColors.length}):`);
        for (const c of uniqueColors.slice(0, 20)) {
          lines.push(`  ${c}`);
        }
      }

      return {
        content: [{
          type: 'text',
          text: lines.join('\n'),
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════
//  Tool: get_site_styles
//  Extract CSS/DOM from a live site
// ═══════════════════════════════════════════
server.tool(
  'get_site_styles',
  {
    description: 'Extract computed CSS styles from all visible elements on a live website. Returns fonts, colors, spacing, layout information.',
    site_url: z.string().url().describe('URL of the live website'),
    viewport_width: z.number().optional().default(1440).describe('Viewport width (default: 1440)'),
  },
  async ({ site_url, viewport_width }) => {
    try {
      const elements = await extractSiteElements(site_url, { width: viewport_width });

      const texts = elements.filter(e => e.font);
      const layouts = elements.filter(e => e.layout);
      const bgs = elements.filter(e => e.backgroundColor);

      const lines = [
        `Site styles from: ${site_url}`,
        `Total elements: ${elements.length}`,
        '',
      ];

      if (texts.length > 0) {
        lines.push(`📝 Text elements (${texts.length}):`);
        for (const t of texts.slice(0, 20)) {
          lines.push(`  "${(t.text || '').slice(0, 50)}" — ${t.font.family} ${t.font.size}px / ${t.font.weight}`);
          lines.push(`    Color: ${t.font.color} | LH: ${t.font.lineHeight}px | Align: ${t.font.textAlign}`);
        }
        lines.push('');
      }

      if (layouts.length > 0) {
        lines.push(`📐 Flex/Grid containers (${layouts.length}):`);
        for (const l of layouts.slice(0, 15)) {
          lines.push(`  ${l.selector}: ${l.layout.display} dir=${l.layout.flexDirection} gap=${l.layout.gap}px`);
        }
        lines.push('');
      }

      if (bgs.length > 0) {
        const uniqueBgs = [...new Set(bgs.map(b => b.backgroundColor))];
        lines.push(`🎨 Background colors (${uniqueBgs.length}):`);
        for (const c of uniqueBgs.slice(0, 15)) {
          lines.push(`  ${c}`);
        }
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── Start server ───
const transport = new StdioServerTransport();
await server.connect(transport);

// Cleanup on exit
process.on('SIGINT', async () => { await closeBrowser(); process.exit(0); });
process.on('SIGTERM', async () => { await closeBrowser(); process.exit(0); });
