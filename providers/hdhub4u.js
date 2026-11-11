const https = require('https');
const http = require('http');
const { URL } = require('url');
const cheerio = require('cheerio');

// Configuration
let MAIN_URL = "https://new3.hdhub4u.fo";
const DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";
const DOMAIN_CACHE_TTL = 4 * 60 * 60 * 1000;
let domainCacheTimestamp = 0;

// आपकी TMDB API Key यहाँ सेट कर दी गई है
const TMDB_API_KEY = "83ec7009a9fdb16a980f5bac7db19d2f";

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Cookie": "xla=s4t",
    "Referer": `${MAIN_URL}/`
};

function updateMainUrl(url) {
    MAIN_URL = url.replace(/\/$/, "");
    HEADERS.Referer = `${MAIN_URL}/`;
}

// --- Network Request Helper (4KHDHub स्टाइल) ---
function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const maxRedirects = options.maxRedirects || 10;
        let redirectCount = 0;

        const doRequest = (currentUrl) => {
            try {
                const urlObj = new URL(currentUrl);
                const isHttps = urlObj.protocol === 'https:';
                const httpModule = isHttps ? https : http;

                const requestOptions = {
                    hostname: urlObj.hostname,
                    port: urlObj.port || (isHttps ? 443 : 80),
                    path: urlObj.pathname + urlObj.search,
                    method: options.method || 'GET',
                    headers: {
                        ...HEADERS,
                        ...options.headers
                    },
                    timeout: 25000
                };

                const req = httpModule.request(requestOptions, (res) => {
                    const redirectCodes = [301, 302, 303, 307, 308];
                    const isRedirect = redirectCodes.includes(res.statusCode);
                    const location = res.headers['location'];

                    if (isRedirect && location && redirectCount < maxRedirects) {
                        redirectCount++;
                        res.resume();
                        let nextUrl;
                        try {
                            nextUrl = new URL(location, currentUrl).toString();
                        } catch (e) {
                            resolve({ statusCode: res.statusCode, headers: res.headers, body: '', url: currentUrl });
                            return;
                        }
                        doRequest(nextUrl);
                        return;
                    }

                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (options.parseHTML && data) {
                            const $ = cheerio.load(data);
                            resolve({ $: $, body: data, statusCode: res.statusCode, headers: res.headers, url: currentUrl });
                        } else {
                            resolve({ body: data, statusCode: res.statusCode, headers: res.headers, url: currentUrl });
                        }
                    });
                });

                req.on('error', reject);
                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('Request timeout'));
                });
                req.end();
            } catch (err) {
                reject(err);
            }
        };

        doRequest(url);
    });
}

// --- Base64 & ROT13 Helpers ---
function base64Decode(str) {
    if (!str) return "";
    return Buffer.from(String(str), 'base64').toString('utf-8');
}

function rot13(str) {
    return String(str).replace(/[A-Za-z]/g, function (char) {
        const start = char <= 'Z' ? 65 : 97;
        return String.fromCharCode(((char.charCodeAt(0) - start + 13) % 26) + start);
    });
}

// --- TMDB Details Resolver (आपकी API Key के साथ) ---
async function resolveMediaDetails(id, mediaType) {
    const tmdbType = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';

    // 1. अगर आपके प्रोजेक्ट में ../utils/tmdb मौजूद है तो पहले उसे आज़माएं
    try {
        const tmdbModule = require('../utils/tmdb');
        if (tmdbModule && typeof tmdbModule.getDetails === 'function') {
            const details = await tmdbModule.getDetails(tmdbType, id);
            if (details && (details.title || details.name)) {
                return details;
            }
        }
    } catch (e) {
        // अगर ../utils/tmdb नहीं है तो नीचे आपकी API Key से डेटा निकलेगा
    }

    // 2. अगर IMDb ID (जैसे tt1234567) दी गई है, तो आपकी TMDB Key के /find एंडपॉइंट से खोजें
    if (String(id).startsWith('tt')) {
        try {
            const findUrl = `https://api.themoviedb.org/3/find/${id}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
            const res = await makeRequest(findUrl);
            if (res.statusCode === 200) {
                const data = JSON.parse(res.body);
                const result = tmdbType === 'tv' 
                    ? (data.tv_results?.[0] || data.movie_results?.[0]) 
                    : (data.movie_results?.[0] || data.tv_results?.[0]);
                if (result) return result;
            }
        } catch (e) {
            console.error(`[HDHub4u] TMDB IMDb-find error: ${e.message}`);
        }
    }

    // 3. अगर सीधे TMDB ID दी गई है
    try {
        const apiUrl = `https://api.themoviedb.org/3/${tmdbType}/${id}?api_key=${TMDB_API_KEY}`;
        const res = await makeRequest(apiUrl);
        if (res.statusCode === 200) {
            return JSON.parse(res.body);
        }
    } catch (e) {
        console.error(`[HDHub4u] TMDB fetch error: ${e.message}`);
    }

    return null;
}

// --- Domain Fetcher ---
async function getCurrentDomain() {
    const now = Date.now();
    if (now - domainCacheTimestamp < DOMAIN_CACHE_TTL) return MAIN_URL;
    try {
        const response = await makeRequest(DOMAINS_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (response.statusCode === 200 && response.body) {
            const data = JSON.parse(response.body);
            if (data && data.HDHUB4u) {
                updateMainUrl(data.HDHUB4u);
                domainCacheTimestamp = now;
                console.log(`[HDHub4u] Active domain: ${MAIN_URL}`);
            }
        }
    } catch (error) {
        console.warn(`[HDHub4u] Failed to fetch latest domains: ${error.message}`);
    }
    return MAIN_URL;
}

// --- Redirect Link Decoder ---
async function getRedirectLinks(url) {
    try {
        const response = await makeRequest(url);
        const doc = response.body;
        const regex = /s\s*\(\s*['"]o['"]\s*,\s*['"]([A-Za-z0-9+/=]+)['"]|ck\s*\(\s*['"]_wp_http_\d+['"]\s*,\s*['"]([^'"]+)['"]/g;
        let combinedString = "";
        let match;

        while ((match = regex.exec(doc)) !== null) {
            const extractedValue = match[1] || match[2];
            if (extractedValue) combinedString += extractedValue;
        }

        if (!combinedString) return null;

        const decodedString = base64Decode(rot13(base64Decode(base64Decode(combinedString))));
        const jsonObject = JSON.parse(decodedString);
        const encodedUrl = base64Decode(jsonObject.o || "").trim();
        const data = base64Decode(jsonObject.data || "").trim();
        const wphttp1 = (jsonObject.blog_url || "").trim();

        if (encodedUrl) return encodedUrl;

        if (wphttp1 && data) {
            const resp = await makeRequest(`${wphttp1}?re=${data}`, { parseHTML: true });
            if (resp.$) {
                return resp.$('body').text().trim();
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}

// --- HubCloud Extractor ---
async function hubCloudExtractor(url, referer) {
    try {
        let currentUrl = url.replace("hubcloud.ink", "hubcloud.dad").replace("hubcloud.art", "hubcloud.dad");
        const pageResponse = await makeRequest(currentUrl, { headers: { ...HEADERS, Referer: referer } });
        let pageData = pageResponse.body;
        let finalUrl = currentUrl;

        if (!currentUrl.includes("hubcloud.php")) {
            let nextHref = "";
            const $first = cheerio.load(pageData);
            const downloadBtn = $first("#download");
            if (downloadBtn.length) {
                nextHref = downloadBtn.attr("href");
            }
            if (nextHref) {
                if (!nextHref.startsWith("http")) {
                    const urlObj = new URL(currentUrl);
                    nextHref = `${urlObj.protocol}//${urlObj.hostname}/${nextHref.replace(/^\//, "")}`;
                }
                finalUrl = nextHref;
                const secondResponse = await makeRequest(finalUrl, { headers: { ...HEADERS, Referer: currentUrl } });
                pageData = secondResponse.body;
            }
        }

        const $ = cheerio.load(pageData);
        const size = $("i#size").text().trim();
        const header = $("div.card-header").text().trim();
        const qualityStr = header.match(/(\d{3,4})[pP]/)?.[1];
        const quality = qualityStr ? `${qualityStr}p` : '1080p';

        const links = [];
        const elements = $("a.btn").get();

        for (const element of elements) {
            const link = $(element).attr("href");
            const text = $(element).text().toLowerCase();

            // r2.dev ब्लॉक पॉलिसी
            if (link && /r2\.dev/i.test(link)) continue;

            if (link && (text.includes("download") || text.includes("server") || text.includes("fast") || text.includes("fsl") || text.includes("pixel"))) {
                let directUrl = link;

                if (link.toLowerCase().includes("hubcloud") || link.includes("?id=")) {
                    const resolved = await getRedirectLinks(link);
                    if (resolved) directUrl = resolved;
                }

                // Pixeldrain डायरेक्ट डाउनलोड लिंक फिक्स
                if (directUrl.includes("pixeldrain.com/u/") || directUrl.includes("pixeldrain.dev/u/")) {
                    directUrl = directUrl.replace("/u/", "/api/file/") + "?download";
                }

                if (directUrl && !/r2\.dev/i.test(directUrl)) {
                    links.push({
                        name: 'HDHub4u',
                        title: `HDHub4u · ${quality}${size ? ` · ${size}` : ''}`,
                        url: directUrl,
                        quality: quality,
                        provider: 'HDHub4u',
                        headers: HEADERS
                    });
                }
            }
        }
        return links;
    } catch (e) {
        return [];
    }
}

// --- Search & Extract ---
async function searchAndExtract(title, year) {
    try {
        const domain = await getCurrentDomain();
        const searchUrl = `${domain}/?s=${encodeURIComponent(title)}`;
        console.log(`[HDHub4u] Fetching search URL: ${searchUrl}`);

        const res = await makeRequest(searchUrl, { parseHTML: true });
        if (res.statusCode >= 400 || !res.$) {
            console.log(`[HDHub4u] Search failed with status: ${res.statusCode}`);
            return [];
        }

        const $ = res.$;
        const posts = [];

        $("ul.recent-movies li, div.recent-movies, article.post, div.item, .thumb").each((i, el) => {
            const aTag = $(el).find("a").first();
            const postUrl = aTag.attr("href");
            const postTitle = $(el).find("p, h2, h3, .title, figcaption").text().trim() || aTag.attr("title") || aTag.text().trim();
            if (postUrl && postUrl.startsWith("http")) {
                posts.push({ url: postUrl, title: postTitle });
            }
        });

        console.log(`[HDHub4u] Found ${posts.length} posts for title: "${title}"`);

        const streams = [];
        for (const post of posts.slice(0, 2)) {
            const postRes = await makeRequest(post.url, { parseHTML: true });
            if (!postRes.$) continue;

            const $$ = postRes.$;
            const hubCloudLinks = [];
            const encryptedRedirectLinks = [];

            $$("a").each((i, el) => {
                const href = $$(el).attr("href");
                if (!href) return;

                if (href.toLowerCase().includes("hubcloud") || href.includes("24embed")) {
                    hubCloudLinks.push(href);
                } else if (href.includes("?id=") || href.includes("techyboy") || href.includes("crypto") || href.includes("gadgetsweb")) {
                    encryptedRedirectLinks.push(href);
                }
            });

            // एन्क्रिप्टेड रीडायरेक्ट लिंक्स को डिकोड करके HubCloud लिंक निकालें
            if (hubCloudLinks.length === 0 && encryptedRedirectLinks.length > 0) {
                for (const rLink of encryptedRedirectLinks.slice(0, 4)) {
                    const resolvedUrl = await getRedirectLinks(rLink);
                    if (resolvedUrl) {
                        if (resolvedUrl.toLowerCase().includes("hubcloud")) {
                            hubCloudLinks.push(resolvedUrl);
                        } else {
                            const subPage = await makeRequest(resolvedUrl, { parseHTML: true });
                            if (subPage.$) {
                                subPage.$("a").each((i, el) => {
                                    const subHref = subPage.$(el).attr("href");
                                    if (subHref && subHref.toLowerCase().includes("hubcloud")) {
                                        hubCloudLinks.push(subHref);
                                    }
                                });
                            }
                        }
                    }
                }
            }

            for (const link of hubCloudLinks.slice(0, 4)) {
                const extracted = await hubCloudExtractor(link, post.url);
                streams.push(...extracted);
            }
        }
        return streams;
    } catch (e) {
        console.error(`[HDHub4u] Search exception error: ${e.message}`);
        return [];
    }
}

// --- Main Entry Function ---
async function getHdhub4uStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[HDHub4u] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
    try {
        const type = (mediaType === 'tv' || mediaType === 'series') ? 'series' : 'movie';
        let title = '';
        let year = null;

        if (/^\d+$/.test(String(tmdbId)) || String(tmdbId).startsWith('tt')) {
            const details = await resolveMediaDetails(tmdbId, type);
            title = (details && (details.title || details.name)) || '';
            const releaseDate = type === 'series' ? details?.first_air_date : details?.release_date;
            year = releaseDate ? parseInt(String(releaseDate).split("-")[0]) : null;
        } else {
            title = String(tmdbId);
        }

        if (!title) {
            console.log(`[HDHub4u] No title resolved for TMDB ID ${tmdbId}`);
            return [];
        }

        let searchTitle = title;
        if (type === 'series' && seasonNum) {
            searchTitle = `${title} S${seasonNum.toString().padStart(2, '0')}`;
        }

        const streams = await searchAndExtract(searchTitle, year);
        console.log(`[HDHub4u] Got ${streams.length} stream(s) for "${title}"`);
        return streams;
    } catch (err) {
        console.error(`[HDHub4u] Error: ${err.message}`);
        return [];
    }
}

module.exports = { 
    getHdhub4uStreams,
    getStreams: getHdhub4uStreams
};
