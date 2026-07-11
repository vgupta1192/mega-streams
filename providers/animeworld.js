/**
 * AnimeWorld Provider v2.0
 * Proxies the anime-world-stremio-addon to fetch anime streams.
 * By Murph Streams ⚡
 */

'use strict';

const ADDON_BASE = 'https://anime-world-stremio-addon.onrender.com';
const CACHE_TTL  = 20 * 60 * 1000;

// ── LRU Cache ────────────────────────────────────────────────────────────────
class LRUCache {
    constructor(max, ttl) { this.max = max; this.ttl = ttl; this.map = new Map(); }
    get(k) {
        const e = this.map.get(k);
        if (!e) return undefined;
        if (Date.now() - e.ts > this.ttl) { this.map.delete(k); return undefined; }
        this.map.delete(k); this.map.set(k, e);
        return e.v;
    }
    set(k, v) {
        if (this.map.has(k)) this.map.delete(k);
        else if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
        this.map.set(k, { v, ts: Date.now() });
    }
}

const streamCache = new LRUCache(200, CACHE_TTL);

// ── Main export ───────────────────────────────────────────────────────────────
async function getStreams(imdbId, mediaType = 'movie', season = null, episode = null) {
    const type = (mediaType === 'tv' || mediaType === 'series') ? 'series' : 'movie';

    // Build the resource ID
    let resourceId;
    if (type === 'series' && season != null && episode != null) {
        resourceId = `${imdbId}:${season}:${episode}`;
    } else {
        resourceId = imdbId;
    }

    const cacheKey = `aw_${resourceId}`;
    const hit = streamCache.get(cacheKey);
    if (hit) { console.log(`[AnimeWorld] Cache HIT ${resourceId}`); return hit; }

    const url = `${ADDON_BASE}/stream/${type}/${encodeURIComponent(resourceId)}.json`;
    console.log(`[AnimeWorld] ${url}`);

    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0',
                'Accept':          '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin':          'https://web.stremio.com',
                'Referer':         'https://web.stremio.com/'
            },
            signal: AbortSignal.timeout(15000)
        });

        if (!res.ok) {
            console.log(`[AnimeWorld] HTTP ${res.status}`);
            return [];
        }

        const data = await res.json();
        const raw = Array.isArray(data.streams) ? data.streams : [];

        const streams = raw.map(s => {
            if (!s.url) return null;
            // Clean up the title label
            const rawTitle = (s.title || '').trim();
            const name     = rawTitle.startsWith('[') ? `🌸 AnimeWorld | ${rawTitle}` : `🌸 AnimeWorld | ${rawTitle || 'Stream'}`;
            return {
                name,
                title: `AnimeWorld · Anime Streaming\nBy Murph Streams ⚡`,
                url:   s.url,
                behaviorHints: {
                    ...((s.behaviorHints || {})),
                    bingeGroup: 'animeworld'
                }
            };
        }).filter(Boolean);

        console.log(`[AnimeWorld] ${streams.length} stream(s) for ${resourceId}`);
        if (streams.length) streamCache.set(cacheKey, streams);
        return streams;

    } catch (err) {
        console.error(`[AnimeWorld] Error: ${err.message}`);
        return [];
    }
}

module.exports = { getStreams };