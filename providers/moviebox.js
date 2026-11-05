const axios = require('axios');

// Simple in-memory LRU Cache
function Cache(max, ttl) {
    this.max = max; this.ttl = ttl; this.d = {}; this.ks = [];
}
Cache.prototype.get = function (k) {
    var e = this.d[k];
    if (!e) return undefined;
    if (Date.now() - e.t > this.ttl) { delete this.d[k]; return undefined; }
    return e.v;
};
Cache.prototype.set = function (k, v) {
    if (this.d[k]) { this.d[k] = { v: v, t: Date.now() }; return; }
    if (this.ks.length >= this.max) delete this.d[this.ks.shift()];
    this.ks.push(k);
    this.d[k] = { v: v, t: Date.now() };
};

const _cache = new Cache(300, 20 * 60 * 1000); // 20 min TTL
const WORKER_BASE = 'https://moviebox.s4nch1tt.workers.dev';
const TAG = '[MovieBox Provider]';

async function getStreams(tmdbId, type, season, episode) {
    const mediaType = (type === 'series' || type === 'tv') ? 'tv' : 'movie';
    const isTv = mediaType === 'tv';
    const se = isTv ? (season ? parseInt(season) : 1) : null;
    const ep = isTv ? (episode ? parseInt(episode) : 1) : null;

    const cacheKey = 'mb_' + tmdbId + '_' + mediaType + '_' + se + '_' + ep;
    const cached = _cache.get(cacheKey);
    if (cached) {
        console.log(TAG + ' Cache HIT: ' + cacheKey);
        return cached;
    }

    var url = WORKER_BASE + '/streams'
        + '?tmdb_id=' + encodeURIComponent(tmdbId)
        + '&type=' + encodeURIComponent(mediaType)
        + '&proxy=' + encodeURIComponent(WORKER_BASE);

    if (isTv) {
        url += '&se=' + se;
        url += '&ep=' + ep;
    }

    try {
        const response = await axios.get(url, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Nuvio/1.0' },
            timeout: 8000,
            maxRedirects: 5
        });

        const data = response.data;
        const rawStreams = Array.isArray(data) ? data : (data && Array.isArray(data.streams) ? data.streams : []);

        if (!rawStreams.length) {
            return [];
        }

        const streams = rawStreams.map(s => {
            const streamUrl = s.proxy_url || s.url || '';
            if (!streamUrl) return null;

            let quality = 'Auto';
            if (s.resolution) {
                const m = String(s.resolution).match(/(\d+)/);
                quality = m ? m[1] + 'p' : String(s.resolution);
            }

            let lang = 'Original';
            const langMatch = (s.name || '').match(/\(([^)]+)\)/);
            if (langMatch) lang = langMatch[1];

            const titleBase = (s.title || '').split(' S0')[0].split(' S1')[0].trim();
            const isHindi = lang.toLowerCase().includes('hindi') || (s.name || '').toLowerCase().includes('hindi');

            return {
                server: 'MovieBox - ' + quality,
                title: `${titleBase || 'MovieBox'} [${quality} - ${lang}]`,
                url: streamUrl,
                isHindi: isHindi
            };
        }).filter(Boolean);

        // Sort highest resolution first
        streams.sort(function (a, b) {
            var pa = parseInt((a.server || '').match(/\d+/) || [0]);
            var pb = parseInt((b.server || '').match(/\d+/) || [0]);
            return pb - pa;
        });

        if (streams.length) {
            _cache.set(cacheKey, streams);
        }

        return streams;
    } catch (error) {
        console.error(TAG + ' Error: ' + error.message);
        return [];
    }
}

module.exports = { getStreams };
