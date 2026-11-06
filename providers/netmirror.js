const { getDetails } = require('../utils/tmdb');

const STREAM_CACHE_TTL = 25 * 60 * 1000;
const PLATFORM_ORDER = ['netflix', 'primevideo', 'hotstar', 'disney'];

const UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0'
];
let uaIndex = 0;
function nextUA() { return UA_POOL[uaIndex++ % UA_POOL.length]; }

const streamCache = new Map();
const inflight = new Map();
let resolvedApiUrl = '';

const NEW_TV_DOMAINS = [
    'aHR0cHM6Ly9uZXQ1Mi5jYw==', // net52.cc
    'aHR0cHM6Ly9uZXQyNy5jYw==', // net27.cc
    'aHR0cHM6Ly9tb2JpbGVkZXRlY3RzLmNvbQ==',
    'aHR0cHM6Ly9tb2JpbGVkZXRlY3QuYXBw',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LmFydA==',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LmNj',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LnZpcA=='
];

const PLATFORM_MAP = {
    netflix: { ott: 'nf', label: 'Netflix' },
    primevideo: { ott: 'pv', label: 'Prime Video' },
    hotstar: { ott: 'hs', label: 'Hotstar' },
    disney: { ott: 'hs', label: 'Disney' }
};

function newTvHeaders(ott, extra = {}) {
    return {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Requested-With': 'NetmirrorNewTV v1.0',
        'Accept': 'application/json, text/plain, */*',
        'Ott': ott,
        'User-Agent': nextUA(),
        ...extra
    };
}

// Safe helper to parse JSON and avoid HTML crash (Fixes Unexpected token 'P', "Page Not Found")
async function safeJsonFetch(url, options) {
    const response = await fetch(url, options);
    const text = await response.text();
    try {
        const json = JSON.parse(text);
        return { ok: response.ok, data: json };
    } catch (e) {
        throw new Error(`Invalid JSON response from ${url} (Status: ${response.status}): ${text.substring(0, 100)}`);
    }
}

async function resolveNewTvApi() {
    if (resolvedApiUrl) return resolvedApiUrl;
    
    const customBase = process.env.NETMIRROR_API_BASE;
    const domains = [
        ...(customBase ? [customBase] : []),
        ...NEW_TV_DOMAINS.map((value) => Buffer.from(value, 'base64').toString('utf8').replace(/\/$/, ''))
    ];

    console.log(`[NetMirror Debug] Resolving API domain from list:`, domains);

    for (const domain of domains) {
        try {
            console.log(`[NetMirror Debug] Trying domain check: ${domain}/checknewtv.php`);
            const { ok, data } = await safeJsonFetch(`${domain}/checknewtv.php`, {
                headers: newTvHeaders('nf'),
                signal: AbortSignal.timeout(8000)
            });
            console.log(`[NetMirror Debug] Domain ${domain} responded:`, data);
            
            if (data.token_hash) {
                resolvedApiUrl = Buffer.from(data.token_hash, 'base64').toString('utf8').replace(/\/$/, '');
                console.log(`[NetMirror Debug] Successfully resolved via token_hash: ${resolvedApiUrl}`);
                return resolvedApiUrl;
            }
            if (ok) {
                resolvedApiUrl = domain;
                console.log(`[NetMirror Debug] Successfully resolved via domain ok: ${resolvedApiUrl}`);
                return resolvedApiUrl;
            }
        } catch (err) {
            console.log(`[NetMirror Debug] Domain ${domain} failed: ${err.message}`);
        }
    }

    resolvedApiUrl = 'https://net52.cc';
    console.log(`[NetMirror Debug] Fallback to default domain: ${resolvedApiUrl}`);
    return resolvedApiUrl;
}

async function fetchPlatform(platform, title, type, season, episode) {
    try {
        const config = PLATFORM_MAP[platform];
        if (!config) return [];
        
        const api = await resolveNewTvApi();
        console.log(`[NetMirror Debug] Searching for title "${title}" on platform [${platform}] using API: ${api}`);

        const searchUrl = `${api}/newtv/search.php?s=${encodeURIComponent(title)}`;
        const { data: searchData } = await safeJsonFetch(searchUrl, {
            headers: newTvHeaders(config.ott),
            signal: AbortSignal.timeout(12000)
        });
        console.log(`[NetMirror Debug] Search results for "${title}" on ${platform}:`, searchData);

        const first = (searchData.searchResult || [])[0];
        if (!first || !first.id) {
            console.log(`[NetMirror Debug] No search match found for "${title}" on ${platform}`);
            return [];
        }

        console.log(`[NetMirror Debug] Found match ID: ${first.id} for title: ${first.t}`);

        const { data: postData } = await safeJsonFetch(
            `${api}/newtv/post.php?id=${encodeURIComponent(first.id)}`,
            { headers: newTvHeaders(config.ott, { Lastep: '', Usertoken: '' }), signal: AbortSignal.timeout(12000) }
        );
        console.log(`[NetMirror Debug] Post data fetched for ID ${first.id}, type: ${postData.type}`);

        let targetId = first.id;
        if (type === 'series') {
            targetId = first.id;
        } else {
            targetId = postData.main_id || first.id;
        }

        const { data: player } = await safeJsonFetch(
            `${api}/newtv/player.php?id=${encodeURIComponent(targetId)}`,
            { headers: newTvHeaders(config.ott, { Usertoken: '' }), signal: AbortSignal.timeout(12000) }
        );
        console.log(`[NetMirror Debug] Player response for target ID ${targetId}:`, player);

        if (!player.video_link) {
            console.log(`[NetMirror Debug] No video_link found in player response for ${title}`);
            return [];
        }

        const streamReferer = process.env.NETMIRROR_STREAM_REFERER || player.referer || api;

        return [{
            name: `NetMirror | ${config.label}`,
            title: `${title}\nAuto`,
            url: player.video_link,
            quality: 'Auto',
            provider: 'NetMirror',
            headers: {
                Referer: streamReferer,
                'User-Agent': nextUA()
            }
        }];
    } catch (error) {
        console.log(`[NetMirror Error] Platform ${platform} failed for "${title}": ${error.message}`);
        return [];
    }
}

async function getNetmirrorStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[NetMirror] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

    const type = mediaType === 'tv' ? 'series' : 'movie';
    const season = mediaType === 'tv' ? (seasonNum || 1) : null;
    const episode = mediaType === 'tv' ? (episodeNum || 1) : null;

    try {
        const details = await getDetails(mediaType === 'tv' ? 'tv' : 'movie', tmdbId);
        const title = (details && (details.title || details.name)) || '';
        console.log(`[NetMirror] Resolved TMDB ID ${tmdbId} to title: "${title}"`);
        
        if (!title) {
            console.log(`[NetMirror] No TMDB title resolved for ${tmdbId}`);
            return [];
        }

        const results = await Promise.all(
            PLATFORM_ORDER.map((platform) => fetchPlatform(platform, title, type, season, episode))
        );
        const streams = results.flat();
        console.log(`[NetMirror] Total streams found for ${title}: ${streams.length}`);
        return streams;
    } catch (err) {
        console.error(`[NetMirror Critical Error] ${err.message}`);
        return [];
    }
}

module.exports = { getNetmirrorStreams };
