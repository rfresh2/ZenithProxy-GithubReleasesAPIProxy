import { diffJson } from "diff";
import { logT } from "../log.js";

const API_BASE_URL = "https://api.github.com";
const API_KEY_VALUE = process.env.API_KEY_VALUE;
const RELEASES_LIST_CACHE_ENABLED = process.env.RELEASES_LIST_CACHE === "true";
const AUTO_UPDATE_RELEASES_CACHE = process.env.AUTO_UPDATE_RELEASES_CACHE === "true";
const BASE_PATH = "/repos/rfresh2/ZenithProxy/releases";
const RELEASES_LIST_PATH = "/repos/rfresh2/ZenithProxy/releases?per_page=100";
const RELEASES_LIST_URL = `${API_BASE_URL}${RELEASES_LIST_PATH}`;
const BASE_HEADERS = {
  "User-Agent": "ZenithProxy/1.1",
  ...(API_KEY_VALUE ? { "Authorization": `Bearer ${API_KEY_VALUE}` } : {}),
};
const MC_VERSIONS = [
  "1.20.1",
  "1.20.4",
  "1.20.6",
  "1.21.0",
  "1.21.3",
  "1.21.4",
  "1.21.5",
  "1.21.7",
  "1.21.8",
  "1.21.10",
  "1.21.11",
  "26.1.1",
  "26.1.2",
  "26.2.0",
  "26.3.0",
];
const PLATFORMS = [
  "java",
  "linux",
];
const RELEASE_SUFFIXES = [
  "",
  ".pre",
];
const RELEASE_CHANNELS = MC_VERSIONS
  .map(version => PLATFORMS
    .map(platform => RELEASE_SUFFIXES
      .map(suffix => `${platform}.${version}${suffix}`)))
  .flat(2);

// Headers from GitHub that must not be passed through
const STRIPPED_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
];

let releasesCachedResponse = undefined;
let releasesCachedBody = undefined;

const RESPONSE_CACHE_TTL_MS = 3 * 60 * 1000;
const CACHEABLE_STATUSES = new Set([200, 302]);
const responseCache = new Map();

function responseCacheKey(req, path) {
  return JSON.stringify([
    path,
    req.headers.get("accept"),
    req.headers.get("x-github-api-version"),
  ]);
}

function getCachedResponse(key) {
  const entry = responseCache.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return undefined;
  }
  return entry;
}

function clearResponseCache() {
  responseCache.clear();
}

// Drop expired entries so the cache doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of responseCache) {
    if (entry.expiresAt <= now) responseCache.delete(key);
  }
}, RESPONSE_CACHE_TTL_MS).unref();

function jsonError(status, message) {
  return Response.json({ error: message }, { status });
}

// Returns { response, cache } where cache is "ZHIT", "HIT" or "MISS" for logging.
export async function handleRequest(req) {
  const url = new URL(req.url);
  const path = url.pathname + url.search;

  if (req.method !== "GET" && req.method !== "HEAD") {
    return { response: new Response(`Cannot ${req.method} ${url.pathname}`, { status: 404 }), cache: "MISS" };
  }

  // Serve the release list from the cache when the path is exactly the releases
  // list (query params allowed), e.g.:
  // /repos/rfresh2/ZenithProxy/releases?per_page=100 -> cached
  // /repos/rfresh2/ZenithProxy/releases/tags/123 -> not cached
  if (RELEASES_LIST_CACHE_ENABLED) {
    if (releasesCachedBody === undefined) {
      logT("Release cache not ready");
    } else if (path.startsWith(BASE_PATH) && !path.substring(BASE_PATH.length).includes("/")) {
      const response = new Response(releasesCachedBody, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "ZenithProxy-Cache": "HIT",
        },
      });
      return { response, cache: "ZHIT" };
    }
  }

  const key = responseCacheKey(req, path);
  const cached = getCachedResponse(key);
  if (cached !== undefined) {
    const response = new Response(cached.body, { status: cached.status, headers: cached.headers });
    return { response, cache: "HIT" };
  }

  // Only proxy requests for this repo's releases.
  if (!path.startsWith(BASE_PATH)) {
    return { response: jsonError(500, `Unsupported route: ${path}`), cache: "MISS" };
  }

  const upstream = await proxyRequest(req, `${API_BASE_URL}${path}`);
  const headers = new Headers(upstream.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) headers.delete(name);
  const body = new Uint8Array(await upstream.arrayBuffer());

  if (CACHEABLE_STATUSES.has(upstream.status)) {
    responseCache.set(key, {
      status: upstream.status,
      headers,
      body,
      expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS,
    });
  }

  return { response: new Response(body, { status: upstream.status, headers }), cache: "MISS" };
}

function proxyRequest(req, dest) {
  const headers = { ...BASE_HEADERS };
  const accept = req.headers.get("accept");
  const apiVersion = req.headers.get("x-github-api-version");
  if (accept !== null) headers["Accept"] = accept;
  if (apiVersion !== null) headers["X-GitHub-Api-Version"] = apiVersion;
  // Don't follow redirects: 302s (e.g. asset downloads) are passed to the client.
  return fetch(dest, { headers, redirect: "manual" });
}

async function fetchReleasesResponse() {
  const headers = {
    ...BASE_HEADERS,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // map from release channel to release data json
  const responseMap = {};
  const releaseChannelSet = new Set(RELEASE_CHANNELS);

  // iterate over pages until we find the latest release for each channel
  for (let page = 1; page <= 15; page++) {
    const url = `${RELEASES_LIST_URL}&page=${page}`;
    const response = await fetch(url, { headers });
    if (response.status !== 200) {
      throw new Error(`Failed to fetch releases: ${response.status}`);
    }
    // body is an array of release objects
    const releases = await response.json();
    for (const release of releases) {
      if (release.draft) continue;
      const tagName = release.tag_name;
      if (tagName === undefined) continue;
      if (!tagName.includes("+")) continue;
      const channel = tagName.split("+")[1];
      if (releaseChannelSet.has(channel)) {
        responseMap[channel] = release;
        releaseChannelSet.delete(channel);
      }
    }
    if (releaseChannelSet.size === 0) {
      break;
    }
  }

  if (releaseChannelSet.size > 0) {
    logT(`Failed to find latest releases for channels: ${Array.from(releaseChannelSet)}`);
  }

  // process the responseMap into a json array like the api expects
  return Object.values(responseMap);
}

export async function updateReleaseCache() {
  try {
    const priorReleases = releasesCachedResponse;
    const releases = await fetchReleasesResponse();
    const body = JSON.stringify(releases);
    if (priorReleases && releasesCachedBody !== body) {
      logT("Release cache updated with changes");
      const diffs = diffJson(priorReleases, releases);
      diffs.forEach(part => {
        if (part.added || part.removed) {
          const prefix = part.added ? "+" : "-";
          part.value.split("\n").forEach(line => {
            if (line) {
              console.log(`${prefix} ${line}`);
            }
          });
        }
      });
    }
    releasesCachedResponse = releases;
    releasesCachedBody = body;
    clearResponseCache();
    logT("Updated release cache");
  } catch (err) {
    logT("Error updating release cache: " + err);
  }
}

export async function startReleaseCacheUpdater() {
  await updateReleaseCache();
  if (AUTO_UPDATE_RELEASES_CACHE) {
    logT("Starting auto release cache updater");
    setInterval(updateReleaseCache, 3 * 60 * 1000);
  } else {
    logT("Auto release cache updater is disabled");
  }
}
