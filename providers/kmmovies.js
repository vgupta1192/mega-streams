/**
 * KMmovies Provider v2.0 – Stremio addon
 * By Mega Streams ⚡
 */

'use strict';

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const KMMOVIES_API = 'https://badboysxs-kmmovies.hf.space/search';
const PROVIDER_NAME = 'KMmovies';

// Simple in‑memory caches
const titleCache = new Map();   // key: `${tmdbId}_${mediaType}` → title
const streamCache = new Map();  // key: `${title}_${season}_${episode}` → streams

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function getCached(cache, key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > CACHE_TTL) {
        cache.delete(key);
        return undefined;
    }
    return entry.data;
}

function setCache(cache, key, data) {
    cache.set(key, { data, ts: Date.now() });
}

async function getTitleFromTmdb(tmdbId, mediaType) {
    const cacheKey = `${tmdbId}_${mediaType}`;
    const cached = getCached(titleCache, cacheKey);
    if (cached) return cached;

    const url = `https://api.themoviedb.org/3/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    console.log(`[KMmovies] Fetching title: TMDB ${tmdbId} (${mediaType})`);
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
        const data = await res.json();
        const title = mediaType === 'tv' ? data.name : data.title;
        if (title) {
            setCache(titleCache, cacheKey, title);
            return title;
        }
    } catch (err) {
        console.error(`[KMmovies] Title fetch error: ${err.message}`);
    }
    return null;
}

/**
 * Build title string in the style of 4KHDHub.
 *   For movies:       "[2.3GB] · Skydrop"
 *   For episodes:     "S01E01 [220MB] · Skydrop"
 *   For season packs: "[1.7GB] · Skydrop"
 */
function buildStreamTitle({ season, episode, size, server }) {
    const parts = [];

    // Season/episode prefix if applicable
    if (season != null && episode != null) {
        parts.push(`S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`);
    }

    // Size in brackets
    if (size) {
        parts.push(`[${size}]`);
    }

    // Server / source
    const displayServer = server && server !== 'Skydrop' ? server : 'Skydrop';
    parts.push('· ' + displayServer);

    return parts.join(' ');
}

async function fetchKMMoviesStreams(title, season, episode) {
    const cacheKey = `${title}_${season || 0}_${episode || 0}`;
    const cached = getCached(streamCache, cacheKey);
    if (cached) {
        console.log(`[KMmovies] Cache HIT for ${title}`);
        return cached;
    }

    let apiUrl = `${KMMOVIES_API}?query=${encodeURIComponent(title)}`;
    if (season != null) {
        apiUrl += `&season=${season}`;
        if (episode != null) apiUrl += `&episode=${episode}`;
    }

    console.log(`[KMmovies] API URL: ${apiUrl}`);
    try {
        const res = await fetch(apiUrl, { signal: AbortSignal.timeout(35000) });
        if (!res.ok) {
            console.log(`[KMmovies] API error: ${res.status}`);
            return [];
        }
        const data = await res.json();

        const streams = [];
        const type = data.type;
        const qualities = data.qualities || {};
        const seasonsData = data.seasons || {};

        console.log(`[KMmovies] Raw API response: type=${type}, qualities=${JSON.stringify(qualities)}, seasons=${JSON.stringify(seasonsData).substring(0,200)}`);

        if (type === 'movie') {
            for (const [quality, servers] of Object.entries(qualities)) {
                if (!servers || typeof servers !== 'object') continue;
                for (const [server, info] of Object.entries(servers)) {
                    const url = info?.url;
                    if (!url || !url.startsWith('http')) continue;
                    const size = info.size;
                    const lang = info.language || 'Hindi';

                    // Name: "🟡 KMmovies | 1080p | Hindi"
                    const name = `🟡 ${PROVIDER_NAME} | ${quality} | ${lang}`;
                    // Title: "[2.3GB] · Skydrop · By Mega Streams ⚡"
                    const streamTitle = buildStreamTitle({ size, server }) + '\nBy Mega Streams ⚡';

                    console.log(`[KMmovies] Adding movie stream: ${name}, url=${url.substring(0,80)}`);
                    streams.push({
                        name,
                        title: streamTitle,
                        url
                    });
                }
            }
        } else if (type === 'series') {
            // Only process if season is provided
            if (season != null && seasonsData && seasonsData[String(season)]) {
                // seasonsData["4"] IS the qualities object directly — destructure qualities from it
                const { qualities: qs } = seasonsData[String(season)];
                if (!qs) {
                    console.log('[KMmovies] No qualities found in season data');
                } else {
                    for (const [quality, qData] of Object.entries(qs)) {
                        const lang = qData.language || 'Hindi';

                        // Episodes
                        if (qData.episodes && typeof qData.episodes === 'object') {
                            for (const [epName, epInfo] of Object.entries(qData.episodes)) {
                                const epUrl = epInfo?.url;
                                if (!epUrl || !epUrl.startsWith('http')) continue;
                                const epSize = epInfo.size;

                                // Skip if specific episode filter doesn't match
                                if (episode != null) {
                                    const epNumMatch = epName.match(/\d+/);
                                    if (!epNumMatch || parseInt(epNumMatch[0]) !== episode) continue;
                                }

                                // Extract episode number from episode name to use in title
                                const currentEpisode = episode != null ? episode : (parseInt((epName.match(/\d+/) || [])[0]) || null);

                                const streamTitle = buildStreamTitle({
                                    season,
                                    episode: currentEpisode,
                                    size: epSize,
                                    server: 'Skydrop'
                                });

                                const name = `🟡 ${PROVIDER_NAME} | ${quality} | ${lang}`;
                                const titleWithTag = streamTitle + '\nBy Mega Streams ⚡';

                                console.log(`[KMmovies] Adding series stream: ${name}, ep=${epName}, url=${epUrl.substring(0,80)}`);
                                streams.push({
                                    name,
                                    title: titleWithTag,
                                    url: epUrl
                                });
                            }
                        }

                        // Combined season pack
                        if (qData.combined && typeof qData.combined === 'object') {
                            for (const [server, info] of Object.entries(qData.combined)) {
                                const combUrl = info?.url;
                                if (!combUrl || !combUrl.startsWith('http')) continue;
                                const combSize = info.size;

                                const streamTitle = buildStreamTitle({ size: combSize, server }) + '\nBy Mega Streams ⚡';
                                const name = `🟡 ${PROVIDER_NAME} | ${quality} | ${lang} (Season Pack)`;

                                streams.push({
                                    name,
                                    title: streamTitle,
                                    url: combUrl
                                });
                            }
                        }
                    }
                }
            } else {
                console.log('[KMmovies] Series requested without season; skipping.');
            }
        }

        console.log(`[KMmovies] Resolved ${streams.length} streams`);
        console.log(`[KMmovies] Stream details: ${JSON.stringify(streams, null, 2).substring(0,500)}`);
        setCache(streamCache, cacheKey, streams);
        return streams;
    } catch (err) {
        console.error(`[KMmovies] Error: ${err.message}`);
        return [];
    }
}

async function getStreams(tmdbId, mediaType, season, episode) {
    const title = await getTitleFromTmdb(tmdbId, mediaType);
    if (!title) {
        console.log('[KMmovies] Could not fetch title, skipping.');
        return [];
    }
    return await fetchKMMoviesStreams(title, season, episode);
}

module.exports = { getStreams };