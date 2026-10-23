import MetricsClient from "./metrics.js";
import { clientIp, rateLimit } from "./ratelimit.js";
import { handleRequest, startReleaseCacheUpdater, updateReleaseCache } from "./routes/index.js";
import { logT } from "./log.js";

const PORT = process.env.PORT || 5000;
const RELEASES_LIST_CACHE_ENABLED = process.env.RELEASES_LIST_CACHE === "true";
const metricsEnabled = process.env.METRICS === "true";

let reqCount = 0;

function startMetrics() {
  const metricsClient = new MetricsClient();
  setInterval(async () => {
    logT(`Request Count: ${reqCount}`);
    const c = reqCount;
    reqCount = 0;
    try {
      await metricsClient.addRequestCount(c);
    } catch (err) {
      logT("Error writing metrics: " + err);
    }
  }, 5 * 60 * 1000);
}

async function onRequest(req, server) {
  const limited = await rateLimit(clientIp(req, server));
  if (limited) return limited;

  let response;
  let cache = "MISS";
  try {
    ({ response, cache } = await handleRequest(req));
  } catch (err) {
    response = Response.json({ error: err.message }, { status: 500 });
  }

  if (metricsEnabled) reqCount++;
  const agent = req.headers.get("user-agent") || "?";
  const url = new URL(req.url);
  logT(`${response.status} ${cache} ${agent} ${url.pathname}${url.search}`);
  return response;
}

async function listenForCommands() {
  for await (const line of console) {
    if (line.trim() === "u") {
      logT("Updating release cache...");
      updateReleaseCache();
    }
  }
}

async function startServer() {
  if (metricsEnabled) startMetrics();

  if (RELEASES_LIST_CACHE_ENABLED) {
    logT("Waiting for initial release cache update...");
    await startReleaseCacheUpdater();
    logT("Initial release cache update completed");
  }

  listenForCommands().catch(err => logT("Error reading stdin: " + err));

  Bun.serve({
    port: PORT,
    idleTimeout: 5,
    fetch: onRequest,
    error(err) {
      return Response.json({ error: err.message }, { status: 500 });
    },
  });
  console.log(`Server running on port ${PORT}`);
}

startServer().catch(err => {
  console.error("Error starting server: " + err);
  process.exit(1);
});
