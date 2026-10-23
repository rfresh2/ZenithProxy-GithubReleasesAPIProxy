// In-memory per-client rate limiting
// Each client gets a fixed window that starts on its first request.

const WINDOW_MS = 10 * 60 * 1000; // 10 mins
const MAX_REQUESTS = 1000; // reject after this many requests per window
const DELAY_AFTER = 800; // delay requests after this many per window
const DELAY_MS = 500;

const clients = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, client] of clients) {
    if (client.resetAt <= now) clients.delete(key);
  }
}, WINDOW_MS).unref();

// use the address added by the one proxy in front of us (right-most X-Forwarded-For entry), else the socket address.
export function clientIp(req, server) {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",");
    const ip = parts[parts.length - 1].trim();
    if (ip) return ip;
  }
  return server.requestIP(req)?.address ?? "unknown";
}

// Group IPv6 clients by /56 subnet
function rateLimitKey(ip) {
  if (!ip.includes(":")) return ip;
  ip = ip.split("%")[0].toLowerCase();
  if (ip.startsWith("::ffff:") && ip.includes(".")) return ip.slice(7);
  const hasGap = ip.includes("::");
  const [h, t] = hasGap ? ip.split("::") : [ip, ""];
  const head = h ? h.split(":") : [];
  const tail = t ? t.split(":") : [];
  const groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail]
    .map(g => parseInt(g, 16) || 0);
  return `${groups.slice(0, 3).map(g => g.toString(16)).join(":")}:${(groups[3] & 0xff00).toString(16)}::/56`;
}

// Returns a 429 Response if the client is over the limit, otherwise undefined
export async function rateLimit(ip) {
  const key = rateLimitKey(ip);
  const now = Date.now();
  let client = clients.get(key);
  if (client === undefined || client.resetAt <= now) {
    client = { count: 0, resetAt: now + WINDOW_MS };
    clients.set(key, client);
  }
  client.count++;
  if (client.count > MAX_REQUESTS) {
    return new Response("Too many requests, please try again later.", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil((client.resetAt - now) / 1000)) },
    });
  }
  if (client.count > DELAY_AFTER) {
    await Bun.sleep(DELAY_MS);
  }
  return undefined;
}
