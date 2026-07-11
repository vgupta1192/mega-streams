/**
 *
 * Providers:
 *   • MovieBox   (mb)  – Cloudflare Worker
 *   • NetMirror  (nm)  – Proxied HLS
 *   • DoFlix     (df)  – Hindi Direct
 *   • HDHub4u    (hh)  – Direct API
 *   • 4KHDHub   (kh)  – Direct API
 *   • KMmovies   (km)  – Hindi Proxied
 *   • AnimeWorld (aw)  – Anime HLS
 *   • HindMovie  (hm)  – HindMovie API
 *   • FilmyFly   (ff)  – Direct Downloads
 *
 */

'use strict';

// Force the low-memory-safe UNDICI_NO_WASM behavior unless explicitly disabled.
process.env.UNDICI_NO_WASM = process.env.UNDICI_NO_WASM || '1';

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const http    = require('http');
const https   = require('https');
// Prefer a pure-JS fetch implementation to avoid Node's built-in undici WASM path
let fetch;
try {
    // node-fetch v2 supports CommonJS require
    fetch = require('node-fetch');
    // Prefer node-fetch as the global fetch to avoid undici/wasm on low-memory hosts
    try { globalThis.fetch = fetch; } catch (e) { /* ignore */ }
} catch (e) {
    // fallback to global fetch (Node 18+). If undici causes WASM OOM, install node-fetch
    fetch = global.fetch;
}
const { URL } = require('url');
const zlib    = require('zlib');
const path    = require('path');
const os      = require('os');

// ── Runtime Stats ─────────────────────────────────────────────────────────────
const SERVER_START = Date.now();
let totalRequests    = 0;
let totalSearches    = 0;
let activeRequests   = 0;
const requestHistory = [];
let _reqThisSec      = 0;
setInterval(() => {
    requestHistory.push(_reqThisSec);
    if (requestHistory.length > 60) requestHistory.shift();
    _reqThisSec = 0;
}, 1000);

// ── Providers ────────────────────────────────────────────────────────────────
const moviebox    = require('./providers/moviebox');
const netmirror   = require('./providers/netmirror');
const doflix      = require('./providers/doflix');
const hdhubapi    = require('./providers/hdhubapi');
const kmmovies    = require('./providers/kmmovies');
const animeworld  = require('./providers/animeworld');
const hindmovie   = require('./providers/hindmovie');
const filmyfly    = require('./providers/filmyfly');

const PORT        = parseInt(process.env.PORT || '7860');
const PUBLIC_BASE = (process.env.PUBLIC_BASE
    ? process.env.PUBLIC_BASE
    : process.env.SPACE_HOST
        ? `https://${process.env.SPACE_HOST}`
        : `http://localhost:${PORT}`
).replace(/\/$/, '');

const PUBLIC_PATH = (() => {
    try {
        return new URL(PUBLIC_BASE).pathname.replace(/\/$/, '') || '';
    } catch {
        return '';
    }
})();

console.log(`[Startup] PUBLIC_BASE=${PUBLIC_BASE} PUBLIC_PATH=${PUBLIC_PATH || '/'} UNDICI_NO_WASM=${process.env.UNDICI_NO_WASM}`);

// ==================== LOGGING ====================
const LOG_BUFFER_MAX = 500;
const logBuffer = [];
const originalConsole = { ...console };

function addLog(level, ...args) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const entry = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
    originalConsole[level](...args);
}
console.log   = (...a) => addLog('log',   ...a);
console.error = (...a) => addLog('error', ...a);
console.warn  = (...a) => addLog('warn',  ...a);
console.info  = (...a) => addLog('info',  ...a);
console.debug = (...a) => addLog('debug', ...a);

// ==================== LRU CACHE ====================
class LRUCache {
    constructor(maxSize, ttlMs) {
        this.maxSize = maxSize;
        this.ttlMs   = ttlMs;
        this.map     = new Map();
    }
    get(key) {
        const e = this.map.get(key);
        if (!e) return undefined;
        if (Date.now() - e.ts > this.ttlMs) { this.map.delete(key); return undefined; }
        this.map.delete(key);
        this.map.set(key, e);
        return e.val;
    }
    set(key, val) {
        if (this.map.has(key)) this.map.delete(key);
        else if (this.map.size >= this.maxSize) {
            this.map.delete(this.map.keys().next().value);
        }
        this.map.set(key, { val, ts: Date.now() });
    }
    has(key) { return this.get(key) !== undefined; }
    size() { return this.map.size; }
}

const tmdbCache     = new LRUCache(5000, 24 * 3600 * 1000);
const provCache     = new LRUCache(1200, 30 * 60 * 1000);
const m3u8Cache     = new LRUCache(600,  4  * 60 * 1000);
const segmentCache  = new LRUCache(2000, 8  * 60 * 1000);
const etag304Cache  = new LRUCache(2000, 10 * 60 * 1000);

// Cache analytics
let cacheHits = 0;
let cacheMisses = 0;

// ==================== API MANAGEMENT SYSTEM ====================
// Request queue for high-traffic handling
const requestQueue = [];
const MAX_QUEUE_SIZE = 2000;
let isProcessingQueue = false;

// Provider health tracking (initialized after ALL_PROVIDERS)
let providerHealth = {};

// Circuit breaker configuration
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_TIMEOUT_MS = 30000; // 30 seconds

function checkProviderHealth(providerId) {
    const health = providerHealth[providerId];
    if (!health) return true;

    // Check if circuit should be reset
    if (health.isCircuitOpen && Date.now() - health.circuitOpenTime > CIRCUIT_TIMEOUT_MS) {
        health.isCircuitOpen = false;
        health.circuitOpenTime = null;
        console.log(`[CircuitBreaker] ${providerId} - Resetting after timeout`);
        return true;
    }

    return !health.isCircuitOpen;
}

function recordProviderSuccess(providerId, responseTime) {
    const health = providerHealth[providerId];
    if (!health) return;

    health.successes++;
    health.lastSuccess = Date.now();
    health.isCircuitOpen = false;
    health.circuitOpenTime = null;

    // Running average of response time
    health.avgResponseTime = health.avgResponseTime === 0
        ? responseTime
        : (health.avgResponseTime * 0.7 + responseTime * 0.3);
}

function recordProviderFailure(providerId) {
    const health = providerHealth[providerId];
    if (!health) return;

    health.failures++;
    health.lastFailure = Date.now();

    if (health.failures >= CIRCUIT_FAILURE_THRESHOLD) {
        health.isCircuitOpen = true;
        health.circuitOpenTime = Date.now();
        console.log(`[CircuitBreaker] ${providerId} - Circuit OPEN after ${health.failures} failures`);
    }
}

// Request priority queue
function enqueueRequest(request, priority = 'normal') {
    if (requestQueue.length >= MAX_QUEUE_SIZE) {
        console.warn('[API] Queue full, dropping lowest priority request');
        // Remove lowest priority
        const lowPriIndex = requestQueue.findIndex(r => r.priority === 'background');
        if (lowPriIndex >= 0) {
            requestQueue.splice(lowPriIndex, 1);
        } else {
            return false; // Queue still full
        }
    }

    const priorityValue = priority === 'critical' ? 0 : priority === 'high' ? 1 : priority === 'normal' ? 2 : 3;
    requestQueue.push({ ...request, priority: priorityValue, queuedAt: Date.now() });

    // Sort by priority
    requestQueue.sort((a, b) => a.priority - b.priority);

    return true;
}

function getQueuedRequest() {
    return requestQueue.shift();
}

// Process queued requests
async function processQueue() {
    if (isProcessingQueue || requestQueue.length === 0) return;
    isProcessingQueue = true;

    while (requestQueue.length > 0) {
        const req = getQueuedRequest();
        if (!req) break;

        try {
            await req.handler();
        } catch (err) {
            console.error(`[Queue] Error processing request: ${err.message}`);
        }

        // Small delay to prevent CPU spike
        await new Promise(r => setTimeout(r, 10));
    }

    isProcessingQueue = false;
}

// ==================== KEEP-ALIVE AGENTS ====================
// Lower socket counts for shared/low-memory seedboxes
const httpAgent = new http.Agent({
    keepAlive: true, maxSockets: 128, maxFreeSockets: 64,
    keepAliveMsecs: 15000, timeout: 60000, scheduling: 'fifo'
});
const httpsAgent = new https.Agent({
    keepAlive: true, maxSockets: 128, maxFreeSockets: 64,
    keepAliveMsecs: 15000, timeout: 60000,
    rejectUnauthorized: false, scheduling: 'fifo'
});

// Dedicated agent for heavy providers (reduced)
const hdHubAgent = new https.Agent({
    keepAlive: true, maxSockets: 64, maxFreeSockets: 16,
    keepAliveMsecs: 15000, timeout: 90000, rejectUnauthorized: false
});

// ==================== PROVIDER CONFIG ====================
const ALL_PROVIDERS = [
    { id: 'mb',  name: 'MovieBox',   desc: 'Cloudflare Worker · 1080p',    emoji: '📥', priority: 1 },
    { id: 'nm',  name: 'NetMirror',  desc: 'Netflix/Prime/Disney+ HLS',   emoji: '🪞', priority: 2 },
    { id: 'df',  name: 'DoFlix',     desc: 'Hindi Dubbed Direct',          emoji: '🎬', priority: 3 },
    { id: 'hh',  name: 'HDHub4u',    desc: 'Direct API · Hindi',           emoji: '🔵', priority: 4 },
    { id: 'kh',  name: '4KHDHub',    desc: 'Direct API · 4K',              emoji: '🟣', priority: 5 },
    { id: 'km',  name: 'KMmovies',   desc: 'Hindi Proxied · MKV',          emoji: '🟡', priority: 6 },
    { id: 'aw',  name: 'AnimeWorld', desc: 'Anime HLS · Subbed/Dubbed',    emoji: '🌸', priority: 7 },
    { id: 'hm',  name: 'HindMovie',  desc: 'Hindi Movies & Series · 1080p', emoji: '🎞️', priority: 8 },
    { id: 'ff',  name: 'FilmyFly',   desc: 'Direct Downloads · Parts',    emoji: '🎥', priority: 9 },
];
const DEFAULT_PROVIDERS = ALL_PROVIDERS.map(p => p.id);

// Initialize provider health tracking after ALL_PROVIDERS is defined
providerHealth = {};
ALL_PROVIDERS.forEach(p => {
    providerHealth[p.id] = {
        failures: 0,
        successes: 0,
        avgResponseTime: 0,
        lastSuccess: Date.now(),
        lastFailure: Date.now(),
        isCircuitOpen: false,
        circuitOpenTime: null
    };
});

/**
 * Encode provider list → base64 string safe for URL paths.
 * e.g. ['mb','nm','df'] → 'bWIsYW0sZGY='
 */
function encodeConfig(providerIds) {
    return Buffer.from(providerIds.join(',')).toString('base64url');
}

/**
 * Decode config string → array of valid provider ids.
 * Falls back to ALL providers on any error.
 */
function decodeConfig(configStr) {
    if (!configStr || configStr === 'default') return [...DEFAULT_PROVIDERS];
    try {
        const raw = Buffer.from(configStr, 'base64url').toString('utf8');
        const ids = raw.split(',').map(s => s.trim()).filter(s => ALL_PROVIDERS.some(p => p.id === s));
        return ids.length ? ids : [...DEFAULT_PROVIDERS];
    } catch {
        return [...DEFAULT_PROVIDERS];
    }
}

/** Build the manifest description string from selected provider ids */
function buildManifestDesc(providers) {
    const names = providers.map(id => {
        const p = ALL_PROVIDERS.find(x => x.id === id);
        return p ? `${p.emoji} ${p.name}` : id;
    }).join(' · ');
    return `${names} | By  Mega Streams ⚡`;
}

// ==================== MANIFEST ====================
const BASE_MANIFEST = {
    id:          'community.mega.multi.provider',
    version:     '7.1.0',
    name:        "🎬 By Mega Streams ⚡",
    logo:        'https://i.ibb.co/V0pSydpz/Secretary-Kim04-00476-1.jpg',
    resources:   ['stream'],
    types:       ['movie', 'series'],
    idPrefixes:  ['tt'],
    catalogs:    [],
    behaviorHints: {
        configurable:           true,
        configurationRequired:  false
    }
};

function buildManifest(providerIds) {
    return {
        ...BASE_MANIFEST,
        description: buildManifestDesc(providerIds)
    };
}

const builder = new addonBuilder({
    ...BASE_MANIFEST,
    description: buildManifestDesc(DEFAULT_PROVIDERS)
});

// ==================== PROXY HEADERS ====================
const NM_PROXY_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Android) ExoPlayer',
    'Accept':     '*/*',
    'Cookie':     'hd=on',
    'Referer':    'https://net52.cc/'
};

const MB_PROXY_HEADERS = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Accept':          'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Referer':         'https://themoviebox.org/',
    'Origin':          'https://themoviebox.org',
    'Sec-Fetch-Dest':  'video',
    'Sec-Fetch-Mode':  'cors',
    'Sec-Fetch-Site':  'cross-site',
    'Connection':      'keep-alive'
};

const KM_PROXY_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer':    'https://kmmovies.mom/',
    'Origin':     'https://kmmovies.mom'
};

function proxyUrl(targetUrl, headers) {
    return `${PUBLIC_BASE}/proxy?url=${encodeURIComponent(targetUrl)}&h=${encodeURIComponent(JSON.stringify(headers))}`;
}

// ==================== HELPERS ====================
function parseId(id) {
    const [imdbId, s, e] = id.split(':');
    return { imdbId, season: s ? parseInt(s) : null, episode: e ? parseInt(e) : null };
}

async function imdbToTmdb(imdbId, mediaType) {
    const cacheKey = `${imdbId}_${mediaType}`;
    const cached = tmdbCache.get(cacheKey);
    if (cached !== undefined) { console.log(`[Cache] TMDB hit ${imdbId}`); return cached; }
    const res = await fetch(
        `https://api.themoviedb.org/3/find/${imdbId}?api_key=439c478a771f35c05022f9feabcca01c&external_source=imdb_id`,
        { signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();
    const results = mediaType === 'movie' ? data.movie_results : data.tv_results;
    const tmdbId  = results?.length ? results[0].id : null;
    if (tmdbId) tmdbCache.set(cacheKey, tmdbId);
    return tmdbId;
}

function withTimeout(promise, ms, label) {
    let done = false;
    return Promise.race([
        promise
            .then(v  => { done = true; return v; })
            .catch(e => { done = true; console.error(`[${label}] error: ${e.message}`); return []; }),
        new Promise(resolve => setTimeout(() => {
            if (!done) console.log(`[${label}] timed out after ${ms}ms`);
            resolve([]);
        }, ms))
    ]);
}

async function withRetry(fn, retries = 1, label = '') {
    for (let i = 0; i <= retries; i++) {
        try {
            const result = await fn();
            return result != null ? result : [];
        }
        catch (err) {
            if (i === retries) { console.error(`[${label}] failed: ${err.message}`); return []; }
            await new Promise(r => setTimeout(r, 800 * (i + 1)));
        }
    }
    return [];
}

function deduplicateStreams(streams) {
    const seen = new Set();
    return streams.filter(s => {
        if (!s.url) return false;
        const urlParam = s.url.includes('proxy?url=')
            ? decodeURIComponent(s.url.split('proxy?url=')[1].split('&')[0])
            : s.url;
        if (seen.has(urlParam)) return false;
        seen.add(urlParam);
        return true;
    });
}

function provCacheKey(provider, tmdbId, mediaType, season, episode) {
    return `${provider}_${tmdbId}_${mediaType}_${season}_${episode}`;
}

// ==================== CORE STREAM BUILDER ====================
/**
 * Fetches streams from the requested providers and assembles the final stream list.
 * @param {string}   imdbId
 * @param {string}   mediaType  'movie' | 'tv'
 * @param {number|null} seasonVal
 * @param {number|null} episodeVal
 * @param {string[]} providerIds  Array of enabled provider IDs
 */
async function buildStreams(imdbId, mediaType, seasonVal, episodeVal, providerIds) {
    const isTv = mediaType === 'tv';

    let tmdbId;
    try {
        tmdbId = await imdbToTmdb(imdbId, mediaType);
        if (!tmdbId) { console.log('[Addon] No TMDB ID'); return []; }
    } catch (err) {
        console.error(`[Addon] TMDB: ${err.message}`);
        return [];
    }

    const combinedKey = `combined_${providerIds.sort().join('_')}_${tmdbId}_${mediaType}_${seasonVal??''}_${episodeVal??''}`;
    const cachedCombined = provCache.get(combinedKey);
    if (cachedCombined) {
        console.log(`[Cache] Combined HIT (${cachedCombined.length} streams)`);
        return cachedCombined;
    }

    async function fetchProvider(name, fn, timeoutMs) {
        const providerId = name.toLowerCase().replace('moviebox', 'mb').replace('netmirror', 'nm')
            .replace('doflix', 'df').replace('hdhubapi', 'hh').replace('kmmovies', 'km')
            .replace('animeworld', 'aw').replace('hindmovie', 'hm').replace('filmyfly', 'ff');

        // Check circuit breaker
        if (!checkProviderHealth(providerId)) {
            console.log(`[Provider] ${name} - Circuit OPEN, skipping`);
            return [];
        }

        const startTime = Date.now();
        const key = provCacheKey(name, tmdbId, mediaType, seasonVal, episodeVal);
        const hit  = provCache.get(key);
        if (hit) {
            console.log(`[Cache] ${name} HIT`);
            cacheHits++;
            return hit;
        }
        cacheMisses++;

        const streams = await withTimeout(withRetry(fn, 1, name), timeoutMs, name);
        const responseTime = Date.now() - startTime;

        if (streams.length) {
            provCache.set(key, streams);
            recordProviderSuccess(providerId, responseTime);
        } else {
            recordProviderFailure(providerId);
        }

        return streams;
    }

    async function fetchHdhub() {
        const EMPTY = { hdhub4u: [], khdhub: [] };
        try {
            const raw = await withTimeout(
                hdhubapi.getStreams(imdbId, mediaType, seasonVal, episodeVal), 65000, 'HDHubAPI'
            );
            if (!raw || Array.isArray(raw)) return EMPTY;
            return {
                hdhub4u: Array.isArray(raw.hdhub4u) ? raw.hdhub4u : [],
                khdhub:  Array.isArray(raw.khdhub)  ? raw.khdhub  : []
            };
        } catch (err) {
            console.error(`[HDHubAPI] fetchHdhub unexpected: ${err.message}`);
            return EMPTY;
        }
    }


    // Build parallel fetch tasks based on enabled providers
    const tasks = {};
    const has = id => providerIds.includes(id);

    if (has('mb')) tasks.mb = fetchProvider('MovieBox', () => moviebox.getStreams(tmdbId, mediaType, seasonVal, episodeVal), 10000);
    if (has('nm')) tasks.nm = fetchProvider('NetMirror', () => netmirror.getStreams(tmdbId, mediaType, seasonVal, episodeVal), 25000);
    if (has('df')) tasks.df = fetchProvider('DoFlix', () => doflix.getStreams(tmdbId, mediaType, seasonVal, episodeVal), 12000);
    if (has('hh') || has('kh')) tasks.hh = fetchHdhub();
    if (has('km')) tasks.km = fetchProvider('KMmovies', () => kmmovies.getStreams(tmdbId, mediaType, seasonVal, episodeVal), 35000);
    if (has('aw')) tasks.aw = fetchProvider('AnimeWorld', () => animeworld.getStreams(imdbId, mediaType, seasonVal, episodeVal), 35000);
    if (has('hm')) tasks.hm = fetchProvider('HindMovie', () => hindmovie.getStreams(tmdbId, mediaType, seasonVal, episodeVal), 90000);
    if (has('ff')) tasks.ff = fetchProvider('FilmyFly', () => filmyfly.getStreams(tmdbId, mediaType, seasonVal, episodeVal), 90000);

    // Wait for all
    const keys = Object.keys(tasks);
    const results = await Promise.all(Object.values(tasks));
    const resolved = {};
    keys.forEach((k, i) => { resolved[k] = results[i]; });

    const mb     = resolved.mb   || [];
    const nm     = resolved.nm   || [];
    const df     = resolved.df   || [];
    const hhData = resolved.hh   || { hdhub4u: [], khdhub: [] };
    const km     = resolved.km   || [];
    const aw     = resolved.aw   || [];

    const safeHh = (hhData && typeof hhData === 'object' && !Array.isArray(hhData))
        ? { hdhub4u: Array.isArray(hhData.hdhub4u) ? hhData.hdhub4u : [],
            khdhub:  Array.isArray(hhData.khdhub)  ? hhData.khdhub  : [] }
        : { hdhub4u: [], khdhub: [] };


    const streams = [];

    // ── 1. MovieBox ───────────────────────────────────────────────────────────
    for (const s of mb) {
        if (!s.url) continue;
        if (s.isMovieBoxDirect) {
            streams.push({ name: s.name, title: s.title || '', url: s.url, subtitles: s.subtitles || [] });
            continue;
        }
        const bhHeaders = (s.behaviorHints || {}).headers || {};
        const hdrs = { ...MB_PROXY_HEADERS };
        for (const [k, v] of Object.entries(bhHeaders)) {
            if (k.toLowerCase() === 'cookie' && hdrs['Cookie']) hdrs['Cookie'] += '; ' + v;
            else hdrs[k] = v;
        }
        const urlLower = s.url.toLowerCase().split('?')[0];
        const isHls = urlLower.endsWith('.m3u8') || urlLower.endsWith('.m3u');
        const streamUrl = isHls
            ? proxyUrl(s.url, hdrs)
            : `${PUBLIC_BASE}/mb-stream?url=${encodeURIComponent(s.url)}`;
        streams.push({
            name: s.name, title: s.title || '',
            url: streamUrl,
            subtitles: (s.subtitles || []).map(sub => ({
                url: proxyUrl(sub.url, hdrs),
                lang: sub.lang || 'Unknown'
            }))
        });
    }

    // ── 2. NetMirror ──────────────────────────────────────────────────────────
    for (const s of nm) {
        if (!s.url) continue;
        streams.push({
            name: s.name, title: s.title || '',
            url: proxyUrl(s.url, NM_PROXY_HEADERS),
            subtitles: (s.subtitles || []).map(sub => ({
                url: proxyUrl(sub.url, NM_PROXY_HEADERS),
                lang: sub.lang || 'Unknown'
            }))
        });
    }

    // ── 3. DoFlix ─────────────────────────────────────────────────────────────
    for (const s of df) {
        if (!s.url) continue;
        streams.push({
            name:  s.name  || '🎬 DoFlix',
            title: s.title || '',
            url:   s.url,
            behaviorHints: s.behaviorHints || {}
        });
    }

    // ── 4. HDHub4u ────────────────────────────────────────────────────────────
    if (has('hh')) {
        for (const s of safeHh.hdhub4u) {
            streams.push({
                name:  s.name, title: s.title, url: s.url,
                behaviorHints: s.behaviorHints || { notWebReady: true }
            });
        }
    }

    // ── 5. 4KHDHub ────────────────────────────────────────────────────────────
    if (has('kh')) {
        for (const s of safeHh.khdhub) {
            streams.push({
                name:  s.name, title: s.title, url: s.url,
                behaviorHints: s.behaviorHints || { notWebReady: true }
            });
        }
    }

    // ── 6. AnimeWorld ─────────────────────────────────────────────────────────
    for (const s of aw) {
        if (!s.url) continue;
        streams.push({
            name:  s.name, title: s.title || '',
            url:   s.url,
            behaviorHints: s.behaviorHints || {}
        });
    }

    // ── 7. KMmovies ────────────────────────────────────────────────────────────
    for (const s of km) {
        if (!s.url) continue;
        streams.push({
            name:  s.name, title: s.title || '',
            url:   s.url,
            behaviorHints: { notWebReady: true }
        });
    }

    // ── 8. HindMovie ───────────────────────────────────────────────────────────
    const hm = resolved.hm || [];
    for (const s of hm) {
        if (!s.url) continue;
        streams.push({
            name:  s.name, title: s.title || '',
            url:   s.url,
            behaviorHints: s.behaviorHints || { notWebReady: true }
        });
    }

    // ── 9. FilmyFly ───────────────────────────────────────────────────────────
    const ff = resolved.ff || [];
    for (const s of ff) {
        if (!s.url) continue;
        streams.push({
            name:  s.name, title: s.title || '',
            url:   s.url,
            behaviorHints: s.behaviorHints || { notWebReady: true }
        });
    }

    const valid = deduplicateStreams(streams);
    console.log(`[Addon] Returning ${valid.length} streams (deduped)\n`);
    provCache.set(combinedKey, valid);
    return valid;
}

// ==================== STREAM HANDLER (default – all providers) ====================
builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`\n[Addon] ===== ${type.toUpperCase()} ${id} =====`);
    totalRequests++;
    activeRequests++;
    _reqThisSec++;

    const { imdbId, season, episode } = parseId(id);
    const mediaType  = type === 'series' ? 'tv' : 'movie';
    const isTv       = mediaType === 'tv';
    const seasonVal  = isTv ? (season ?? null) : null;
    const episodeVal = isTv ? (episode ?? null) : null;

    const streams = await buildStreams(imdbId, mediaType, seasonVal, episodeVal, DEFAULT_PROVIDERS);

    activeRequests = Math.max(0, activeRequests - 1);
    setImmediate(() => prewarmStreams(streams.slice(0, 2)));
    return { streams };
});

// ==================== PRE-WARM M3U8 ====================
async function prewarmStreams(streams) {
    for (const s of streams) {
        if (!s.url || !s.url.includes('/proxy?')) continue;
        try {
            const inner = decodeURIComponent(s.url.split('proxy?url=')[1]?.split('&')[0] || '');
            if (!inner.match(/\.(m3u8|m3u)(\?|$)/i)) continue;
            console.log(`[Prewarm] M3U8 ${inner.substring(0, 60)}`);
            fetch(`${s.url}`, { signal: AbortSignal.timeout(8000) }).catch(() => {});
        } catch {}
    }
}

// ==================== EXPRESS ====================
const app = express();

// ==================== CONFIGURE PAGE ====================
// Route must be above static middleware so /configure is handled here, not as a static file
app.get('/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});
// Also handle configure when accessed via a config-aware URL (e.g. /bWIsbm0sZGY.../configure)
app.get('/:config/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

if (PUBLIC_PATH && PUBLIC_PATH !== '/') {
    app.use((req, res, next) => {
        if (req.url === PUBLIC_PATH) {
            req.url = '/';
        } else if (req.url.startsWith(PUBLIC_PATH + '/')) {
            req.url = req.url.slice(PUBLIC_PATH.length) || '/';
        }
        next();
    });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
});

// ==================== CORS ====================
app.get('/:config/manifest.json', (req, res) => {
    const providerIds = decodeConfig(req.params.config);
    const manifest = buildManifest(providerIds);
    // Tell Stremio the configure URL
    manifest.behaviorHints = {
        configurable:          true,
        configurationRequired: false
    };
    res.setHeader('Content-Type', 'application/json');
    res.json(manifest);
});

// ==================== CONFIG-AWARE STREAM ====================
app.get('/:config/stream/:type/:id.json', async (req, res) => {
    const providerIds = decodeConfig(req.params.config);
    const type  = req.params.type;          // 'movie' | 'series'
    const rawId = req.params.id;            // e.g. 'tt1234567' or 'tt1234567:1:2'

    console.log(`\n[Configured] ${type.toUpperCase()} ${rawId} providers=[${providerIds.join(',')}]`);
    totalRequests++;
    activeRequests++;
    _reqThisSec++;

    const { imdbId, season, episode } = parseId(rawId);
    const mediaType  = type === 'series' ? 'tv' : 'movie';
    const isTv       = mediaType === 'tv';
    const seasonVal  = isTv ? (season ?? null) : null;
    const episodeVal = isTv ? (episode ?? null) : null;

    try {
        const streams = await buildStreams(imdbId, mediaType, seasonVal, episodeVal, providerIds);
        activeRequests = Math.max(0, activeRequests - 1);
        setImmediate(() => prewarmStreams(streams.slice(0, 2)));
        res.json({ streams });
    } catch (err) {
        console.error(`[Configured] Error: ${err.message}`);
        activeRequests = Math.max(0, activeRequests - 1);
        res.json({ streams: [] });
    }
});

// ==================== LOGS ====================
app.get('/api/logs', (req, res) => res.json({ logs: logBuffer }));

// ==================== HEALTH ====================
app.get('/health', (req, res) => {
    const totalCache = cacheHits + cacheMisses;
    const cacheEfficiency = totalCache > 0 ? ((cacheHits / totalCache) * 100).toFixed(1) : 0;

    res.json({
        status:    'ok',
        version:   '7.0.0',
        providers: ALL_PROVIDERS.map(p => p.name),
        cache: {
            tmdb:      tmdbCache.size(),
            provider:  provCache.size(),
            m3u8:      m3u8Cache.size(),
            segments:  segmentCache.size(),
            hits:      cacheHits,
            misses:    cacheMisses,
            efficiency: cacheEfficiency + '%'
        },
        queue: {
            size: requestQueue.length,
            max: MAX_QUEUE_SIZE
        }
    });
});

// ==================== REAL-TIME STATS ====================
app.get('/api/stats', (req, res) => {
    const mem  = process.memoryUsage();
    const load = os.loadavg();
    const cpus = os.cpus();
    const uptimeSec = Math.floor((Date.now() - SERVER_START) / 1000);

    const cpuPct  = Math.min(100, (load[0] / cpus.length) * 100);
    const totalMem = os.totalmem();
    const freeMem  = os.freemem();
    const memPct   = ((totalMem - freeMem) / totalMem) * 100;

    const totalCache = cacheHits + cacheMisses;
    const cacheEfficiency = totalCache > 0 ? ((cacheHits / totalCache) * 100).toFixed(1) : 0;

    res.setHeader('Cache-Control', 'no-store');
    res.json({
        uptime: uptimeSec,
        totalRequests,
        activeRequests,
        requestHistory: [...requestHistory],
        cpu: {
            percent: parseFloat(cpuPct.toFixed(1)),
            load1:   parseFloat(load[0].toFixed(2)),
            load5:   parseFloat(load[1].toFixed(2)),
            cores:   cpus.length
        },
        memory: {
            heapUsedMb:  parseFloat((mem.heapUsed  / 1024 / 1024).toFixed(1)),
            heapTotalMb: parseFloat((mem.heapTotal / 1024 / 1024).toFixed(1)),
            rssMb:       parseFloat((mem.rss       / 1024 / 1024).toFixed(1)),
            systemPct:   parseFloat(memPct.toFixed(1))
        },
        cache: {
            tmdb:       tmdbCache.size(),
            provider:   provCache.size(),
            m3u8:       m3u8Cache.size(),
            segments:   segmentCache.size(),
            hits:       cacheHits,
            misses:     cacheMisses,
            efficiency: cacheEfficiency + '%'
        },
        apiManagement: {
            queueSize: requestQueue.length,
            maxQueue: MAX_QUEUE_SIZE,
            providers: Object.entries(providerHealth).map(([id, h]) => ({
                id,
                successes: h.successes,
                failures: h.failures,
                avgResponseTime: Math.round(h.avgResponseTime) + 'ms',
                circuitOpen: h.isCircuitOpen,
                health: h.successes + h.failures > 0
                    ? ((h.successes / (h.successes + h.failures)) * 100).toFixed(1) + '%'
                    : 'N/A'
            }))
        },
        providers: ALL_PROVIDERS.map(p => ({ name: p.name, id: p.id, desc: p.desc, priority: p.priority }))
    });
});

// ==================== MB-STREAM ====================
app.get('/mb-stream', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) { res.status(400).send('Missing url'); return; }

    const rangeHdr = req.headers['range'];
    const reqHeaders = {
        ...MB_PROXY_HEADERS,
        'Accept':          'video/webm,video/ogg,video/*;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Connection':      'keep-alive',
    };
    if (rangeHdr) reqHeaders['Range'] = rangeHdr;

    const mbStreamAgent = new https.Agent({
        keepAlive: true, maxSockets: 256, maxFreeSockets: 64,
        keepAliveMsecs: 15000, timeout: 60000, rejectUnauthorized: false,
    });

    function doMbStream(urlStr, redirectCount = 0) {
        let p;
        try { p = new URL(urlStr); } catch { if (!res.headersSent) res.status(400).send('Bad url'); return; }
        const lib2  = p.protocol === 'https:' ? https : http;
        const agent = p.protocol === 'https:' ? mbStreamAgent : httpAgent;

        const upstream = lib2.request({
            hostname: p.hostname, port: p.port || (p.protocol === 'https:' ? 443 : 80),
            path: p.pathname + p.search, method: 'GET', headers: { ...reqHeaders },
            agent, timeout: 60000,
        }, upRes => {
            if ([301,302,303,307,308].includes(upRes.statusCode) && upRes.headers.location && redirectCount < 10) {
                let loc = upRes.headers.location;
                if (!loc.startsWith('http')) loc = `${p.protocol}//${p.hostname}${loc}`;
                upRes.resume(); doMbStream(loc, redirectCount + 1); return;
            }
            if (upRes.statusCode < 200 || upRes.statusCode >= 400) {
                res.writeHead(upRes.statusCode, { 'Access-Control-Allow-Origin': '*' }); upRes.pipe(res); return;
            }
            const ct = upRes.headers['content-type'] || 'video/mp4';
            const totalSize = upRes.headers['content-length'] ? parseInt(upRes.headers['content-length']) : null;
            const honoured  = upRes.statusCode === 206;

            if (rangeHdr && !honoured && totalSize) {
                const m = rangeHdr.match(/bytes=(\d*)-(\d*)/);
                if (m) {
                    const rStart = m[1] !== '' ? parseInt(m[1]) : totalSize - parseInt(m[2]);
                    const rEnd   = m[2] !== '' ? parseInt(m[2]) : totalSize - 1;
                    if (rStart < totalSize) {
                        const chunkSize = rEnd - rStart + 1;
                        res.writeHead(206, {
                            'Content-Type': ct, 'Content-Length': String(chunkSize),
                            'Content-Range': `bytes ${rStart}-${rEnd}/${totalSize}`,
                            'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*',
                        });
                        let skipped = 0, sent = 0;
                        upRes.on('data', chunk => {
                            if (skipped < rStart) { const need = rStart - skipped; if (chunk.length <= need) { skipped += chunk.length; return; } chunk = chunk.slice(need); skipped = rStart; }
                            const rem = chunkSize - sent; if (rem <= 0) { upRes.destroy(); return; }
                            if (chunk.length > rem) chunk = chunk.slice(0, rem);
                            sent += chunk.length; res.write(chunk); if (sent >= chunkSize) { res.end(); upRes.destroy(); }
                        });
                        upRes.on('end', () => { if (!res.writableEnded) res.end(); });
                        res.on('close', () => { try { upRes.destroy(); } catch {} }); return;
                    }
                }
            }
            const sc = honoured ? 206 : 200;
            const outHdrs = {
                'Content-Type': ct, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes',
            };
            if (upRes.headers['content-length']) outHdrs['Content-Length'] = upRes.headers['content-length'];
            if (upRes.headers['content-range'])  outHdrs['Content-Range']  = upRes.headers['content-range'];
            if (upRes.headers['etag'])           outHdrs['ETag']           = upRes.headers['etag'];
            res.writeHead(sc, outHdrs);
            upRes.pipe(res, { end: true });
            res.on('close', () => { try { upRes.destroy(); } catch {} });
        });
        upstream.on('error', err => { console.error(`[MB-Stream] ${err.message}`); if (!res.headersSent) res.status(502).send('Proxy error'); });
        upstream.on('timeout', () => { upstream.destroy(); if (!res.headersSent) res.status(504).send('Timeout'); });
        upstream.end();
    }
    doMbStream(targetUrl);
});

app.post('/mb-proxy', express.json({ limit: '10kb' }), async (req, res) => {
    try {
        const { url, method, headers, body } = req.body;
        if (!url) { res.status(400).json({ error: 'Missing url' }); return; }
        const upstream = await fetch(url, {
            method: method || 'GET', headers: headers || {}, body,
            signal: AbortSignal.timeout(15000)
        });
        const text = await upstream.text();
        res.status(upstream.status).set('Content-Type', 'application/json').send(text);
    } catch (err) { res.status(502).json({ error: err.message }); }
});

// ==================== HH-PROXY ====================
app.get('/hh-proxy', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) { res.status(400).send('Missing url'); return; }
    try { new URL(targetUrl); } catch { res.status(400).send('Bad url'); return; }

    const startTime = Date.now();
    const rangeHdr  = req.headers['range'];
    const reqHeaders = {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          '*/*', 'Accept-Encoding': 'identity', 'Connection': 'keep-alive',
        'Referer':         'https://hdhub4u.mov/', 'Origin': 'https://hdhub4u.mov'
    };
    if (rangeHdr) reqHeaders['Range'] = rangeHdr;

    const hhHttpsAgent = new https.Agent({
        keepAlive: true, maxSockets: 128, maxFreeSockets: 32,
        keepAliveMsecs: 15000, timeout: 60000, rejectUnauthorized: false,
    });

    function doHhRequest(urlStr, redirectCount = 0) {
        let p; try { p = new URL(urlStr); } catch { if (!res.headersSent) res.status(400).send('Bad url'); return; }
        const lib2  = p.protocol === 'https:' ? https : http;
        const agent = p.protocol === 'https:' ? hhHttpsAgent : httpAgent;
        const hopHeaders = { ...reqHeaders }; if (rangeHdr) hopHeaders['Range'] = rangeHdr;
        const upstream = lib2.request({
            hostname: p.hostname, port: p.port || (p.protocol === 'https:' ? 443 : 80),
            path: p.pathname + p.search, method: 'GET', headers: hopHeaders, agent, timeout: 60000,
        }, upRes => {
            console.log(`[HH-Proxy] ${upRes.statusCode} ${p.hostname}${p.pathname.substring(0,40)} (${Date.now()-startTime}ms)`);
            if ([301,302,303,307,308].includes(upRes.statusCode) && upRes.headers.location && redirectCount < 12) {
                let loc = upRes.headers.location;
                if (!loc.startsWith('http')) loc = `${p.protocol}//${p.hostname}${loc.startsWith('/') ? '' : '/'}${loc}`;
                upRes.resume(); doHhRequest(loc, redirectCount + 1); return;
            }
            if (upRes.statusCode < 200 || upRes.statusCode >= 400) { res.writeHead(upRes.statusCode, { 'Access-Control-Allow-Origin': '*' }); upRes.pipe(res); return; }
            const ct = upRes.headers['content-type'] || 'video/mp4';
            const totalSize = upRes.headers['content-length'] ? parseInt(upRes.headers['content-length']) : null;
            const honoured = upRes.statusCode === 206;
            if (rangeHdr && !honoured && totalSize) {
                const m = rangeHdr.match(/bytes=(\d*)-(\d*)/);
                if (m) {
                    const rStart = m[1]!==''?parseInt(m[1]):totalSize-parseInt(m[2]);
                    const rEnd   = m[2]!==''?parseInt(m[2]):totalSize-1;
                    if (rStart < totalSize) {
                        const chunkSize = rEnd-rStart+1;
                        res.writeHead(206, { 'Content-Type':ct,'Content-Length':String(chunkSize),'Content-Range':`bytes ${rStart}-${rEnd}/${totalSize}`,'Accept-Ranges':'bytes','Access-Control-Allow-Origin':'*','Cache-Control':'public, max-age=3600' });
                        let skipped=0,sent=0;
                        upRes.on('data',chunk=>{if(skipped<rStart){const need=rStart-skipped;if(chunk.length<=need){skipped+=chunk.length;return;}chunk=chunk.slice(need);skipped=rStart;}const rem=chunkSize-sent;if(rem<=0){upRes.destroy();return;}if(chunk.length>rem)chunk=chunk.slice(0,rem);sent+=chunk.length;res.write(chunk);if(sent>=chunkSize){res.end();upRes.destroy();}});
                        upRes.on('end',()=>{if(!res.writableEnded)res.end();});
                        res.on('close',()=>{try{upRes.destroy();}catch{}});return;
                    }
                }
            }
            const sc=honoured?206:200;
            const outHeaders={'Content-Type':ct,'Access-Control-Allow-Origin':'*','Accept-Ranges':'bytes','Cache-Control':'public, max-age=3600'};
            if(upRes.headers['content-length'])outHeaders['Content-Length']=upRes.headers['content-length'];
            if(upRes.headers['content-range'])outHeaders['Content-Range']=upRes.headers['content-range'];
            if(upRes.headers['etag'])outHeaders['ETag']=upRes.headers['etag'];
            res.writeHead(sc,outHeaders); upRes.pipe(res,{end:true}); res.on('close',()=>{try{upRes.destroy();}catch{}});
        });
        upstream.on('error',err=>{console.error(`[HH-Proxy] err ${p.hostname}: ${err.message}`);if(!res.headersSent)res.status(502).send('Proxy error');});
        upstream.on('timeout',()=>{upstream.destroy();if(!res.headersSent)res.status(504).send('Proxy timeout');});
        upstream.end();
    }
    doHhRequest(targetUrl);
});

// ==================== FI-PROXY ====================
app.get('/fi-proxy', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) { res.status(400).send('Missing url'); return; }
    try { new URL(targetUrl); } catch { res.status(400).send('Bad url'); return; }

    const rangeHdr = req.headers['range'];
    const reqHeaders = {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer':         'https://m.flixindia.xyz/', 'Origin': 'https://m.flixindia.xyz',
        'Accept':          'video/webm,video/ogg,video/*;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity', 'Connection': 'keep-alive',
    };
    if (rangeHdr) reqHeaders['Range'] = rangeHdr;

    const fiAgent = new https.Agent({ keepAlive:true,maxSockets:64,maxFreeSockets:16,keepAliveMsecs:15000,timeout:45000,rejectUnauthorized:false });

    function doFiRequest(urlStr, redirectCount = 0) {
        let p; try { p = new URL(urlStr); } catch { if (!res.headersSent) res.status(400).send('Bad url'); return; }
        const lib2 = p.protocol === 'https:' ? https : http;
        const agent = p.protocol === 'https:' ? fiAgent : httpAgent;
        const hopHeaders = { ...reqHeaders }; if (rangeHdr) hopHeaders['Range'] = rangeHdr;
        const upstream = lib2.request({ hostname:p.hostname,port:p.port||(p.protocol==='https:'?443:80),path:p.pathname+p.search,method:'GET',headers:hopHeaders,agent,timeout:45000 }, upRes => {
            if ([301,302,303,307,308].includes(upRes.statusCode)&&upRes.headers.location&&redirectCount<10){let loc=upRes.headers.location;if(!loc.startsWith('http'))loc=`${p.protocol}//${p.hostname}${loc.startsWith('/')?'':'/'}${loc}`;upRes.resume();doFiRequest(loc,redirectCount+1);return;}
            if (upRes.statusCode<200||upRes.statusCode>=400){res.writeHead(upRes.statusCode,{'Access-Control-Allow-Origin':'*'});upRes.pipe(res);return;}
            const ct=upRes.headers['content-type']||'video/mp4';
            const totalSize=upRes.headers['content-length']?parseInt(upRes.headers['content-length']):null;
            const honoured=upRes.statusCode===206;
            if(rangeHdr&&!honoured&&totalSize){const m=rangeHdr.match(/bytes=(\d*)-(\d*)/);if(m){const rStart=m[1]!==''?parseInt(m[1]):totalSize-parseInt(m[2]);const rEnd=m[2]!==''?parseInt(m[2]):totalSize-1;if(rStart<totalSize){const cs=rEnd-rStart+1;res.writeHead(206,{'Content-Type':ct,'Content-Length':String(cs),'Content-Range':`bytes ${rStart}-${rEnd}/${totalSize}`,'Accept-Ranges':'bytes','Access-Control-Allow-Origin':'*','Cache-Control':'public, max-age=3600'});let sk=0,se=0;upRes.on('data',chunk=>{if(sk<rStart){const n=rStart-sk;if(chunk.length<=n){sk+=chunk.length;return;}chunk=chunk.slice(n);sk=rStart;}const r=cs-se;if(r<=0){upRes.destroy();return;}if(chunk.length>r)chunk=chunk.slice(0,r);se+=chunk.length;res.write(chunk);if(se>=cs){res.end();upRes.destroy();}});upRes.on('end',()=>{if(!res.writableEnded)res.end();});res.on('close',()=>{try{upRes.destroy();}catch{}});return;}}}
            const sc=honoured?206:200;
            const outH={'Content-Type':ct,'Access-Control-Allow-Origin':'*','Accept-Ranges':'bytes','Cache-Control':'public, max-age=3600'};
            if(upRes.headers['content-length'])outH['Content-Length']=upRes.headers['content-length'];
            if(upRes.headers['content-range'])outH['Content-Range']=upRes.headers['content-range'];
            if(upRes.headers['etag'])outH['ETag']=upRes.headers['etag'];
            res.writeHead(sc,outH); upRes.pipe(res,{end:true}); res.on('close',()=>{try{upRes.destroy();}catch{}});
        });
        upstream.on('error',err=>{console.error(`[FI-Proxy] err ${p.hostname}: ${err.message}`);if(!res.headersSent)res.status(502).send('Proxy error');});
        upstream.on('timeout',()=>{upstream.destroy();if(!res.headersSent)res.status(504).send('Proxy timeout');});
        upstream.end();
    }
    doFiRequest(targetUrl);
});

// ==================== KHD-PROXY ====================
app.get('/khd-proxy', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) { res.status(400).send('Missing url'); return; }
    try { new URL(targetUrl); } catch { res.status(400).send('Bad url'); return; }

    const rangeHdr = req.headers['range'];
    const reqHeaders = {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'video/webm,video/ogg,video/*;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity', 'Connection': 'keep-alive',
    };
    if (rangeHdr) reqHeaders['Range'] = rangeHdr;

    const khdAgent = new https.Agent({ keepAlive:true,maxSockets:64,maxFreeSockets:16,keepAliveMsecs:15000,timeout:60000,rejectUnauthorized:false });

    function doKhdRequest(urlStr, redirectCount = 0) {
        let p; try { p = new URL(urlStr); } catch { if (!res.headersSent) res.status(400).send('Bad url'); return; }
        const lib2 = p.protocol === 'https:' ? https : http;
        const agent = p.protocol === 'https:' ? khdAgent : httpAgent;
        const hopHeaders = { ...reqHeaders }; if (rangeHdr) hopHeaders['Range'] = rangeHdr;
        const upstream = lib2.request({ hostname:p.hostname,port:p.port||(p.protocol==='https:'?443:80),path:p.pathname+p.search,method:'GET',headers:hopHeaders,agent,timeout:60000 }, upRes => {
            if ([301,302,303,307,308].includes(upRes.statusCode)&&upRes.headers.location&&redirectCount<10){let loc=upRes.headers.location;if(!loc.startsWith('http'))loc=`${p.protocol}//${p.hostname}${loc.startsWith('/')?'':'/'}${loc}`;upRes.resume();doKhdRequest(loc,redirectCount+1);return;}
            if (upRes.statusCode<200||upRes.statusCode>=400){res.writeHead(upRes.statusCode,{'Access-Control-Allow-Origin':'*'});upRes.pipe(res);return;}
            const ct=upRes.headers['content-type']||'video/mp4';
            const totalSize=upRes.headers['content-length']?parseInt(upRes.headers['content-length']):null;
            const honoured=upRes.statusCode===206;
            if(rangeHdr&&!honoured&&totalSize){const m=rangeHdr.match(/bytes=(\d*)-(\d*)/);if(m){const rStart=m[1]!==''?parseInt(m[1]):totalSize-parseInt(m[2]);const rEnd=m[2]!==''?parseInt(m[2]):totalSize-1;if(rStart<totalSize){const cs=rEnd-rStart+1;res.writeHead(206,{'Content-Type':ct,'Content-Length':String(cs),'Content-Range':`bytes ${rStart}-${rEnd}/${totalSize}`,'Accept-Ranges':'bytes','Access-Control-Allow-Origin':'*','Cache-Control':'public, max-age=3600'});let sk=0,se=0;upRes.on('data',chunk=>{if(sk<rStart){const n=rStart-sk;if(chunk.length<=n){sk+=chunk.length;return;}chunk=chunk.slice(n);sk=rStart;}const r=cs-se;if(r<=0){upRes.destroy();return;}if(chunk.length>r)chunk=chunk.slice(0,r);se+=chunk.length;res.write(chunk);if(se>=cs){res.end();upRes.destroy();}});upRes.on('end',()=>{if(!res.writableEnded)res.end();});res.on('close',()=>{try{upRes.destroy();}catch{}});return;}}}
            const sc=honoured?206:200;
            const outH={'Content-Type':ct,'Access-Control-Allow-Origin':'*','Accept-Ranges':'bytes','Cache-Control':'public, max-age=3600'};
            if(upRes.headers['content-length'])outH['Content-Length']=upRes.headers['content-length'];
            if(upRes.headers['content-range'])outH['Content-Range']=upRes.headers['content-range'];
            if(upRes.headers['etag'])outH['ETag']=upRes.headers['etag'];
            res.writeHead(sc,outH); upRes.pipe(res,{end:true}); res.on('close',()=>{try{upRes.destroy();}catch{}});
        });
        upstream.on('error',err=>{console.error(`[KHD-Proxy] ${err.message}`);if(!res.headersSent)res.status(502).send('Proxy error');});
        upstream.on('timeout',()=>{upstream.destroy();if(!res.headersSent)res.status(504).send('Timeout');});
        upstream.end();
    }
    doKhdRequest(targetUrl);
});

// ==================== PROXY ====================
app.get('/proxy', (req, res) => {
    const targetUrl = req.query.url;
    const hParam    = req.query.h || '{}';
    if (!targetUrl) { res.status(400).send('Missing url'); return; }

    let extraHeaders = {};
    try { extraHeaders = JSON.parse(decodeURIComponent(hParam)); } catch {}
    let parsedUrl;
    try { parsedUrl = new URL(targetUrl); } catch { res.status(400).send('Bad url'); return; }

    const encodedH    = encodeURIComponent(hParam);
    const rangeHdr    = req.headers['range'];
    const ifNoneMatch = req.headers['if-none-match'];
    const ifModSince  = req.headers['if-modified-since'];

    if (ifNoneMatch || ifModSince) {
        const etagEntry = etag304Cache.get(targetUrl);
        if (etagEntry) {
            const matches = (ifNoneMatch && etagEntry.etag && ifNoneMatch === etagEntry.etag) ||
                            (ifModSince  && etagEntry.lastMod && ifModSince === etagEntry.lastMod);
            if (matches) { res.writeHead(304, { 'Access-Control-Allow-Origin': '*' }); res.end(); return; }
        }
    }

    const reqHeaders = { 'Accept': '*/*', 'Connection': 'keep-alive', ...extraHeaders };
    delete reqHeaders['host']; delete reqHeaders['Host'];
    delete reqHeaders['content-length']; delete reqHeaders['Content-Length'];
    delete reqHeaders['transfer-encoding'];
    if (rangeHdr) reqHeaders['Range'] = rangeHdr;

    function doRequest(urlStr, redirectCount = 0) {
        let p; try { p = new URL(urlStr); } catch { if (!res.headersSent) res.status(400).send('Bad url'); return; }

        const lib2  = p.protocol === 'https:' ? https : http;
        const agent = p.protocol === 'https:' ? httpsAgent : httpAgent;
        const urlLower = urlStr.toLowerCase().split('?')[0];
        const isM3u8   = urlLower.endsWith('.m3u8') || urlLower.endsWith('.m3u') || urlLower.includes('.m3u8?');
        const isDash   = urlLower.endsWith('.mpd');
        const isSub    = urlLower.endsWith('.srt') || urlLower.endsWith('.vtt') || urlLower.endsWith('.ass') || urlLower.endsWith('.ssa');
        const isSegment = !isM3u8 && !isDash && !isSub && !rangeHdr &&
                          (urlLower.endsWith('.ts') || urlLower.endsWith('.m4s') ||
                           urlLower.endsWith('.mp4') || urlLower.endsWith('.aac'));

        if (isSegment) {
            const hit = segmentCache.get(urlStr);
            if (hit) {
                res.writeHead(200, {
                    'Content-Type': hit.ct, 'Content-Length': hit.buf.length,
                    'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600', 'X-Cache': 'HIT'
                });
                res.end(hit.buf); return;
            }
        }

        const upstream = lib2.request({
            hostname: p.hostname, port: p.port || (p.protocol === 'https:' ? 443 : 80),
            path: p.pathname + p.search, method: 'GET', headers: reqHeaders, agent, timeout: 30000
        }, upRes => {
            if ([301,302,303,307,308].includes(upRes.statusCode) && upRes.headers.location && redirectCount < 10) {
                let loc = upRes.headers.location;
                if (!loc.startsWith('http')) { try { loc = new URL(loc, urlStr).toString(); } catch { loc = `${p.protocol}//${p.hostname}${loc}`; } }
                upRes.resume(); doRequest(loc, redirectCount + 1); return;
            }

            const urlStr2 = urlStr;
            const inferCt = upRes.headers['content-type'] ||
                (isM3u8 ? 'application/vnd.apple.mpegurl' :
                 isDash  ? 'application/dash+xml' :
                 isSub   ? 'text/plain' : inferContentType(urlStr2));

            if (isM3u8) {
                const chunks = [];
                upRes.on('data', c => chunks.push(c));
                upRes.on('end', () => {
                    let body = Buffer.concat(chunks).toString('utf8');
                    const cacheHit = m3u8Cache.get(urlStr);
                    if (!cacheHit || cacheHit !== body) m3u8Cache.set(urlStr, body);

                    const isMaster = body.includes('EXT-X-STREAM-INF') || body.includes('EXT-X-MEDIA:');
                    body = rewriteM3U8(body, urlStr, encodedH);
                    if (!isMaster) setImmediate(() => prefetchSegments(body, reqHeaders));

                    res.writeHead(200, {
                        'Content-Type':                'application/vnd.apple.mpegurl',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control':               'no-cache'
                    });
                    res.end(body);
                });
                upRes.on('error', err => { if (!res.headersSent) res.status(502).send('M3U8 error'); });
                return;
            }

            if (isDash) {
                const chunks = [];
                upRes.on('data', c => chunks.push(c));
                upRes.on('end', () => {
                    const body = rewriteDASH(Buffer.concat(chunks).toString('utf8'), urlStr, encodedH);
                    res.writeHead(200, { 'Content-Type': 'application/dash+xml', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
                    res.end(body);
                });
                return;
            }

            const upstreamHonouredRange = upRes.statusCode === 206;

            if (rangeHdr && !upstreamHonouredRange) {
                const totalSize = upRes.headers['content-length'] ? parseInt(upRes.headers['content-length']) : null;
                if (totalSize) {
                    const m = rangeHdr.match(/bytes=(\d*)-(\d*)/);
                    if (m) {
                        const rStart = m[1]!==''?parseInt(m[1]):totalSize-parseInt(m[2]);
                        const rEnd   = m[2]!==''?parseInt(m[2]):totalSize-1;
                        if (rStart < totalSize) {
                            const chunkSize = rEnd-rStart+1;
                            res.writeHead(206, {
                                'Content-Type': inferCt, 'Content-Length': String(chunkSize),
                                'Content-Range': `bytes ${rStart}-${rEnd}/${totalSize}`,
                                'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=86400'
                            });
                            let bytesSent=0, bytesSkipped=0;
                            upRes.on('data', chunk => {
                                if (bytesSkipped < rStart) { const n=rStart-bytesSkipped; if(chunk.length<=n){bytesSkipped+=chunk.length;return;} chunk=chunk.slice(n);bytesSkipped=rStart; }
                                const rem=chunkSize-bytesSent; if(rem<=0){upRes.destroy();return;}
                                if(chunk.length>rem)chunk=chunk.slice(0,rem);
                                bytesSent+=chunk.length; res.write(chunk); if(bytesSent>=chunkSize){res.end();upRes.destroy();}
                            });
                            upRes.on('end', () => { if (!res.writableEnded) res.end(); });
                            res.on('close', () => { try { upRes.destroy(); } catch {} });
                            return;
                        }
                    }
                }
            }

            const outHeaders = {
                'Content-Type':                inferCt,
                'Access-Control-Allow-Origin': '*',
                'Accept-Ranges':               'bytes',
                'Cache-Control':               'public, max-age=86400'
            };
            const sc = upstreamHonouredRange ? 206 : 200;
            if (upRes.headers['content-length'])  outHeaders['Content-Length']  = upRes.headers['content-length'];
            if (upRes.headers['content-range'])   outHeaders['Content-Range']   = upRes.headers['content-range'];
            if (upRes.headers['etag'])             outHeaders['ETag']            = upRes.headers['etag'];
            if (upRes.headers['last-modified'])    outHeaders['Last-Modified']   = upRes.headers['last-modified'];
            if (upRes.headers['accept-ranges'])    outHeaders['Accept-Ranges']   = upRes.headers['accept-ranges'];

            if (upRes.headers['etag'] || upRes.headers['last-modified']) {
                etag304Cache.set(targetUrl, { etag: upRes.headers['etag']||null, lastMod: upRes.headers['last-modified']||null });
            }

            res.writeHead(sc, outHeaders);

            const clStr = upRes.headers['content-length'];
            const cl    = clStr ? parseInt(clStr) : 0;
            if (isSegment && cl > 0 && cl < 2*1024*1024 && sc === 200) {
                const chunks = [];
                upRes.on('data', chunk => chunks.push(chunk));
                upRes.on('end', () => { const buf = Buffer.concat(chunks); segmentCache.set(urlStr, { buf, ct: inferCt }); res.end(buf); });
                upRes.on('error', err => { if (!res.headersSent) res.status(502).send('Segment error'); });
            } else {
                upRes.pipe(res, { end: true });
                res.on('close', () => { try { upRes.destroy(); } catch {} });
            }
        });

        upstream.on('error', err => { console.error(`[Proxy] err ${p.hostname}: ${err.message}`); if (!res.headersSent) res.status(502).send('Proxy error'); });
        upstream.on('timeout', () => { upstream.destroy(); if (!res.headersSent) res.status(504).send('Proxy timeout'); });
        upstream.end();
    }

    doRequest(targetUrl);
});

// ==================== M3U8 REWRITE ====================
function rewriteM3U8(body, base, encodedH) {
    return body.split('\n').map(line => {
        const t = line.trim();
        if (t.includes('URI="')) {
            line = line.replace(/URI="([^"]+)"/g, (match, uri) => {
                if (!uri) return match;
                let abs = uri;
                if (!abs.startsWith('http')) { try { abs = new URL(uri, base).toString(); } catch { return match; } }
                return `URI="${PUBLIC_BASE}/proxy?url=${encodeURIComponent(abs)}&h=${encodedH}"`;
            });
        }
        if (!t || t.startsWith('#')) return line;
        let abs = t;
        if (!abs.startsWith('http')) { try { abs = new URL(t, base).toString(); } catch { return line; } }
        return `/proxy?url=${encodeURIComponent(abs)}&h=${encodedH}`;
    }).join('\n');
}

// ==================== DASH REWRITE ====================
function rewriteDASH(body, base, encodedH) {
    let r = body.replace(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/g, (m, url) => {
        let abs = url.trim();
        if (!abs) return m;
        if (!abs.startsWith('http')) { try { abs = new URL(abs, base).toString(); } catch { return m; } }
        return m.replace(url, `${PUBLIC_BASE}/proxy?url=${encodeURIComponent(abs)}&h=${encodedH}`);
    });
    r = r.replace(/\s(initialization|media)="([^"]+)"/g, (m, attr, url) => {
        if (!url || url.includes('$')) return m;
        let abs = url;
        if (!abs.startsWith('http')) { try { abs = new URL(url, base).toString(); } catch { return m; } }
        return ` ${attr}="${PUBLIC_BASE}/proxy?url=${encodeURIComponent(abs)}&h=${encodedH}"`;
    });
    return r;
}

// ==================== SEGMENT PRE-FETCH ====================
async function prefetchSegments(rewrittenM3u8, headers) {
    const MAX = 3;
    const lines = rewrittenM3u8.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    let fetched = 0;
    for (const line of lines) {
        if (fetched >= MAX) break;
        let realUrl;
        try { const m = line.match(/proxy\?url=([^&]+)/); if (!m) continue; realUrl = decodeURIComponent(m[1]); } catch { continue; }
        if (segmentCache.get(realUrl)) continue;
        fetched++;
        (async () => {
            try {
                const p = new URL(realUrl);
                const lib2  = p.protocol === 'https:' ? https : http;
                const agent = p.protocol === 'https:' ? httpsAgent : httpAgent;
                await new Promise((resolve, reject) => {
                    const req = lib2.request({ hostname:p.hostname,port:p.port||(p.protocol==='https:'?443:80),path:p.pathname+p.search,method:'GET',headers:{...headers,'Connection':'keep-alive'},agent,timeout:15000 }, r2 => {
                        const ct = r2.headers['content-type'] || 'video/MP2T';
                        const chunks = [];
                        r2.on('data', c => chunks.push(c));
                        r2.on('end', () => { const buf = Buffer.concat(chunks); if (buf.length < 2*1024*1024) segmentCache.set(realUrl, { buf, ct }); resolve(); });
                        r2.on('error', reject);
                    });
                    req.on('error', reject);
                    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                    req.end();
                });
            } catch (e) { console.debug(`[Prefetch] Skip: ${e.message}`); }
        })();
    }
}

// ==================== CONTENT TYPE INFERENCE ====================
function inferContentType(urlStr) {
    const u = urlStr.toLowerCase().split('?')[0];
    if (u.endsWith('.aac'))  return 'audio/aac';
    if (u.endsWith('.mp3'))  return 'audio/mpeg';
    if (u.endsWith('.mp4') || u.endsWith('.m4s') || u.endsWith('.m4a') || u.endsWith('.m4v')) return 'video/mp4';
    if (u.endsWith('.mkv'))  return 'video/x-matroska';
    if (u.endsWith('.webm')) return 'video/webm';
    if (u.endsWith('.ts'))   return 'video/MP2T';
    return 'application/octet-stream';
}

// ==================== API: ALL PROVIDER INFO (for configure page) ====================
app.get('/api/providers', (req, res) => {
    res.json({ providers: ALL_PROVIDERS, defaultAll: DEFAULT_PROVIDERS });
});

// ==================== STREMIO ROUTER ====================
const addonInterface = builder.getInterface();
app.use(getRouter(addonInterface));

// ==================== STARTUP ====================
app.listen(PORT, '0.0.0.0', () => {
    const installUrl  = `${PUBLIC_BASE}/manifest.json`;
    const configureUrl = `${PUBLIC_BASE}/configure`;
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║   By Mega Streams v7.1.0 — TURBO EDITION ⚡               ║
╠═══════════════════════════════════════════════════════════╣
║  Install   : ${installUrl.padEnd(48)} ║
║  Configure : ${configureUrl.padEnd(48)} ║
║  Providers : MB·NM·DF·HH·KHD·KM·AW·HM·FF                 ║
║  API Mgmt  : Enabled (Circuit Breaker + Queue)           ║
║  By Mega Streams ⚡ | Telegram: @S4NCHITT               ║
╚═══════════════════════════════════════════════════════════╝`);
});
