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

async function resolveNewTvApi() {
    if (resolvedApiUrl) return resolvedApiUrl;
    
    const customBase = process.env.NETMIRROR_API_BASE;
    const domains = [
        ...(customBase ? [customBase] : []),
        ...NEW_TV_DOMAINS.map((value) => Buffer.from(value, 'base64').toString('utf8').replace(/\/$/, ''))
    ];

    for (const domain of domains) {
        try {
            const response = await fetch(`${domain}/checknewtv.php`, {
                headers: newTvHeaders('nf'),
                signal: AbortSignal.timeout(8000)
            });
            const data = await response.json();
            if (data.token_hash) {
                resolvedApiUrl = Buffer.from(data.token_hash, 'base64').toString('utf8').replace(/\/$/, '');
                return resolvedApiUrl;
            }
            if (response.ok) {
                resolvedApiUrl = domain;
                return resolvedApiUrl;
            }
        } catch {
            // Try next domain
        }
    }

    // Fallback default
    resolvedApiUrl = 'https://net52.cc';
    return resolvedApiUrl;
}

function parseNumber(value) {
    if (!value) return null;
    const parsed = parseInt(String(value).replace(/[^\d]/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

async function getEpisodes(api, postData, ottConfig) {
    const result = [];
    const selectedSeason = Array.isArray(postData.season) ? postData.season.findIndex((item) => item.sele === "1" || item.selected) : -1;
    const selectedSeasonId = selectedSeason >= 0 ? postData.season[selectedSeason].id : postData.nextPageSeason;
    
    const add = (episode, seasonNumber) => {
        result.push({
            id: episode.id,
            s: seasonNumber || parseNumber(episode.s) || 1,
            ep: parseNumber(episode.ep) || parseNumber(episode.episode)
        });
    };

    for (const episode of postData.episodes || []) {
        if (episode) add(episode, selectedSeason >= 0 ? selectedSeason + 1 : 1);
    }

    if (postData.nextPageShow === 1 && selectedSeasonId) {
        try {
            const response = await fetch(
                `${api}/newtv/episodes.php?id=${encodeURIComponent(selectedSeasonId)}&page=2`,
                { headers: newTvHeaders(ottConfig), signal: AbortSignal.timeout(10000) }
            );
            const data = await response.json();
            for (const episode of data.episodes || []) {
                if (episode) add(episode, selectedSeason >= 0 ? selectedSeason + 1 : 1);
            }
        } catch {
            // Ignore pagination error
        }
    }

    return result;
}

async function fetchPlatform(platform, title, type, season, episode) {
    try {
        const config = PLATFORM_MAP[platform];
        if (!config) return [];
        
        const api = await resolveNewTvApi();
        const searchResponse = await fetch(
            `${api}/newtv/search.php?s=${encodeURIComponent(title)}`,
            { headers: newTvHeaders(config.ott), signal: AbortSignal.timeout(12000) }
        );
        const searchData = await searchResponse.json();
        const first = (searchData.searchResult || [])[0];
        if (!first || !first.id) return [];

        const postResponse = await fetch(
            `${api}/newtv/post.php?id=${encodeURIComponent(first.id)}`,
            { headers: newTvHeaders(config.ott, { Lastep: '', Usertoken: '' }), signal: AbortSignal.timeout(12000) }
        );
        const postData = await postResponse.json();

        let targetId = first.id;
        if (type === 'series') {
            const episodes = await getEpisodes(api, postData, config.ott);
            const target = episodes.find((item) => Number(item.s) === Number(season) && Number(item.ep) === Number(episode));
            if (!target) return [];
            targetId = target.id;
        } else {
            targetId = postData.main_id || first.id;
        }

        const playerResponse = await fetch(
            `${api}/newtv/player.php?id=${encodeURIComponent(targetId)}`,
            { headers: newTvHeaders(config.ott, { Usertoken: '' }), signal: AbortSignal.timeout(12000) }
        );
        const player = await playerResponse.json();
        if (!player.video_link) return [];

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
        console.log(`[NetMirror] ${platform} failed: ${error.message}`);
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
        if (!title) {
            console.log(`[NetMirror] No TMDB title resolved for ${tmdbId}`);
            return [];
        }

        const key = `${tmdbId}:${type}:${season || 0}:${episode || 0}`;
        const cached = streamCache.get(key);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.streams;
        }
        const running = inflight.get(key);
        if (running) return running;

        const request = (async () => {
            // Run platform searches in parallel for maximum speed
            const results = await Promise.all(
                PLATFORM_ORDER.map((platform) => fetchPlatform(platform, title, type, season, episode))
            );
            const streams = results.flat();
            streamCache.set(key, { streams, expiresAt: Date.now() + STREAM_CACHE_TTL });
            console.log(`[NetMirror] ${tmdbId} streams ready: ${streams.length}`);
            return streams;
        })().finally(() => inflight.delete(key));

        inflight.set(key, request);
        return request;
    } catch (err) {
        console.error(`[NetMirror] Error: ${err.message}`);
        return [];
    }
}

module.exports = { getNetmirrorStreams };
