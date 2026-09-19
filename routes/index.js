const express = require('express');
const router = express.Router();
const needle = require('needle');
const crypto = require('crypto');
const apicache = require('apicache');
const { ToadScheduler, SimpleIntervalJob, AsyncTask } = require('toad-scheduler')
const diff = require('diff');


const scheduler = new ToadScheduler()

const API_BASE_URL = "https://api.github.com";
const API_KEY_VALUE = process.env.API_KEY_VALUE;
const RELEASES_LIST_CACHE_ENABLED = process.env.RELEASES_LIST_CACHE !== undefined && process.env.RELEASES_LIST_CACHE === "true";
const AUTO_UPDATE_RELEASES_CACHE = process.env.AUTO_UPDATE_RELEASES_CACHE !== undefined && process.env.AUTO_UPDATE_RELEASES_CACHE === "true";
const BASE_PATH = "/repos/rfresh2/ZenithProxy/releases";
const RELEASES_LIST_PATH = "/repos/rfresh2/ZenithProxy/releases?per_page=100";
const RELEASES_LIST_URL = `${API_BASE_URL}${RELEASES_LIST_PATH}`
const BASE_HEADERS = {
  "User-Agent": "ZenithProxy/1.1",
  "Connection": "close",
  "Authorization": `Bearer ${API_KEY_VALUE}`
}
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
    "26.3.0"
]
const PLATFORMS = [
    "java",
    "linux"
]
const RELEASE_SUFFIXES = [
    "",
    ".pre"
]
const RELEASE_CHANNELS = MC_VERSIONS
    .map(version => PLATFORMS
        .map(platform => RELEASE_SUFFIXES
            .map(suffix =>  `${platform}.${version}${suffix}`)))
    .flat(2)

function logT(msg) {
    console.log(`${new Date().toISOString()} ${msg}`)
  }

let releasesCachedResponse = undefined;

const cache = apicache.options({
  appendKey: (req, res) => {
    const headers = {}
    if (req.headers['x-github-api-version'] !== undefined) {
      headers['X-GitHub-Api-Version'] = req.headers['x-github-api-version'];
    }
    if (req.headers['accept'] !== undefined) {
      headers['Accept'] = req.headers['accept'];
    }
    const headersStr = JSON.stringify(headers);
    return crypto.createHash("md5").update(`${req.url}${headersStr}`).digest("base64");
  },
  statusCodes: {
    include: [200, 302]
  },
  debug: false
}).middleware;

const releaseListMiddleware = (req, res, next) => {
    if (!RELEASES_LIST_CACHE_ENABLED) {
        next()
        return
    }
    if (releasesCachedResponse === undefined) {
        logT("Release cache not ready")
        next()
        return
    }

    // check if url path equals BASE_PATH, ignoring query params
    // but if there's more uri path behind it then false
    // for example:
    // /repos/rfresh2/ZenithProxy/releases?per_page=100 -> true
    // /repos/rfresh2/ZenithProxy/releases/tags/123 -> false
    let patchMatches = req.url.startsWith(BASE_PATH) && !req.url.substring(BASE_PATH.length).includes('/');

    if (patchMatches) {
        res.status(200).set({
            "Content-Type": "application/json",
            "ZenithProxy-Cache": "HIT"
        }).send(releasesCachedResponse)
    } else {
        next()
    }
}

router.get(/\/(.*)/, [releaseListMiddleware, cache('3 minutes')], async (req, res, next) => {
  try {
    // only proxy for my own repo. i don't forsee any valid use case otherwise
    if (!req.url.startsWith(BASE_PATH)) {
      res.status(500)
      next(new Error("Unsupported route: " + req.url))
      return;
    }
    const proxiedRes = await proxyRequest(req, `${API_BASE_URL}${req.url}`);
    res.status(proxiedRes.statusCode).set(proxiedRes.headers).send(proxiedRes.body);
  } catch (error) {
    next(error);
  }
});

async function proxyRequest(req, dest) {
  let reqHeaders = BASE_HEADERS;
  reqHeaders['Accept'] = req.headers['accept'];
  reqHeaders['X-GitHub-Api-Version'] = req.headers['x-github-api-version'];
  const options = {
    headers: reqHeaders
  }
  return await needle('get', dest, options);
}

async function fetchReleasesResponse() {
    const headers = BASE_HEADERS;
    headers['Accept'] = 'application/vnd.github+json';
    headers['X-GitHub-Api-Version'] = '2022-11-28';
    const options = {
        headers: headers
    }

    // map from release channel to release data json
    const responseMap = {}
    const releaseChannelSet = new Set(RELEASE_CHANNELS)

    // iterate over pages until we find the latest release for each channel
    for (let page = 1; page <= 15; page++) {
        const url = `${RELEASES_LIST_URL}&page=${page}`
        const response = await needle('get', url, options)
        if (response.statusCode !== 200) {
            throw new Error(`Failed to fetch releases: ${response.statusCode}`)
        }
        const releases = response.body
        // body is an array of release objects
        for (const release of releases) {
            if (release.draft) continue
            const tagName = release.tag_name
            if (tagName === undefined) continue
            if (!tagName.includes('+')) continue
            const channel = tagName.split('+')[1]
            if (releaseChannelSet.has(channel)) {
                responseMap[channel] = release
                releaseChannelSet.delete(channel)
            }
        }
        if (releaseChannelSet.size === 0) {
            break
        }
    }

    if (releaseChannelSet.size > 0) {
        logT(`Failed to find latest releases for channels: ${Array.from(releaseChannelSet)}`)
    }

    // process the responseMap into a json array like the api expects
    const responseArray = []
    for (const key in responseMap) {
        responseArray.push(responseMap[key])
    }
    return responseArray
}

async function updateReleaseCache() {
    try {
        const priorReleases = releasesCachedResponse
        releasesCachedResponse = await fetchReleasesResponse()
        if (priorReleases && JSON.stringify(priorReleases) !== JSON.stringify(releasesCachedResponse)) {
            logT("Release cache updated with changes")
            const diffs = diff.diffJson(priorReleases, releasesCachedResponse)
            diffs.forEach(part => {
                if (part.added || part.removed) {
                    const prefix = part.added ? '+' : '-'
                    part.value.split('\n').forEach(line => {
                        if (line) {
                            console.log(`${prefix} ${line}`)
                        }
                    })
                }
            })
        }
        apicache.clear()
        logT("Updated release cache")
    } catch (err) {
        logT("Error updating release cache: " + err)
    }

}

const cacheRefreshTask = new AsyncTask('cacheRefresh', updateReleaseCache, (err) => {
    logT("Error in cache refresh task: " + err)
})
const cacheRefreshJob = new SimpleIntervalJob({ minutes: 3 }, cacheRefreshTask)

async function startReleaseCacheUpdater() {
    await updateReleaseCache()
    if (AUTO_UPDATE_RELEASES_CACHE) {
        logT("Starting auto release cache updater")
        scheduler.addSimpleIntervalJob(cacheRefreshJob)
    } else {
        logT("Auto release cache updater is disabled")
    }
}

module.exports = router;
module.exports.startReleaseCacheUpdater = startReleaseCacheUpdater;
module.exports.updateReleaseCache = updateReleaseCache;
