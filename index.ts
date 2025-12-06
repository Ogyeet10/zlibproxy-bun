/**
 * Z-Library reverse proxy with browser verification bypass using Patchright
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "patchright";

const TARGET_DOMAIN = "https://z-library.ec";
const PORT = 9847;
const AUTH_TOKEN = "e3882d5fc0f2cbaa696067c5fdc8457ca8c25cc4b7f56353";

let browser: Browser | null = null;
let context: BrowserContext | null = null;

async function initBrowser(): Promise<BrowserContext> {
  if (!browser) {
    console.log("Launching browser...");
    browser = await chromium.launch({
      headless: true,
    });
  }

  if (!context) {
    console.log("Creating browser context...");
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
  }

  return context;
}

async function waitForBrowserCheck(page: Page): Promise<void> {
  console.log("Waiting for browser check to complete...");

  // Poll the title until we pass the check - handles navigation/context destruction
  const timeout = 30000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const title = await page.title();
      const lowerTitle = title.toLowerCase();

      if (
        !lowerTitle.includes("checking") &&
        (lowerTitle.includes("z-library") || lowerTitle.includes("zlibrary"))
      ) {
        console.log("Browser check passed!");
        return;
      }
    } catch {
      // Context was destroyed due to navigation, wait a bit and retry
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  throw new Error("Browser check timeout");
}

async function fetchWithBrowser(
  targetUrl: string,
  method: string,
  _body?: string,
  _contentType?: string
): Promise<{ html: string; status: number; cookies: string[] }> {
  const ctx = await initBrowser();
  const page = await ctx.newPage();

  try {
    // Navigate and wait for network to be mostly idle
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

    // Check if we hit the browser verification page and wait for it to pass
    await waitForBrowserCheck(page);

    // Give the page a moment to fully render after navigation
    await page.waitForLoadState("networkidle");

    // Snapshot the entire DOM
    const html = await page.content();

    // Get cookies for the response
    const cookies = await ctx.cookies();
    const cookieStrings = cookies.map((c) => `${c.name}=${c.value}`);

    await page.close();

    return { html, status: 200, cookies: cookieStrings };
  } catch (error) {
    await page.close();
    throw error;
  }
}

// Static file extensions that don't need browser rendering
const STATIC_EXTENSIONS = [
  ".js",
  ".css",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".pdf",
  ".zip",
  ".epub",
  ".mobi",
  ".azw3",
  ".djvu",
  ".fb2",
  ".json",
  ".xml",
  ".txt",
  ".map",
  ".webmanifest",
];

// Path patterns that should always go direct (API endpoints, CDN, etc.)
const DIRECT_PATH_PATTERNS = [
  "/cdn-cgi/", // Cloudflare CDN stuff
  "/papi/", // API endpoints
  "/api/", // API endpoints
  "/resources/", // Static resources
  "/sw.js", // Service worker
  "/favicon", // Favicons
  "/img/", // Images directory
  "/fonts/", // Fonts directory
];

function shouldGoDirect(pathname: string): boolean {
  const lower = pathname.toLowerCase();

  // Check extensions
  if (STATIC_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return true;
  }

  // Check path patterns
  if (DIRECT_PATH_PATTERNS.some((pattern) => lower.includes(pattern))) {
    return true;
  }

  return false;
}

async function fetchDirect(targetUrl: string, req: Request): Promise<Response> {
  const headers = new Headers();
  headers.set("Referer", TARGET_DOMAIN + "/");
  headers.set("Origin", TARGET_DOMAIN);
  headers.set("User-Agent", req.headers.get("User-Agent") || "Mozilla/5.0");
  headers.set("Accept-Encoding", "identity");

  const cookie = req.headers.get("Cookie");
  if (cookie) headers.set("Cookie", cookie);

  const contentType = req.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);

  const response = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    redirect: "follow",
  });

  const body = await response.arrayBuffer();

  const responseHeaders = new Headers();
  responseHeaders.set(
    "Content-Type",
    response.headers.get("Content-Type") || "application/octet-stream"
  );
  responseHeaders.set("Content-Length", body.byteLength.toString());
  responseHeaders.set("Access-Control-Allow-Origin", "*");

  const setCookie = response.headers.get("Set-Cookie");
  if (setCookie) responseHeaders.set("Set-Cookie", setCookie);

  return new Response(body, {
    status: response.status,
    headers: responseHeaders,
  });
}

Bun.serve({
  port: PORT,
  idleTimeout: 0, // Max value - effectively infinite for scraping
  async fetch(req) {
    const url = new URL(req.url);

    if (req.headers.get("X-Proxy-Auth") !== AUTH_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    const targetPath = url.pathname + url.search;
    const targetUrl = TARGET_DOMAIN + targetPath;

    try {
      // Static assets & API endpoints - fetch directly without browser
      if (shouldGoDirect(url.pathname)) {
        console.log(`[${req.method}] [DIRECT] ${targetUrl}`);
        return await fetchDirect(targetUrl, req);
      }

      // HTML pages - use browser to bypass verification
      console.log(`[${req.method}] [BROWSER] ${targetUrl}`);

      const contentType = req.headers.get("Content-Type") || undefined;
      const body =
        req.method !== "GET" && req.method !== "HEAD"
          ? await req.text()
          : undefined;

      const { html, status, cookies } = await fetchWithBrowser(
        targetUrl,
        req.method,
        body,
        contentType
      );

      const responseHeaders = new Headers();
      responseHeaders.set("Content-Type", "text/html; charset=utf-8");
      responseHeaders.set("Content-Length", Buffer.byteLength(html).toString());
      responseHeaders.set("Access-Control-Allow-Origin", "*");

      if (cookies.length > 0) {
        responseHeaders.set("Set-Cookie", cookies.join("; "));
      }

      return new Response(html, {
        status,
        headers: responseHeaders,
      });
    } catch (error) {
      console.error("Proxy error:", error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
});

console.log(`Z-Library proxy running on port ${PORT}`);
console.log("Initializing browser...");
initBrowser().then(() => console.log("Browser ready!"));
