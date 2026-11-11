const https = require('https');
const http = require('http');
const { URL } = require('url');
const cheerio = require('cheerio');

// Configuration
let MAIN_URL = "https://new3.hdhub4u.fo";
const DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";
const DOMAIN_CACHE_TTL = 4 * 60 * 60 * 1000;
let domainCacheTimestamp = 0;

// आपकी TMDB API Key
const TMDB_API_KEY = "83ec7009a9fdb16a980f5bac7db19d2f";

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Cookie": "xla=s4t",
    "Referer": `${MAIN_URL}/`
};

function updateMainUrl(url) {
    MAIN_URL = url.replace(/\/$/, "");
    HEADERS.Referer = `${MAIN_URL}/`;
}

// --- Network Request Helper ---
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

// --- TMDB Details Resolver ---
async function resolveMediaDetails(id, mediaType) {
    const tmdbType = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';

    try {
        const tmdbModule = require('../utils/tmdb');
        if (tmdbModule && typeof tmdbModule.getDetails === 'function') {
            const details = await tmdbModule.getDetails(tmdbType, id);
            if (details && (details.title || details.name)) {
                return details;
            }
        }
    } catch (e) {}

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
                console.log(`[HDHub4u] Active domain updated to: ${MAIN_URL}`);
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
        let currentUrl = url
            .replace("hubcloud.ink", "hubcloud.dad")
            .replace("hubcloud.art", "hubcloud.dad")
            .replace("hubcloud.lol", "hubcloud.dad");

        const pageResponse = await makeRequest(currentUrl, { headers: { ...HEADERS, Referer: referer } });
        let pageData = pageResponse.body;
        let finalUrl = pageResponse.url || currentUrl;

        if (!finalUrl.includes("hubcloud.php")) {
            let nextHref = "";
            const $first = cheerio.load(pageData);
            const downloadBtn = $first("#download, a.btn-primary, a[href*='hubcloud.php'], a[href*='gamerxyt']");
            if (downloadBtn.length) {
                nextHref = downloadBtn.first().attr("href");
            }
            if (nextHref) {
                if (!nextHref.startsWith("http")) {
                    const urlObj = new URL(finalUrl);
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
        const qualityNum = parseInt(header.match(/(\d{3,4})[pP]/)?.[1] || "1080", 10);

        const links = [];
        const elements = $("a.btn, a[href*='pixeldrain'], a[href*='r2.cloudflarestorage'], a[href*='googleusercontent'], a[href*='hbplay']").get();

        for (const element of elements) {
            const link = $(element).attr("href");
            const text = $(element).text().trim();
            const lowerText = text.toLowerCase();

            if (!link || /r2\.dev/i.test(link) || link.startsWith("javascript") || link === "#") continue;

            if (
                lowerText.includes("download") ||
                lowerText.includes("server") ||
                lowerText.includes("fast") ||
                lowerText.includes("fsl") ||
                lowerText.includes("pixel") ||
                lowerText.includes("10gbps") ||
                link.includes("pixeldrain") ||
                link.includes("hbplay")
            ) {
                let directUrl = link;

                if (link.toLowerCase().includes("hubcloud") || link.includes("?id=")) {
                    const resolved = await getRedirectLinks(link);
                    if (resolved) directUrl = resolved;
                }

                // अगर /tg/go?id= या सस्पिशियस टेलीग्राम लिंक है तो छोड़ दें (जैसा 4KHDHub में है)
                if (directUrl.includes("/tg/go") || directUrl.includes("t.me/")) continue;

                if (directUrl.includes("pixeldrain.com/u/") || directUrl.includes("pixeldrain.dev/u/")) {
                    const fileId = directUrl.split("/u/")[1]?.split("?")[0];
                    if (fileId) directUrl = `https://pixeldrain.dev/api/file/${fileId}`;
                }

                let serverName = "Server";
                if (directUrl.includes("pixeldrain")) serverName = "Pixeldrain";
                else if (lowerText.includes("fsl") || directUrl.includes("cloudflarestorage")) serverName = "FSL Server";
                else if (lowerText.includes("10gbps") || directUrl.includes("googleusercontent")) serverName = "10Gbps Server";
                else if (directUrl.includes("hbplay")) serverName = "HubPlay";

                if (directUrl && !/r2\.dev/i.test(directUrl)) {
                    // 4KHDHub के सटीक फॉर्मेट में आउटपुट
                    links.push({
                        name: `HDHub4u - ${serverName} - ${qualityNum}p`,
                        title: `${header || 'HDHub4u Stream'}${size ? `\n${size}` : ''}`,
                        url: directUrl,
                        quality: qualityNum,
                        provider: 'hdhub4u',
                        headers: {}
                    });
                }
            }
        }
        return links;
    } catch (e) {
        console.error(`[HDHub4u] hubCloudExtractor error: ${e.message}`);
        return [];
    }
}

// --- Search & Extract ---
async function searchAndExtract(title, year) {
    try {
        const domain = await getCurrentDomain();
        const searchUrl = `${domain}/?s=${encodeURIComponent(title)}`;
        console.log(`[HDHub4u] Searching URL: ${searchUrl}`);

        const res = await makeRequest(searchUrl, { parseHTML: true });
        if (res.statusCode >= 400 || !res.$) {
            console.log(`[HDHub4u] Search failed with status: ${res.statusCode}`);
            return [];
        }

        const $ = res.$;
        const posts = [];
        const seenUrls = new Set();

        // सभी संभावित पोस्ट कंटेनर्स से मूवी लिंक्स निकालें
        $("ul.recent-movies li, div.recent-movies, article.post, div.item, .thumb, figure").each((i, el) => {
            const aTag = $(el).find("a").first();
            const postUrl = aTag.attr("href");
            const postTitle = $(el).find("p, h2, h3, .title, figcaption").text().trim() || aTag.attr("title") || aTag.text().trim();
            if (postUrl && postUrl.startsWith("http") && !seenUrls.has(postUrl)) {
                seenUrls.add(postUrl);
                posts.push({ url: postUrl, title: postTitle });
            }
        });

        console.log(`[HDHub4u] Found ${posts.length} posts for title: "${title}"`);

        const streams = [];
        for (const post of posts.slice(0, 2)) {
            console.log(`[HDHub4u] Inspecting post: ${post.title} -> ${post.url}`);
            const postRes = await makeRequest(post.url, { parseHTML: true });
            if (!postRes.$) continue;

            const $$ = postRes.$;
            const hubCloudLinks = [];
            const encryptedRedirectLinks = [];

            $$("a").each((i, el) => {
                const href = $$(el).attr("href");
                if (!href) return;
                const lowerHref = href.toLowerCase();

                if (lowerHref.includes("hubcloud") || lowerHref.includes("24embed")) {
                    hubCloudLinks.push(href);
                } else if (
                    href.includes("?id=") ||
                    lowerHref.includes("techyboy") ||
                    lowerHref.includes("crypto") ||
                    lowerHref.includes("gadgetsweb") ||
                    lowerHref.includes("taazabull") ||
                    lowerHref.includes("hubdrive")
                ) {
                    encryptedRedirectLinks.push(href);
                }
            });

            console.log(`[HDHub4u] Direct HubCloud links: ${hubCloudLinks.length}, Redirect links: ${encryptedRedirectLinks.length}`);

            // रीडायरेक्ट लिंक्स को डिकोड करें
            if (hubCloudLinks.length === 0 && encryptedRedirectLinks.length > 0) {
                for (const rLink of encryptedRedirectLinks.slice(0, 5)) {
                    if (rLink.toLowerCase().includes("hubdrive")) {
                        const drivePage = await makeRequest(rLink, { parseHTML: true });
                        if (drivePage.$) {
                            drivePage.$("a").each((i, el) => {
                                const dHref = drivePage.$(el).attr("href");
                                if (dHref && dHref.toLowerCase().includes("hubcloud")) {
                                    hubCloudLinks.push(dHref);
                                }
                            });
                        }
                        continue;
                    }

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

            for (const link of [...new Set(hubCloudLinks)].slice(0, 4)) {
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
async function getHdhub4uStreams(arg1, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    let tmdbId = arg1;
    let passedTitle = '';
    let passedYear = null;

    if (arg1 && typeof arg1 === 'object') {
        tmdbId = arg1.tmdbId || arg1.id || arg1.imdbId || '';
        mediaType = arg1.type || arg1.mediaType || 'movie';
        seasonNum = arg1.season || arg1.seasonNum || null;
        episodeNum = arg1.episode || arg1.episodeNum || null;
        passedTitle = arg1.title || arg1.name || '';
        passedYear = arg1.year || null;
    }

    console.log(`[HDHub4u] Starting search for TMDB ID: ${tmdbId || passedTitle}, Type: ${mediaType}`);
    try {
        const type = (mediaType === 'tv' || mediaType === 'series') ? 'series' : 'movie';
        let title = passedTitle;
        let year = passedYear;

        if (!title && tmdbId) {
            if (/^\d+$/.test(String(tmdbId)) || String(tmdbId).startsWith('tt')) {
                const details = await resolveMediaDetails(tmdbId, type);
                title = (details && (details.title || details.name)) || '';
                const releaseDate = type === 'series' ? details?.first_air_date : details?.release_date;
                year = releaseDate ? parseInt(String(releaseDate).split("-")[0]) : null;
            } else {
                title = String(tmdbId);
            }
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
    fetch: getHdhub4uStreams,
    getHdhub4uStreams,
    getStreams: getHdhub4uStreams
};
