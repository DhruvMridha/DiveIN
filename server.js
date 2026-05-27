/**
 * DiveIn Backend — server.js
 * Deploy on Northflank (Node 18+)
 * Endpoints:
 *   GET /              — health check
 *   GET /proxy?url=    — CORS proxy (returns raw page content)
 *   GET /extract?url=  — Extract all video sources from any page
 *   GET /servers       — List supported streaming servers
 */

const express      = require('express');
const cors         = require('cors');
const axios        = require('axios');
const cheerio      = require('cheerio');
const rateLimit    = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','OPTIONS'] }));
app.use(express.json());

// Rate limiting — 200 requests per minute per IP
app.use(rateLimit({ windowMs: 60_000, max: 200, standardHeaders: true, legacyHeaders: false }));

// ── Browser-like headers ─────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

function browserHeaders(url) {
  let origin = 'https://google.com';
  try { const u = new URL(url); origin = u.origin; } catch {}
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': origin + '/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Upgrade-Insecure-Requests': '1',
    'DNT': '1',
  };
}

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service:   'DiveIn Backend',
    version:   '1.0.0',
    status:    'online',
    endpoints: ['/proxy', '/extract', '/servers'],
  });
});

// ── CORS Proxy ───────────────────────────────────────────────────────────────
// GET /proxy?url=<encoded>
// Fetches any URL server-side so frontend avoids CORS
app.get('/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });

  let parsed;
  try { parsed = new URL(url); }
  catch { return res.status(400).json({ error: 'invalid url' }); }

  try {
    const resp = await axios.get(url, {
      headers:      browserHeaders(url),
      timeout:      20_000,
      maxRedirects: 6,
      decompress:   true,
      responseType: 'arraybuffer',
    });

    const ct = resp.headers['content-type'] || 'text/html; charset=utf-8';
    res.set({ 'Content-Type': ct, 'X-Proxied-By': 'DiveIn/1.0', 'X-Source-Url': url });
    res.send(resp.data);

  } catch (e) {
    const status = e.response?.status || 500;
    res.status(status).json({ error: e.message, url, httpStatus: e.response?.status });
  }
});

// ── Video Extractor ──────────────────────────────────────────────────────────
// GET /extract?url=<encoded>
// Parses any page and returns all embeddable video sources
app.get('/extract', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });

  let parsed;
  try { parsed = new URL(url); }
  catch { return res.status(400).json({ error: 'invalid url' }); }

  try {
    const resp = await axios.get(url, {
      headers:      browserHeaders(url),
      timeout:      25_000,
      maxRedirects: 6,
      decompress:   true,
    });

    const html   = typeof resp.data === 'string' ? resp.data : resp.data.toString('utf-8');
    const $      = cheerio.load(html);
    const origin = parsed.origin;
    const seen   = new Set();
    const sources = [];

    const resolve = (src) => {
      if (!src) return null;
      src = src.trim();
      if (src.startsWith('//'))    return 'https:' + src;
      if (src.startsWith('/'))     return origin + src;
      if (src.startsWith('http')) return src;
      return null;
    };

    const add = (rawSrc, type = 'iframe') => {
      const src = resolve(rawSrc);
      if (!src || seen.has(src) || isJunk(src)) return;
      seen.add(src);
      const server = detectServer(src);
      const embed  = toEmbedUrl(src);
      sources.push({ type, src, embed, server });
    };

    // 1. <iframe src> / data-src / data-lazy-src
    $('iframe').each((_, el) => {
      const src = $(el).attr('src') ||
                  $(el).attr('data-src') ||
                  $(el).attr('data-lazy-src') ||
                  $(el).attr('data-original');
      add(src, 'iframe');
    });

    // 2. <video> and <source>
    $('video[src], source[src]').each((_, el) => {
      const src = $(el).attr('src');
      add(src, 'video');
    });

    // 3. data-* attributes on any element
    const dataAttrs = ['data-video', 'data-src', 'data-stream', 'data-source',
                       'data-embed', 'data-player', 'data-url', 'data-file'];
    $(dataAttrs.map(a => `[${a}]`).join(',')).each((_, el) => {
      for (const attr of dataAttrs) {
        const val = $(el).attr(attr);
        if (val && (val.startsWith('http') || val.startsWith('//'))) add(val, 'iframe');
      }
    });

    // 4. Script-embedded video patterns
    const scriptPatterns = [
      /(?:file|src|url|source|videoUrl|streamUrl|hlsUrl|m3u8|mp4Url)\s*[:=]\s*["']([^"']{15,}\.(?:m3u8|mp4|webm)[^"']*)/gi,
      /"(?:hls|dash|mp4)"\s*:\s*["']([^"']+)/gi,
      /file\s*:\s*["']([^"']+(?:m3u8|mp4)[^"']*)/gi,
      /source\s+src=["']([^"']+\.m3u8[^"']*)/gi,
      /jwplayer\([^)]*\)\.setup\([^}]*file\s*:\s*["']([^"']+)/gi,
    ];

    for (const pattern of scriptPatterns) {
      const re = new RegExp(pattern.source, pattern.flags);
      let m;
      while ((m = re.exec(html)) !== null) {
        const s = m[1].trim();
        if (s && !seen.has(s) && !isJunk(s)) {
          seen.add(s);
          const t = s.includes('.m3u8') ? 'hls' : 'video';
          sources.push({ type: t, src: s, embed: s, server: 'script' });
        }
      }
    }

    // 5. Look for JSON blobs with video data (common in anime sites)
    const jsonPatterns = [
      /"(?:sources?|videos?)"\s*:\s*\[([^\]]+)\]/g,
      /episodes?\s*:\s*\[([^\]]+)\]/gi,
    ];
    for (const pattern of jsonPatterns) {
      const re = new RegExp(pattern.source, pattern.flags);
      let m;
      while ((m = re.exec(html)) !== null) {
        const chunk = m[1];
        const urlsInChunk = chunk.match(/https?:\/\/[^"'\s,}]+/g) || [];
        for (const u of urlsInChunk) {
          if (!isJunk(u) && !seen.has(u)) {
            seen.add(u);
            sources.push({ type: 'iframe', src: u, embed: toEmbedUrl(u), server: detectServer(u) });
          }
        }
      }
    }

    res.json({
      url,
      pageTitle: $('title').text().trim(),
      count:     sources.length,
      sources,
    });

  } catch (e) {
    res.status(500).json({ error: e.message, url });
  }
});

// ── Supported servers list ────────────────────────────────────────────────────
app.get('/servers', (req, res) => {
  res.json({ servers: SERVERS });
});

const SERVERS = [
  { name: 'YouTube',     id: 'youtube',    patterns: ['youtube.com', 'youtu.be'],                                 color: '#ff0000' },
  { name: 'Vidplay',     id: 'vidplay',    patterns: ['vidplay.online', 'vidplay.site', 'vidstream.pro'],         color: '#00aff0' },
  { name: 'MyCloud',     id: 'mycloud',    patterns: ['mcloud.to', 'mycloud.to', 'mcloud.bz'],                   color: '#4a90d9' },
  { name: 'Filemoon',    id: 'filemoon',   patterns: ['filemoon.sx', 'filemoon.in', 'filemoon.to'],               color: '#f5a623' },
  { name: 'Mp4upload',   id: 'mp4upload',  patterns: ['mp4upload.com'],                                          color: '#7ed321' },
  { name: 'Streamtape',  id: 'streamtape', patterns: ['streamtape.com', 'streamtape.to', 'streamtape.net'],       color: '#e85d04' },
  { name: 'Vidsrc',      id: 'vidsrc',     patterns: ['vidsrc.to', 'vidsrc.me', 'vidsrc.stream', 'vidsrc.xyz'],  color: '#9b59b6' },
  { name: 'Doodstream',  id: 'dood',       patterns: ['dood.watch', 'doodstream.com', 'ds2play.com', 'dood.la'], color: '#e74c3c' },
  { name: 'Mixdrop',     id: 'mixdrop',    patterns: ['mixdrop.ag', 'mixdrop.bz', 'mixdrop.co'],                 color: '#16a085' },
  { name: 'Streamwish',  id: 'streamwish', patterns: ['streamwish.to', 'streamwish.com', 'wishembed.net'],        color: '#2980b9' },
  { name: 'Uqload',      id: 'uqload',     patterns: ['uqload.co', 'uqload.com', 'uqload.to'],                   color: '#d35400' },
  { name: 'Upstream',    id: 'upstream',   patterns: ['upstream.to', 'upstream.link'],                           color: '#8e44ad' },
  { name: 'Omega',       id: 'omega',      patterns: ['omega.to', 'omegaplay.to'],                               color: '#27ae60' },
  { name: 'Google Drive',id: 'gdrive',     patterns: ['drive.google.com'],                                       color: '#4285f4' },
  { name: 'Direct MP4',  id: 'direct',     patterns: ['.mp4', '.webm', '.m3u8', '.ogg', '.mkv'],                 color: '#95a5a6' },
];

function detectServer(url) {
  const u = url.toLowerCase();
  for (const s of SERVERS) {
    if (s.patterns.some(p => u.includes(p))) return s.name;
  }
  return 'Unknown';
}

function toEmbedUrl(url) {
  const u = url.toLowerCase();

  // mp4upload: /ID or /embed-ID.html  →  /embed-ID.html
  if (u.includes('mp4upload.com')) {
    const m = url.match(/mp4upload\.com\/(?:embed-)?([a-z0-9]+)(?:\.html)?/i);
    if (m) return `https://www.mp4upload.com/embed-${m[1]}.html`;
  }

  // Streamtape: /v/ or /f/  →  /e/
  if (u.includes('streamtape')) {
    return url.replace(/\/(v|f)\//, '/e/');
  }

  // Google Drive: view/file → /preview
  if (u.includes('drive.google.com/file/d/')) {
    const m = url.match(/\/file\/d\/([^/?#]+)/);
    if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  }

  // Doodstream: /d/ → /e/
  if (u.includes('dood') || u.includes('ds2play')) {
    return url.replace(/\/d\//, '/e/');
  }

  // Uqload: bare ID → embed
  if (u.includes('uqload')) {
    const m = url.match(/uqload\.[a-z]+\/(?:embed-)?([a-z0-9]+)(?:\.html)?/i);
    if (m) return `https://uqload.co/embed-${m[1]}.html`;
  }

  return url; // already an embed or direct
}

function isJunk(url) {
  const junk = [
    'google.com/recaptcha', 'googletagmanager', 'analytics.', 'facebook.com',
    'twitter.com', 'doubleclick.net', 'googlesyndication', 'adsbygoogle',
    'fonts.googleapis', 'maps.googleapis', 'gstatic.com/firebasejs',
  ];
  return junk.some(j => url.includes(j));
}

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 DiveIn backend running on :${PORT}`);
  console.log(`   /proxy   — CORS proxy`);
  console.log(`   /extract — video extractor`);
  console.log(`   /servers — server list`);
});
