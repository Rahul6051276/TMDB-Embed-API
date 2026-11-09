const cheerio = require('cheerio');
const CryptoJS = require('crypto-js');
const { getDetails, resolveImdbId } = require('../utils/tmdb');

let MAIN_URL = "https://new3.hdhub4u.fo";
const DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";
const DOMAIN_CACHE_TTL = 4 * 60 * 60 * 1000;
let domainCacheTimestamp = 0;

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Cookie": "xla=s4t",
    "Referer": `${MAIN_URL}/`
};

function updateMainUrl(url) {
    MAIN_URL = url;
    HEADERS.Referer = `${url}/`;
}

async function fetchAndUpdateDomain() {
    const now = Date.now();
    if (now - domainCacheTimestamp < DOMAIN_CACHE_TTL) return;
    try {
        const response = await fetch(DOMAINS_URL, {
            method: "GET",
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (response.ok) {
            const data = await response.json();
            if (data && data.HDHUB4u) {
                const newDomain = data.HDHUB4u;
                if (newDomain !== MAIN_URL) {
                    updateMainUrl(newDomain);
                    domainCacheTimestamp = now;
                }
            }
        }
    } catch (error) {
        console.warn(`[HDHub4u] Failed to fetch latest domains: ${error.message}`);
    }
}

async function getCurrentDomain() {
    await fetchAndUpdateDomain();
    return MAIN_URL;
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
function atob(value) {
    if (!value) return "";
    let input = String(value).replace(/=+$/, "");
    let output = "";
    let bc = 0, bs, buffer, idx = 0;
    while ((buffer = input.charAt(idx++))) {
        buffer = BASE64_CHARS.indexOf(buffer);
        if (~buffer) {
            bs = bc % 4 ? bs * 64 + buffer : buffer;
            if (bc++ % 4) {
                output += String.fromCharCode(255 & bs >> (-2 * bc & 6));
            }
        }
    }
    return output;
}

function rot13(value) {
    return value.replace(/[a-zA-Z]/g, function (c) {
        return String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26);
    });
}

async function getRedirectLinks(url) {
    try {
        const response = await fetch(url, { headers: HEADERS });
        if (!response.ok) return null;
        const doc = await response.text();
        const regex = /s\s*\(\s*['"]o['"]\s*,\s*['"]([A-Za-z0-9+/=]+)['"]|ck\s*\(\s*['"]_wp_http_\d+['"]\s*,\s*['"]([^'"]+)['"]/g;
        let combinedString = "";
        let match;
        while ((match = regex.exec(doc)) !== null) {
            const extractedValue = match[1] || match[2];
            if (extractedValue) combinedString += extractedValue;
        }
        if (!combinedString) return null;
        const decodedString = atob(rot13(atob(atob(combinedString))));
        const jsonObject = JSON.parse(decodedString);
        const encodedUrl = atob(jsonObject.o || "").trim();
        if (encodedUrl) return encodedUrl;
        return null;
    } catch (e) {
        return null;
    }
}

async function hubCloudExtractor(url, referer) {
    try {
        let currentUrl = url.replace("hubcloud.ink", "hubcloud.dad");
        const pageResponse = await fetch(currentUrl, { headers: { ...HEADERS, Referer: referer } });
        let pageData = await pageResponse.text();
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
                const secondResponse = await fetch(finalUrl, { headers: { ...HEADERS, Referer: currentUrl } });
                pageData = await secondResponse.text();
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
            if (link && (text.includes("download") || text.includes("server") || text.includes("fast"))) {
                let directUrl = link;
                if (link.includes("HubCloud") || link.includes("hubcloud")) {
                    const resolved = await getRedirectLinks(link);
                    if (resolved) directUrl = resolved;
                }
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
        return links;
    } catch (e) {
        return [];
    }
}

async function searchAndExtract(title, year) {
    try {
        const domain = await getCurrentDomain();
        const searchUrl = `${domain}/?s=${encodeURIComponent(title)}`;
        const res = await fetch(searchUrl, { headers: HEADERS });
        if (!res.ok) return [];
        const html = await res.text();
        const $ = cheerio.load(html);
        
        const posts = [];
        $("div.recent-movies, article.post, div.item").each((i, el) => {
            const aTag = $(el).find("a").first();
            const postUrl = aTag.attr("href");
            const postTitle = $(el).find("h2, h3, .title").text().trim() || aTag.text().trim();
            if (postUrl) posts.push({ url: postUrl, title: postTitle });
        });

        const streams = [];
        for (const post of posts.slice(0, 2)) {
            const postRes = await fetch(post.url, { headers: HEADERS });
            if (!postRes.ok) continue;
            const postHtml = await postRes.text();
            const $$ = cheerio.load(postHtml);
            
            const hubCloudLinks = [];
            $$("a").each((i, el) => {
                const href = $$(el).attr("href");
                if (href && (href.includes("hubcloud") || href.includes("HubCloud") || href.includes("24embed"))) {
                    hubCloudLinks.push(href);
                }
            });

            for (const link of hubCloudLinks.slice(0, 3)) {
                const extracted = await hubCloudExtractor(link, post.url);
                streams.push(...extracted);
            }
        }
        return streams;
    } catch (e) {
        console.warn(`[HDHub4u] Search error: ${e.message}`);
        return [];
    }
}

async function getHdhub4uStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[HDHub4u] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
    try {
        const type = mediaType === 'tv' ? 'series' : 'movie';
        const tmdbType = type === 'series' ? 'tv' : 'movie';
        const details = await getDetails(tmdbType, tmdbId);
        const title = (details && (details.title || details.name)) || '';
        const releaseDate = tmdbType === 'tv' ? details.first_air_date : details.release_date;
        const year = releaseDate ? parseInt(releaseDate.split("-")[0]) : null;

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

module.exports = { getHdhub4uStreams };
