/**
 * HindMovie Provider v2.0
 * Uses HindMovie FastAPI: https://badboysxs-hh.hf.space
 * Scrapes hindmovie.ltd with mvlink/hshare bypass via REST API.
 * By Murph Streams ⚡
 */

'use strict';

const API_BASE = 'https://badboysxs-hh.hf.space';
const TAG = '[HindMovie]';

const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

function getCached(key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return undefined; }
    return entry.val;
}
function setCached(key, val) {
    if (cache.size > 200) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
    cache.set(key, { val, ts: Date.now() });
}

async function apiFetch(path, params) {
    const url = new URL(path, API_BASE);
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null && v !== 0) url.searchParams.set(k, v);
        }
    }
    const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(120000),
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) throw new Error(`${TAG} HTTP ${res.status} for ${url}`);
    return res.json();
}

async function tmdbMeta(tmdbId, mediaType) {
    const type = mediaType === 'tv' ? 'tv' : 'movie';
    const res = await fetch(
        `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=439c478a771f35c05022f9feabcca01c`,
        { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const d = await res.json();
    return {
        title: mediaType === 'tv' ? d.name : d.title,
        year: (mediaType === 'tv' ? d.first_air_date : d.release_date || '').slice(0, 4)
    };
}

function buildStream(row, serverKey, serverUrl, isTv, se, ep) {
    const lang = row.audio_lang || 'Hindi';
    const quality = row.quality || 'HD';
    const size = row.per_episode_size || '';

    // Beautiful format like hindmovie
    const streamName = `🎞️ HindMovie | ${quality} | ${lang}`;

    const lines = [];

    // Base title with episode tag
    let baseTitle = isTv && se != null && ep != null
        ? `S${String(se).padStart(2, '0')}E${String(ep).padStart(2, '0')}`
        : '';

    if (baseTitle) lines.push(baseTitle);

    // Tech line - clean format
    let techLine = `🎥 ${quality} · 🔊 ${lang}`;
    lines.push(techLine);

    // Size
    if (size && size !== 'N/A') {
        lines.push(`💾 ${size}`);
    }

    // Server badge
    lines.push(`⚡ ${serverKey}`);

    // By Murph Streams tagline
    lines.push("By Murph Streams ⚡");

    return {
        name:          streamName,
        title:         lines.join('\n'),
        url:           serverUrl,
        behaviorHints: {
            notWebReady: false,
            bingeGroup: `hindmovie-${quality.toLowerCase()}`
        }
    };
}

function extractStreams(results, isTv, se, ep) {
    const streams = [];
    let debugCount = 0;
    for (const row of results) {
        // Series: servers are inside row.episodes[0].servers (single episode filtered)
        // Movie: servers directly on row
        const episode = row.episodes && row.episodes[0];
        const servers = episode ? episode.servers : row.servers;
        if (!servers || typeof servers !== 'object') {
            console.log(`${TAG} No servers in row: quality=${row.quality}, hasEpisodes=${!!row.episodes}`);
            continue;
        }
        const keys = Object.keys(servers);
        if (!keys.length) {
            console.log(`${TAG} Empty servers object for quality=${row.quality}`);
            continue;
        }
        console.log(`${TAG} Found ${keys.length} servers for quality=${row.quality}, using Server 1`);
        // Only use Server 1 for each quality
        const firstKey = keys[0];
        const s = buildStream(row, firstKey, servers[firstKey], isTv, se, ep);
        if (s) { streams.push(s); debugCount++; }
    }
    // Sort: higher quality first
    streams.sort((a, b) => {
        const pa = parseInt((a.name || '').match(/\d+p/)?.[0] || 0);
        const pb = parseInt((b.name || '').match(/\d+p/)?.[0] || 0);
        return pb - pa;
    });
    console.log(`${TAG} Extracted ${debugCount} total streams from ${results.length} quality rows`);
    return streams;
}

async function getStreams(tmdbId, mediaType, season, episode) {
    const isTv = mediaType === 'tv' || mediaType === 'series';
    const se = isTv ? season || 1 : null;
    const ep = isTv ? episode || 1 : null;

    const cacheKey = `hm::${tmdbId}::${mediaType}::${se}::${ep}`;
    const cached = getCached(cacheKey);
    if (cached) {
        console.log(`${TAG} Cache HIT → ${cached.length} streams`);
        return cached;
    }

    const meta = await tmdbMeta(tmdbId, mediaType);
    if (!meta) {
        console.log(`${TAG} No TMDB meta for ${tmdbId}`);
        return [];
    }

    const { title, year } = meta;
    // HindMovie site doesn't index by year — strip it from search to avoid mismatches
    const searchTitle = title;
    console.log(`${TAG} ▶ ${title} ${mediaType}${isTv ? ` S${se}E${ep}` : ''}`);

    try {
        let data;
        if (isTv) {
            data = await apiFetch('/series', { q: searchTitle, season: se, episode: ep });
        } else {
            data = await apiFetch('/movie', { q: searchTitle });
        }

        // Debug: log raw response structure if no results
        if (!data.results || data.results.length === 0) {
            console.log(`${TAG} API returned no results — full response:`, JSON.stringify(data).substring(0, 500));
        }

        const streams = extractStreams(data.results || [], isTv, se, ep);
        console.log(`${TAG} ✓ ${streams.length} streams for "${title}"`);
        if (streams.length) setCached(cacheKey, streams);
        return streams;
    } catch (err) {
        console.error(`${TAG} ✗ ${err.message}`);
        return [];
    }
}

module.exports = { getStreams };