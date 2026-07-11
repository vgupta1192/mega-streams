/*
 * NetMirror plugin v2.0 (fixed – no crypto dependency)
 * By Murph Streams ⚡
 */

const TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
const NETMIRROR_BASE = "https://net22.cc";      // bypass only
const NETMIRROR_PLAY = "https://net52.cc";      // content API

// Pure JS UUID v4 generator (no crypto needed)
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0,
        v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

const BASE_HEADERS = {
  "X-Requested-With": "XMLHttpRequest",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.5",
  "Connection": "keep-alive"
};

let globalCookie = "";
let cookieTimestamp = 0;
const COOKIE_EXPIRY = 54_000_000; // 15 hours

function makeRequest(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { ...BASE_HEADERS, ...options.headers },
    timeout: 10_000
  }).then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response;
  });
}

function getUnixTime() {
  return Math.floor(Date.now() / 1000);
}

// ============ Bypass (fixed) ============
async function bypass() {
  const now = Date.now();
  if (globalCookie && cookieTimestamp && (now - cookieTimestamp < COOKIE_EXPIRY)) {
    console.log("[NetMirror] Using cached authentication cookie");
    return globalCookie;
  }

  console.log("[NetMirror] Bypassing authentication via verifycheck...");
  const headers = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "max-age=0",
    "Connection": "keep-alive",
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": "https://net22.cc",
    "Referer": "https://net22.cc/verify2",
    "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
  };

  const formBody = new URLSearchParams();
  formBody.append("g-recaptcha-response", generateUUID());   // <-- FIX HERE

  const response = await fetch("https://net22.cc/verifycheck", {
    method: "POST",
    headers: headers,
    body: formBody.toString(),
    redirect: "manual"
  });

  const setCookie = response.headers.get("set-cookie") || "";
  const match = setCookie.match(/t_hash_t=([^;]+)/);
  if (!match) throw new Error("Failed to extract t_hash_t cookie");

  globalCookie = match[1];
  cookieTimestamp = Date.now();
  console.log("[NetMirror] Authentication successful");
  return globalCookie;
}

// ============ Platform configuration ============
const PLATFORM_CONFIG = {
  "netflix": {
    ott: "nf",
    search: "/search.php",
    post: "/post.php",
    episodes: "/episodes.php",
    playlist: "/playlist.php",
    posterBase: "https://imgcdn.kim/poster/v/",
    backdropBase: "https://imgcdn.kim/poster/v/",
    episodeThumbBase: "https://imgcdn.kim/poster/v/150/"
  },
  "primevideo": {
    ott: "pv",
    search: "/pv/search.php",
    post: "/pv/post.php",
    episodes: "/pv/episodes.php",
    playlist: "/pv/playlist.php",
    posterBase: "https://imgcdn.kim/pv/v/",
    backdropBase: "https://imgcdn.kim/pv/h/",
    episodeThumbBase: "https://imgcdn.kim/pvepimg/"
  },
  "disney": {
    ott: "dp",
    search: "/mobile/hs/search.php",
    post: "/mobile/hs/post.php",
    episodes: "/mobile/hs/episodes.php",
    playlist: "/mobile/hs/playlist.php",
    extraCookies: { studio: "disney" },
    posterBase: "https://imgcdn.kim/hs/v/",
    backdropBase: "https://imgcdn.kim/hs/h/",
    episodeThumbBase: "https://imgcdn.kim/hsepimg/150/"
  }
};

function buildCookieString(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

function buildCookies(platform) {
  const cfg = PLATFORM_CONFIG[platform];
  return { ott: cfg.ott, hd: "on", ...cfg.extraCookies };
}

// ============ Improved title matching ============
function calculateSimilarity(str1, str2) {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  if (s1 === s2) return 1;

  const words1 = s1.split(/\s+/).filter(w => w.length > 0);
  const words2 = s2.split(/\s+/).filter(w => w.length > 0);

  // If one string contains the other entirely, high score
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;

  // Word overlap ratio
  let matches = 0;
  for (const w of words1) {
    if (words2.includes(w)) matches++;
  }
  const ratio = matches / Math.max(words1.length, words2.length);
  return ratio;
}

function findBestMatch(results, title, year) {
  // 1. Exact normalised match
  const exact = results.find(r => r.title.toLowerCase().trim() === title.toLowerCase().trim());
  if (exact) return exact;

  // 2. Same title and year match (year might be in the result title)
  if (year) {
    const yearMatch = results.find(r => {
      const t = r.title.toLowerCase();
      return t.includes(title.toLowerCase()) && t.includes(year);
    });
    if (yearMatch) return yearMatch;
  }

  // 3. Similarity scoring
  const scored = results.map(r => ({
    result: r,
    score: calculateSimilarity(r.title, title)
  }));
  scored.sort((a, b) => b.score - a.score);
  if (scored[0] && scored[0].score >= 0.7) return scored[0].result;

  // 4. Fallback: first result only if title is contained
  for (const r of results) {
    if (r.title.toLowerCase().includes(title.toLowerCase())) return r;
  }

  // 5. Last resort: first result (but log a warning)
  console.warn(`[NetMirror] No good match for "${title}", falling back to first result`);
  return results[0];
}

// ============ Search ============
async function searchContent(query, platform) {
  console.log(`[NetMirror] Searching for "${query}" on ${platform}...`);
  const cookie = await bypass();
  const cfg = PLATFORM_CONFIG[platform];
  const cookies = { t_hash_t: cookie, ...buildCookies(platform) };
  const url = `${NETMIRROR_PLAY}${cfg.search}?s=${encodeURIComponent(query)}&t=${getUnixTime()}`;

  const response = await makeRequest(url, {
    headers: {
      "Cookie": buildCookieString(cookies),
      "Referer": `${NETMIRROR_PLAY}/home`
    }
  });
  const data = await response.json();

  if (data.searchResult && data.searchResult.length > 0) {
    console.log(`[NetMirror] Found ${data.searchResult.length} results`);
    return data.searchResult.map(item => ({
      id: item.id,
      title: item.t,
      posterUrl: `${cfg.posterBase}${item.id}.jpg`
    }));
  }
  console.log("[NetMirror] No results found");
  return [];
}

// ============ Load content ============
async function loadContent(contentId, platform) {
  console.log(`[NetMirror] Loading content details for ID: ${contentId}`);
  const cookie = await bypass();
  const cfg = PLATFORM_CONFIG[platform];
  const cookies = { t_hash_t: cookie, ...buildCookies(platform) };
  const url = `${NETMIRROR_PLAY}${cfg.post}?id=${contentId}&t=${getUnixTime()}`;

  const response = await makeRequest(url, {
    headers: {
      "Cookie": buildCookieString(cookies),
      "Referer": `${NETMIRROR_PLAY}/home`
    }
  });
  const postData = await response.json();
  console.log(`[NetMirror] Loaded: ${postData.title}`);

  let allEpisodes = postData.episodes || [];
  const isMovie = !allEpisodes.length || allEpisodes[0] === null;

  if (!isMovie && postData.episodes[0] !== null) {
    let episodePromise = Promise.resolve();

    if (postData.nextPageShow === 1 && postData.nextPageSeason) {
      episodePromise = episodePromise.then(() =>
        getEpisodesFromSeason(contentId, postData.nextPageSeason, platform, 2)
      ).then(additional => allEpisodes.push(...additional));
    }

    if (postData.season && postData.season.length > 1) {
      const otherSeasons = postData.season.slice(0, -1);
      otherSeasons.forEach(season => {
        episodePromise = episodePromise.then(() =>
          getEpisodesFromSeason(contentId, season.id, platform, 1)
        ).then(seasonEps => allEpisodes.push(...seasonEps));
      });
    }

    await episodePromise;
    console.log(`[NetMirror] Loaded ${allEpisodes.filter(ep => ep !== null).length} total episodes`);
  }

  return {
    id: contentId,
    title: postData.title,
    description: postData.desc,
    year: postData.year,
    episodes: allEpisodes,
    seasons: postData.season || [],
    isMovie
  };
}

// ============ Episodes from season ============
async function getEpisodesFromSeason(seriesId, seasonId, platform, page) {
  const cookie = await bypass();
  const cfg = PLATFORM_CONFIG[platform];
  const cookies = { t_hash_t: cookie, ...buildCookies(platform) };
  const episodes = [];
  let currentPage = page || 1;

  async function fetchPage(pageNum) {
    const url = `${NETMIRROR_PLAY}${cfg.episodes}?s=${seasonId}&series=${seriesId}&t=${getUnixTime()}&page=${pageNum}`;
    try {
      const response = await makeRequest(url, {
        headers: {
          "Cookie": buildCookieString(cookies),
          "Referer": `${NETMIRROR_PLAY}/home`
        }
      });
      const epData = await response.json();
      if (epData.episodes) episodes.push(...epData.episodes);
      if (epData.nextPageShow !== 0) return fetchPage(pageNum + 1);
    } catch (err) {
      console.log(`[NetMirror] Failed to load season page ${pageNum}`);
    }
    return episodes;
  }

  return fetchPage(currentPage);
}

// ============ Get streaming links ============
async function getStreamingLinks(contentId, title, platform) {
  console.log(`[NetMirror] Getting streaming links for: ${title}`);
  const cookie = await bypass();
  const cfg = PLATFORM_CONFIG[platform];
  const cookies = { t_hash_t: cookie, ...buildCookies(platform) };
  const url = `${NETMIRROR_PLAY}${cfg.playlist}?id=${contentId}&t=${encodeURIComponent(title)}&tm=${getUnixTime()}`;

  const response = await makeRequest(url, {
    headers: {
      "Cookie": buildCookieString(cookies),
      "Referer": `${NETMIRROR_PLAY}/`
    }
  });
  const playlist = await response.json();

  if (!Array.isArray(playlist) || playlist.length === 0) {
    console.log("[NetMirror] No streaming links found");
    return { sources: [], subtitles: [] };
  }

  const sources = [];
  const subtitles = [];

  playlist.forEach(item => {
    if (item.sources) {
      item.sources.forEach(source => {
        let fullUrl = source.file.startsWith("/")
          ? `${NETMIRROR_PLAY}${source.file}`
          : source.file;
        fullUrl = fullUrl.replace("/tv/", "/");
        sources.push({
          url: fullUrl,
          quality: source.label,
          type: source.type || "application/x-mpegURL"
        });
      });
    }

    if (item.tracks) {
      item.tracks
        .filter(track => track.kind === "captions")
        .forEach(track => {
          let subUrl = track.file;
          if (subUrl.startsWith("/") && !subUrl.startsWith("//")) {
            subUrl = `${NETMIRROR_PLAY}${subUrl}`;
          } else if (subUrl.startsWith("//")) {
            subUrl = `https:${subUrl}`;
          }
          subtitles.push({
            url: subUrl,
            language: track.label
          });
        });
    }
  });

  console.log(`[NetMirror] Found ${sources.length} sources and ${subtitles.length} subtitle tracks`);
  return { sources, subtitles };
}

// ============ Main stream fetching function ============
async function getStreams(tmdbId, mediaType = "movie", seasonNum = null, episodeNum = null) {
  console.log(`[NetMirror] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}${seasonNum ? `, S${seasonNum}E${episodeNum}` : ""}`);

  const tmdbUrl = `https://api.themoviedb.org/3/${mediaType === "tv" ? "tv" : "movie"}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  const tmdbResponse = await makeRequest(tmdbUrl);
  const tmdbData = await tmdbResponse.json();

  const title = mediaType === "tv" ? tmdbData.name : tmdbData.title;
  const year = mediaType === "tv"
    ? (tmdbData.first_air_date || "").substring(0, 4)
    : (tmdbData.release_date || "").substring(0, 4);

  if (!title) throw new Error("Could not extract title from TMDB response");

  console.log(`[NetMirror] TMDB Info: "${title}" (${year})`);

  let platforms = ["netflix", "primevideo", "disney"];
  if (title.toLowerCase().includes("boys") || title.toLowerCase().includes("prime"))
    platforms = ["primevideo", "netflix", "disney"];

  for (const platform of platforms) {
    try {
      for (const searchQuery of [title, `${title} ${year}`]) {
        const results = await searchContent(searchQuery, platform);
        if (!results.length) continue;

        // --- Use the new smart matcher ---
        const match = findBestMatch(results, title, year);

        console.log(`[NetMirror] Matched on ${platform}: ${match.title} (ID: ${match.id})`);

        const contentData = await loadContent(match.id, platform);
        let targetId = match.id;

        if (mediaType === "tv" && !contentData.isMovie) {
          const validEps = contentData.episodes.filter(ep => ep !== null);
          const episodeData = validEps.find(ep => {
            const epSeason = parseInt((ep.s || ep.season || "").replace("S", ""));
            const epNumber = parseInt((ep.ep || ep.episode || "").replace("E", ""));
            return epSeason === (seasonNum || 1) && epNumber === (episodeNum || 1);
          });

          if (!episodeData) {
            console.log(`[NetMirror] Episode S${seasonNum}E${episodeNum} not found`);
            continue;
          }
          targetId = episodeData.id;
        }

        const { sources, subtitles } = await getStreamingLinks(targetId, title, platform);
        if (!sources.length) continue;

        // Build the complete cookie string for proxy use
        const cookie = await bypass();
        const cfg = PLATFORM_CONFIG[platform];
        const cookieString = `t_hash_t=${cookie}; ott=${cfg.ott}; hd=on`;

        const streams = sources.map(source => {
          let quality = "HD";
          const qMatch = source.url.match(/[?&]q=(\d+p)/i);
          if (qMatch) quality = qMatch[1];
          else if (source.quality) {
            const lq = source.quality.match(/(\d+p)/i);
            if (lq) quality = lq[1];
            else if (source.quality.includes("1080")) quality = "1080p";
            else if (source.quality.includes("720")) quality = "720p";
            else if (source.quality.includes("480")) quality = "480p";
            else quality = source.quality;
          }

          const platformNames = {
            netflix: "Netflix",
            primevideo: "Prime Video",
            disney: "Disney+"
          };
          const label = `🪞 NetMirror | ${quality} | ${platformNames[platform]}`;
          let streamTitle = `${title} ${year ? `(${year})` : ""}`;
          if (mediaType === "tv") streamTitle += ` · S${seasonNum}E${episodeNum}`;
          streamTitle += `\n🎥 ${quality} · 🔊 ${platformNames[platform]}\nBy Murph Streams ⚡`;

          return {
            name: label,
            title: streamTitle,
            url: source.url,
            quality,
            type: "hls",
            // Custom headers with all required cookies
            headers: {
              "Cookie":     cookieString,
              "Referer":    `${NETMIRROR_PLAY}/home`,
              "User-Agent": "Mozilla/5.0 (Android) ExoPlayer",
              "Accept":     "*/*",
              "Connection": "keep-alive"
            }
          };
        });

        // Attach subtitles (proxied with same headers)
        const formattedSubtitles = (subtitles || []).map(sub => ({
          url: sub.url,
          lang: sub.language
        }));
        streams.forEach(s => {
          s.subtitles = formattedSubtitles;
        });

        streams.sort((a, b) => {
          const getQ = q => parseInt((q.match(/(\d{3,4})p/i) || [])[1]) || 0;
          return getQ(b.quality) - getQ(a.quality);
        });

        console.log(`[NetMirror] Success - ${streams.length} streams from ${platform}`);
        return streams;
      }
    } catch (err) {
      console.log(`[NetMirror] Error on ${platform}: ${err.message}`);
    }
  }

  console.log("[NetMirror] No content found on any platform");
  return [];
}

// Export
if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams };
} else if (typeof global !== "undefined") {
  global.getStreams = getStreams;
}