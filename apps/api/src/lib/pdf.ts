import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Browser } from 'playwright-core';
import { AppError } from './errors.js';

/**
 * Server-side PDF (clause 65) by printing the same HTML the documents already render, so Arabic shaping and
 * right-to-left layout come out exactly as in the browser. Needs a Chromium-based browser on the server:
 * PDF_BROWSER_PATH, or one found at a usual location (Microsoft Edge ships with Windows).
 */
const CANDIDATES = [
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

export function pdfBrowserPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.PDF_BROWSER_PATH) return existsSync(env.PDF_BROWSER_PATH) ? env.PDF_BROWSER_PATH : null;
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

let browser: Promise<Browser> | null = null;
let active = 0;
const queue: (() => void)[] = [];
const MAX_PARALLEL = 2;

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => queue.push(r));
  active++;
  try { return await fn(); } finally { active--; queue.shift()?.(); }
}

async function getBrowser(): Promise<Browser> {
  const path = pdfBrowserPath();
  if (!path) throw new AppError('PDF_NOT_AVAILABLE', 501);
  if (!browser) {
    const { chromium } = await import('playwright-core');
    browser = chromium.launch({ executablePath: path, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    browser.then((b) => b.on('disconnected', () => { browser = null; })).catch(() => { browser = null; });
  }
  return browser;
}

/** Prints HTML to an A4 PDF. Pages are isolated: no network access, no scripts. */
export async function htmlToPdf(html: string): Promise<Buffer> {
  return slot(async () => {
    const b = await getBrowser();
    const ctx = await b.newContext({ javaScriptEnabled: false, offline: true });
    try {
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
    } finally {
      await ctx.close();
    }
  });
}

export async function closePdf() {
  const b = browser;
  browser = null;
  if (b) await (await b.catch(() => null))?.close();
}

let fontCss: string | null = null;
/** The Arabic font embedded in the page, so a server without Arabic fonts still prints correctly. */
export function embeddedFontCss(): string {
  if (fontCss !== null) return fontCss;
  try {
    const req = createRequire(import.meta.url);
    const face = (w: number) => {
      const file = req.resolve(`@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-${w}-normal.woff2`);
      return `@font-face{font-family:'Plex Arabic';font-weight:${w};src:url(data:font/woff2;base64,${readFileSync(file).toString('base64')}) format('woff2')}`;
    };
    fontCss = face(400) + face(700);
  } catch {
    fontCss = '';
  }
  return fontCss;
}
