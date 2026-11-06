// providers/desiflix.js
// Zangetsu Provider for DesiFlix (Hindi & Regional Content)

const TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
const DESIFLIX_BASE = "https://desiflix.stream";

async function resolveImdbId(tmdbId, isTv) {
  if (!tmdbId) return null;
  try {
    var typePath = isTv ? "tv" : "movie";
    var extUrl = "https://api.themoviedb.org/3/" + typePath + "/" + tmdbId + "/external_ids?api_key=" + TMDB_API_KEY;
    var extRes = await fetch(extUrl);
    var extData = await extRes.json();
    return extData.imdb_id || null;
  } catch (e) {
    return null;
  }
}

function extractQuality(text) {
  if (/2160p|4k/i.test(text)) return "4K";
  if (/1080p/i.test(text)) return "1080p";
  if (/720p/i.test(text)) return "720p";
  if (/480p/i.test(text)) return "480p";
  return "HD";
}

// Main bridge function for TMDB-Embed-API
async function getDesiflixStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var streams = [];
  try {
    var isTv = mediaType === 'tv';
    var imdbId = await resolveImdbId(tmdbId, isTv);
    if (!imdbId) return [];

    var endpoint = DESIFLIX_BASE + "/stream/movie/" + imdbId + ".json";
    
    if (isTv && seasonNum && episodeNum) {
      endpoint = DESIFLIX_BASE + "/stream/series/" + imdbId + ":" + seasonNum + ":" + episodeNum + ".json";
    }

    var response = await fetch(endpoint, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });

    if (response.ok) {
      var data = await response.json();
      if (data && Array.isArray(data.streams)) {
        for (var i = 0; i < data.streams.length; i++) {
          var item = data.streams[i];
          if (item.url) {
            var rawTitle = item.title || item.name || "DesiFlix Server";
            streams.push({
              name: "DesiFlix",
              title: rawTitle,
              url: item.url,
              quality: extractQuality(rawTitle),
              provider: "desiflix",
              headers: item.behaviorHints && item.behaviorHints.proxyHeaders ? item.behaviorHints.proxyHeaders.request : {}
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("[DesiFlix Error]:", err.message);
  }

  return streams;
}

module.exports = { getDesiflixStreams };
