/**
 * Simple reverse proxy for Z-Library
 */

const TARGET_DOMAIN = 'https://z-library.ec';
const PORT = 9847;
const AUTH_TOKEN = 'e3882d5fc0f2cbaa696067c5fdc8457ca8c25cc4b7f56353';

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    
    if (req.headers.get('X-Proxy-Auth') !== AUTH_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }
    
    const targetPath = url.pathname + url.search;
    const targetUrl = TARGET_DOMAIN + targetPath;
    
    const headers = new Headers();
    headers.set('Referer', TARGET_DOMAIN + '/');
    headers.set('Origin', TARGET_DOMAIN);
    headers.set('User-Agent', req.headers.get('User-Agent') || 'Mozilla/5.0');
    headers.set('Accept-Encoding', 'identity'); // No compression
    
    const cookie = req.headers.get('Cookie');
    if (cookie) headers.set('Cookie', cookie);
    
    const contentType = req.headers.get('Content-Type');
    if (contentType) headers.set('Content-Type', contentType);
    
    try {
      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
        redirect: 'follow',
      });
      
      // Read the ENTIRE body as an ArrayBuffer first
      const body = await response.arrayBuffer();
      
      const responseHeaders = new Headers();
      // Copy only safe headers, set content-length explicitly
      responseHeaders.set('Content-Type', response.headers.get('Content-Type') || 'text/html');
      responseHeaders.set('Content-Length', body.byteLength.toString());
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      
      // Copy cookies
      const setCookie = response.headers.get('Set-Cookie');
      if (setCookie) responseHeaders.set('Set-Cookie', setCookie);
      
      return new Response(body, {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
});

console.log(`Z-Library proxy running on port ${PORT}`);
