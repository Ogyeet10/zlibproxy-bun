/**
 * Z-Library reverse proxy with browser verification bypass using Patchright
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "patchright";

const TARGET_DOMAIN = "https://z-library.ms";
const TARGET_HOSTNAME = new URL(TARGET_DOMAIN).hostname;
const TARGET_COOKIE_DOMAIN = `.${TARGET_HOSTNAME}`;
const PORT = 9847;
const AUTH_TOKEN = "e3882d5fc0f2cbaa696067c5fdc8457ca8c25cc4b7f56353";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let browserInitPromise: Promise<BrowserContext> | null = null;

// Headers to skip when forwarding (hop-by-hop or problematic)
const SKIP_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "x-proxy-auth", // Our auth header
  "user-agent", // Don't override - let Patchright use its own UA to match browser fingerprint
  // Client hints - these describe the CLIENT's browser, not Patchright's, causing fingerprint mismatch
  "sec-ch-ua",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-full-version",
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-mobile",
  "sec-ch-ua-model",
  "sec-ch-ua-platform",
  "sec-ch-ua-platform-version",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
];

function logIncomingHeaders(req: Request, targetUrl: string): void {
  console.log(`\n--- Incoming Request Headers for ${targetUrl} ---`);
  req.headers.forEach((value, key) => {
    console.log(`  ${key}: ${value}`);
  });
  console.log("-------------------------------------------\n");
}

function getForwardHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};

  req.headers.forEach((value, key) => {
    if (!SKIP_HEADERS.includes(key.toLowerCase())) {
      headers[key] = value;
    }
  });

  // Override/set essential headers for z-library
  headers["Referer"] = TARGET_DOMAIN + "/";
  headers["Origin"] = TARGET_DOMAIN;

  return headers;
}

function getBrowserHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const acceptLanguage = req.headers.get("accept-language");

  if (acceptLanguage) {
    headers["Accept-Language"] = acceptLanguage;
  }

  return headers;
}

function isTargetDomainUrl(requestUrl: string): boolean {
  const parsedUrl = new URL(requestUrl);

  return parsedUrl.hostname === TARGET_HOSTNAME;
}

async function prepareBrowserPage(page: Page, req: Request): Promise<void> {
  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();

    if (!isTargetDomainUrl(requestUrl)) {
      await route.continue();
      return;
    }

    const headers = { ...route.request().headers() };
    headers.referer = TARGET_DOMAIN + "/";
    headers.origin = TARGET_DOMAIN;

    await route.continue({ headers });
  });

  // Only safe page-wide browser headers. Origin/Referer are applied per request
  // above so Cloudflare challenge/session requests pass through untouched.
  await page.setExtraHTTPHeaders(getBrowserHeaders(req));
}

async function initBrowser(): Promise<BrowserContext> {
  // Return existing promise if browser is being initialized
  if (browserInitPromise) {
    return browserInitPromise;
  }

  // Check if existing browser is still connected
  if (browser && context) {
    try {
      // Test if browser is still alive
      await context.pages();
      return context;
    } catch {
      // Browser crashed, reset and recreate
      console.log("Browser crashed, recreating...");
      browser = null;
      context = null;
      browserInitPromise = null;
    }
  }

  // Create new initialization promise
  browserInitPromise = (async () => {
    console.log("Launching browser...");
    browser = await chromium.launch({
      headless: false,
      channel: "chrome",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    console.log("Creating browser context...");
    context = await browser.newContext();

    // Handle browser disconnect
    browser.on("disconnected", () => {
      console.log("Browser disconnected!");
      browser = null;
      context = null;
      browserInitPromise = null;
    });

    return context;
  })();

  return browserInitPromise;
}

function randomDelay(min: number, max: number): Promise<void> {
  const ms = min + Math.random() * (max - min);
  return new Promise((r) => setTimeout(r, ms));
}

// Track whether we've already tried clicking so we don't spam the checkbox.
let turnstileClickAttempted = false;

async function humanMouseMove(
  page: Page,
  targetX: number,
  targetY: number,
): Promise<void> {
  // Move the mouse in a few small stepped increments from a random-ish
  // starting point so the trajectory isn't a single instant jump.
  const startX = targetX - (40 + Math.random() * 80);
  const startY = targetY - (30 + Math.random() * 60);
  const steps = 6 + Math.floor(Math.random() * 6);

  await page.mouse.move(startX, startY);
  await randomDelay(40, 120);

  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    // Ease-in/out so speed isn't linear, plus a little jitter.
    const eased = progress * progress * (3 - 2 * progress);
    const x = startX + (targetX - startX) * eased + (Math.random() - 0.5) * 3;
    const y = startY + (targetY - startY) * eased + (Math.random() - 0.5) * 3;
    await page.mouse.move(x, y);
    await randomDelay(15, 45);
  }

  await page.mouse.move(targetX, targetY);
}

async function clickTurnstileCheckbox(page: Page): Promise<void> {
  if (turnstileClickAttempted) {
    return;
  }

  // The "Verify you are human" checkbox lives inside the Cloudflare
  // Turnstile iframe (challenges.cloudflare.com). Find that frame and click it.
  for (const frame of page.frames()) {
    let frameUrl = "";
    try {
      frameUrl = frame.url();
    } catch {
      continue;
    }

    if (!frameUrl.includes("challenges.cloudflare.com")) {
      continue;
    }

    const checkbox = frame.locator(
      'input[type="checkbox"], #challenge-stage, .cb-lb',
    );

    try {
      if ((await checkbox.count()) === 0) {
        return;
      }

      const target = checkbox.first();
      // Wait for it to actually be visible/stable before touching it.
      await target.waitFor({ state: "visible", timeout: 3000 });

      // Humans don't click the instant the box renders.
      await randomDelay(900, 2200);

      const box = await target.boundingBox();
      if (!box) {
        return;
      }

      // Aim for a slightly off-center point inside the checkbox.
      const targetX = box.x + box.width * (0.35 + Math.random() * 0.3);
      const targetY = box.y + box.height * (0.35 + Math.random() * 0.3);

      turnstileClickAttempted = true;

      await humanMouseMove(page, targetX, targetY);
      await randomDelay(120, 320);
      await page.mouse.down();
      await randomDelay(50, 140);
      await page.mouse.up();

      console.log("  -> Clicked Turnstile 'Verify you are human' checkbox");
      return;
    } catch {
      // Checkbox may not be interactable yet; retried by the polling loop.
    }
  }
}

async function isCloudflareChallengeActive(
  page: Page,
  title: string,
): Promise<boolean> {
  const lowerTitle = title.toLowerCase();

  if (
    lowerTitle.includes("just a moment") ||
    lowerTitle.includes("checking") ||
    lowerTitle.includes("security verification") ||
    lowerTitle.startsWith("loading http")
  ) {
    return true;
  }

  try {
    const bodyText = await page.locator("body").innerText({ timeout: 1000 });
    const lowerBodyText = bodyText.toLowerCase();

    return (
      lowerBodyText.includes("verify you are human") ||
      lowerBodyText.includes("performing security verification") ||
      lowerBodyText.includes("checking if the site connection is secure") ||
      lowerBodyText.includes("needs to review the security of your connection")
    );
  } catch {
    return true;
  }
}

function shouldRestoreRequestedUrl(currentUrl: string, requestedUrl: string): boolean {
  const current = new URL(currentUrl);
  const requested = new URL(requestedUrl);

  return (
    current.origin === requested.origin &&
    current.pathname === "/" &&
    current.search === "" &&
    (requested.pathname !== "/" || requested.search !== "")
  );
}

async function waitForBrowserCheck(
  page: Page,
  requestedUrl: string,
): Promise<void> {
  console.log("Waiting for browser check to complete...");

  // Fresh check for this navigation - allow one click attempt.
  turnstileClickAttempted = false;
  let restoredRequestedUrl = false;

  // Poll the title until we pass the check - handles navigation/context destruction
  const timeout = 30000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const title = await page.title();
      console.log(`  -> Page title: "${title}"`);

      if (!(await isCloudflareChallengeActive(page, title))) {
        if (
          !restoredRequestedUrl &&
          shouldRestoreRequestedUrl(page.url(), requestedUrl)
        ) {
          restoredRequestedUrl = true;
          turnstileClickAttempted = false;
          console.log(`  -> Restoring requested URL: ${requestedUrl}`);
          await page.goto(requestedUrl, { waitUntil: "domcontentloaded" });
          continue;
        }

        console.log("Browser check passed!");
        return;
      }
    } catch {
      // Context was destroyed due to navigation, wait a bit and retry
    }

    // If the verification checkbox is shown, click it.
    await clickTurnstileCheckbox(page).catch(() => {});

    await new Promise((r) => setTimeout(r, 250));
  }

  // Take screenshot on timeout for debugging
  try {
    const timestamp = Date.now();
    const screenshotPath = `./timeout-${timestamp}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Timeout screenshot saved to: ${screenshotPath}`);

    const html = await page.content();
    const htmlPath = `./timeout-${timestamp}.html`;
    await Bun.write(htmlPath, html);
    console.log(`Timeout HTML saved to: ${htmlPath}`);
  } catch (e) {
    console.log("Failed to capture timeout debug info:", e);
  }

  throw new Error("Browser check timeout");
}

async function fetchWithBrowser(
  targetUrl: string,
  req: Request,
): Promise<{ html: string; status: number; cookies: string[] }> {
  const ctx = await initBrowser();
  const page = await ctx.newPage();

  try {
    await prepareBrowserPage(page, req);

    // Parse and set cookies on the browser context - only z-library related ones
    const cookieHeader = req.headers.get("cookie");
    if (cookieHeader) {
      // Only forward z-library auth cookies
      const ZLIB_COOKIES = ["remix_userid", "remix_userkey"];

      const cookiesToSet = cookieHeader
        .split(";")
        .map((c) => {
          const parts = c.trim().split("=");
          const name = parts[0]?.trim() || "";
          const value = parts.slice(1).join("=").trim();
          return {
            name,
            value,
            domain: TARGET_COOKIE_DOMAIN,
            path: "/",
          };
        })
        .filter(
          (c) =>
            c.name !== "" && c.value !== "" && ZLIB_COOKIES.includes(c.name),
        );

      if (cookiesToSet.length > 0) {
        await ctx.addCookies(cookiesToSet);
        console.log(
          `  -> Set ${cookiesToSet.length} cookies on browser context`,
        );
      }
    }

    // Navigate and wait for network to be mostly idle
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

    // Check if we hit the browser verification page and wait for it to pass
    await waitForBrowserCheck(page, targetUrl);

    // Give the page a moment to fully render after navigation
    await page.waitForLoadState("networkidle");

    // Snapshot the entire DOM
    const html = await page.content();

    // Get cookies for the response
    const cookies = await ctx.cookies();
    const cookieStrings = cookies.map((c) => `${c.name}=${c.value}`);

    return { html, status: 200, cookies: cookieStrings };
  } finally {
    // Always close the page, even on error
    await page.close().catch(() => {});
  }
}

async function downloadWithBrowser(
  targetUrl: string,
  req: Request,
): Promise<Response> {
  const ctx = await initBrowser();
  const page = await ctx.newPage();

  try {
    await prepareBrowserPage(page, req);

    // Parse and set cookies on the browser context
    const cookieHeader = req.headers.get("cookie");
    if (cookieHeader) {
      const ZLIB_COOKIES = ["remix_userid", "remix_userkey"];

      const cookiesToSet = cookieHeader
        .split(";")
        .map((c) => {
          const parts = c.trim().split("=");
          const name = parts[0]?.trim() || "";
          const value = parts.slice(1).join("=").trim();
          return {
            name,
            value,
            domain: TARGET_COOKIE_DOMAIN,
            path: "/",
          };
        })
        .filter(
          (c) =>
            c.name !== "" && c.value !== "" && ZLIB_COOKIES.includes(c.name),
        );

      if (cookiesToSet.length > 0) {
        await ctx.addCookies(cookiesToSet);
        console.log(
          `  -> Set ${cookiesToSet.length} cookies on browser context`,
        );
      }
    }

    // Set up download handling
    const downloadPromise = page.waitForEvent("download", { timeout: 60000 });

    // Navigate to the download URL - this will throw if download starts (which is expected)
    console.log(`  -> Navigating to download URL...`);
    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    } catch (e: any) {
      // "Download is starting" error is expected - ignore it
      if (!e.message?.includes("Download is starting")) {
        throw e;
      }
      console.log(`  -> Download triggered (goto threw as expected)`);
    }

    // Wait for the download to start
    console.log(`  -> Waiting for download to start...`);
    const download = await downloadPromise;

    console.log(`  -> Download started: ${download.suggestedFilename()}`);

    // Get the download as a readable stream
    const stream = await download.createReadStream();
    if (!stream) {
      throw new Error("Failed to get download stream");
    }

    // Read the stream into a buffer
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const fileBuffer = Buffer.concat(chunks);

    console.log(`  -> Download complete: ${fileBuffer.length} bytes`);

    // Determine content type from filename
    const filename = download.suggestedFilename();
    let contentType = "application/octet-stream";
    if (filename.endsWith(".epub")) contentType = "application/epub+zip";
    else if (filename.endsWith(".pdf")) contentType = "application/pdf";
    else if (filename.endsWith(".mobi"))
      contentType = "application/x-mobipocket-ebook";
    else if (filename.endsWith(".azw3"))
      contentType = "application/vnd.amazon.ebook";
    else if (filename.endsWith(".fb2"))
      contentType = "application/x-fictionbook+xml";
    else if (filename.endsWith(".djvu")) contentType = "image/vnd.djvu";
    else if (filename.endsWith(".zip")) contentType = "application/zip";

    const responseHeaders = new Headers();
    responseHeaders.set("Content-Type", contentType);
    responseHeaders.set("Content-Length", fileBuffer.length.toString());
    responseHeaders.set(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    responseHeaders.set("Access-Control-Allow-Origin", "*");

    return new Response(fileBuffer, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("Download error:", error);

    // Check if we got a page instead of a download (e.g., limit exceeded)
    try {
      const html = await page.content();
      const title = await page.title();
      console.log(`  -> Page title instead of download: "${title}"`);

      // Return the HTML page so client can see the error
      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch {
      throw error;
    }
  } finally {
    await page.close().catch(() => {});
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
  "/rpc.php", // RPC endpoint
  "/resources/", // Static resources
  "/sw.js", // Service worker
  "/favicon", // Favicons
  "/img/", // Images directory
  "/fonts/", // Fonts directory
  // "/dl/" removed - needs browser to bypass Cloudflare
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

function replaceAllText(
  text: string,
  search: string,
  replacement: string,
): string {
  return text.split(search).join(replacement);
}

function normalizeHtmlForProxy(html: string, proxyOrigin: string): string {
  // New Z-Library pages use declarative Shadow DOM:
  // <template shadowrootmode="open">...</template>
  // Legacy app parsing expects these nodes in the light DOM.
  const shadowTemplatePattern =
    /<template\b(?=[^>]*\bshadowrootmode\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))[^>]*>([\s\S]*?)<\/template>/gi;

  let normalized = html.replace(shadowTemplatePattern, "$1");
  normalized = replaceAllText(normalized, TARGET_DOMAIN, proxyOrigin);
  normalized = replaceAllText(
    normalized,
    TARGET_DOMAIN.replace("https://", "//"),
    proxyOrigin,
  );
  normalized = replaceAllText(
    normalized,
    TARGET_DOMAIN.replace("https://", "http://"),
    proxyOrigin,
  );

  return normalized;
}

async function fetchDirect(targetUrl: string, req: Request): Promise<Response> {
  const headers = getForwardHeaders(req);
  headers["accept-encoding"] = "identity"; // No compression for direct

  // Extract cookie value and ensure we send it with proper casing
  const cookieValue = req.headers.get("cookie") || req.headers.get("Cookie");

  // Remove any existing cookie variations from headers
  delete headers["cookie"];
  delete headers["Cookie"];
  delete headers["COOKIE"];

  // Force set Cookie with capital C (some servers are picky)
  if (cookieValue) {
    headers["Cookie"] = cookieValue;
    console.log(`  -> Forcing Cookie header: ${cookieValue}`);
  }

  console.log(`  -> Forwarding headers to ${targetUrl}:`);
  Object.entries(headers).forEach(([key, value]) => {
    console.log(`     ${key}: ${value}`);
  });

  // Use array format to bypass Headers normalization and send raw header name
  const headersList: [string, string][] = Object.entries(headers);

  console.log(`  -> Raw headers list being sent:`);
  headersList.forEach(([key, value]) => {
    console.log(`     [${key}]: ${value}`);
  });

  const response = await fetch(targetUrl, {
    method: req.method,
    headers: headersList,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    redirect: "follow",
  });

  const body = await response.arrayBuffer();

  const responseHeaders = new Headers();
  responseHeaders.set(
    "Content-Type",
    response.headers.get("Content-Type") || "application/octet-stream",
  );
  responseHeaders.set("Content-Length", body.byteLength.toString());
  responseHeaders.set("Access-Control-Allow-Origin", "*");

  // Forward ALL Set-Cookie headers (there can be multiple)
  const setCookies = response.headers.getSetCookie();
  setCookies.forEach((cookie) => {
    responseHeaders.append("Set-Cookie", cookie);
  });

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

    // if (req.headers.get("X-Proxy-Auth") !== AUTH_TOKEN) {
    //   return new Response("Unauthorized", { status: 401 });
    // }

    const targetPath = url.pathname + url.search;
    const targetUrl = TARGET_DOMAIN + targetPath;

    try {
      // Log all incoming headers for debugging
      console.log(`\n--- Incoming Headers ---`);
      req.headers.forEach((value, key) => {
        console.log(`  ${key}: ${value}`);
      });
      console.log(`------------------------\n`);

      // Static assets & API endpoints - fetch directly without browser
      if (shouldGoDirect(url.pathname)) {
        console.log(`[${req.method}] [DIRECT] ${targetUrl}`);
        return await fetchDirect(targetUrl, req);
      }

      // Download URLs - use browser to bypass Cloudflare and handle download
      if (url.pathname.toLowerCase().includes("/dl/")) {
        console.log(`[${req.method}] [DOWNLOAD] ${targetUrl}`);
        return await downloadWithBrowser(targetUrl, req);
      }

      // HTML pages - use browser to bypass verification
      console.log(`[${req.method}] [BROWSER] ${targetUrl}`);

      const { html, status, cookies } = await fetchWithBrowser(targetUrl, req);
      const normalizedHtml = normalizeHtmlForProxy(html, url.origin);

      const responseHeaders = new Headers();
      responseHeaders.set("Content-Type", "text/html; charset=utf-8");
      responseHeaders.set(
        "Content-Length",
        Buffer.byteLength(normalizedHtml).toString(),
      );
      responseHeaders.set("Access-Control-Allow-Origin", "*");

      if (cookies.length > 0) {
        responseHeaders.set("Set-Cookie", cookies.join("; "));
      }

      return new Response(normalizedHtml, {
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

async function cleanup() {
  console.log("\nShutting down...");
  if (context) {
    await context.close().catch(() => {});
    context = null;
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  console.log("Browser closed. Goodbye!");
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("SIGHUP", cleanup);

console.log(`Z-Library proxy running on port ${PORT}`);
console.log("Initializing browser...");
initBrowser().then(() => console.log("Browser ready!"));
