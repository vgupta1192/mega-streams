/**
 * DoFlix Provider v2.0 – Updated March 2026
 * Built from the latest DoFlix source, adapted for Mega's Streams.
 * By Mega Streams ⚡
 */

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const BASE_API = 'https://panel.watchkaroabhi.com';
const API_KEY = 'qNhKLJiZVyoKdi9NCQGz8CIGrpUijujE';
const HEADERS = {
    'X-Package-Name': 'com.king.moja',
    'User-Agent': 'dooflix',
    'X-App-Version': '305'
};
const STREAM_REFERER = 'https://molop.art/';

// ── LRU Cache (30 min) ───────────────────────────────────────────────────────
class LRUCache {
    constructor(max, ttl) {
        this.max = max;
        this.ttl = ttl;
        this.map = new Map();
    }
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

const streamCache = new LRUCache(200, 30 * 60 * 1000);

// ── Main function ─────────────────────────────────────────────────────────────
async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
    const cacheKey = `df_${tmdbId}_${mediaType}_${season}_${episode}`;
    const cached = streamCache.get(cacheKey);
    if (cached) {
        console.log(`[DoFlix] Cache HIT ${cacheKey}`);
        return cached;
    }

    console.log(`[DoFlix] Fetching streams: TMDB ${tmdbId}, type=${mediaType}`);

    let requestUrl;
    if (mediaType === 'movie') {
        requestUrl = `${BASE_API}/api/3/movie/${tmdbId}/links?api_key=${API_KEY}`;
    } else {
        if (!season || !episode) {
            console.error('[DoFlix] Missing season/episode for TV show');
            return [];
        }
        requestUrl = `${BASE_API}/api/3/tv/${tmdbId}/season/${season}/episode/${episode}/links?api_key=${API_KEY}`;
    }

    try {
        const response = await fetch(requestUrl, { headers: HEADERS });
        if (!response.ok) {
            console.log(`[DoFlix] API error: ${response.status}`);
            return [];
        }

        const data = await response.json();
        const links = data.links || [];
        const streams = [];

        for (const linkObj of links) {
            try {
                // follow redirect manually to get the real stream URL
                const res = await fetch(linkObj.url, {
                    method: 'GET',
                    headers: {
                        Referer: STREAM_REFERER,
                        'User-Agent': HEADERS['User-Agent']
                    },
                    redirect: 'manual'
                });

                const streamUrl = res.headers.get('location') || res.url;
                if (streamUrl && streamUrl !== linkObj.url) {
                    streams.push({
                        name: `🎬 DoFlix | ${linkObj.quality || 'HD'} | Hindi`,
                        title: `DoFlix ${linkObj.host ? ' · ' + linkObj.host : ''}\nBy Mega Streams ⚡`,
                        url: streamUrl,
                        behaviorHints: {
                            headers: {
                                Referer: STREAM_REFERER,
                                'User-Agent': HEADERS['User-Agent']
                            }
                        }
                    });
                }
            } catch (e) {
                console.log(`[DoFlix] Error resolving ${linkObj.url}: ${e.message}`);
            }
        }

        console.log(`[DoFlix] ${streams.length} stream(s) resolved`);
        streamCache.set(cacheKey, streams);
        return streams;

    } catch (error) {
        console.error(`[DoFlix] Error: ${error.message}`);
        return [];
    }
}

module.exports = { getStreams };