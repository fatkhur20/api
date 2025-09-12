import { connect } from 'cloudflare:sockets';

// --- Helper: Performs a TCP connection test to a given proxy ---
async function checkProxy(proxy, timeout) {
  const [hostname, portStr] = proxy.split(":");
  if (!hostname || !portStr) {
    return { proxy, status: "dead", latency: null };
  }
  const port = parseInt(portStr, 10);

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout")), timeout)
  );

  const connectPromise = (async () => {
    const startTime = Date.now();
    try {
        const socket = connect({ hostname, port });
        await socket.close();
        const latency = Date.now() - startTime;
        return { proxy, status: "alive", latency };
    } catch (e) {
        throw e;
    }
  })();

  try {
    return await Promise.race([connectPromise, timeoutPromise]);
  } catch (error) {
    return { proxy, status: "dead", latency: null };
  }
}

// --- Helper: Fetches and parses the list of proxies from the source URL ---
async function getProxyList(env) {
  const response = await fetch(env.PROXY_LIST_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch proxy list: ${response.status} ${response.statusText}`);
  }
  const textData = await response.text();
  return textData.split('\n')
    .map(line => {
      const parts = line.split(',');
      if (parts.length >= 4) {
        const ip = parts[0].trim();
        const port = parts[1].trim();
        const country = parts[2].trim();
        const isp = parts[3].trim();
        if (ip && port && country && isp) {
          return { ip, port, country, isp };
        }
      }
      return null;
    })
    .filter(Boolean);
}

// --- The Durable Object Class for Health Checking ---
export class HealthCheckerDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // The DO's fetch handler acts as a router for commands from the main worker.
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/start-full-check") {
      return this.startFullCheck();
    }
    return new Response("Not found", { status: 404 });
  }

  // The alarm is our main work loop for background processing.
  async alarm() {
    const proxies = await this.state.storage.get("proxies") || [];
    let currentIndex = await this.state.storage.get("current_index") || 0;

    if (currentIndex >= proxies.length) {
      console.log("Health check cycle complete.");
      await this.state.storage.deleteAll();
      return;
    }

    const proxyData = proxies[currentIndex];
    const proxyAddress = `${proxyData.ip}:${proxyData.port}`;
    console.log(`DO Alarm: Checking proxy #${currentIndex}: ${proxyAddress}`);

    const timeout = parseInt(this.env.HEALTH_CHECK_TIMEOUT || '5000', 10);
    const healthResult = await checkProxy(proxyAddress, timeout);

    const finalData = {
      proxy: proxyAddress,
      status: healthResult.status,
      latency: healthResult.latency,
      country: proxyData.country,
      isp: proxyData.isp,
    };

    await this.env.PROXY_CACHE.put(proxyAddress, JSON.stringify(finalData), { expirationTtl: 3600 });

    currentIndex++;
    await this.state.storage.put("current_index", currentIndex);
    this.state.storage.setAlarm(Date.now() + 1000); // Check next proxy in 1 second
  }

  // This method is called via the DO's fetch handler.
  async startFullCheck() {
    const currentAlarm = await this.state.storage.getAlarm();
    if (currentAlarm != null) {
      return new Response("Health check process is already running.", { status: 409 });
    }

    console.log("startFullCheck called. Fetching proxy list...");
    const proxies = await getProxyList(this.env);
    await this.state.storage.put("proxies", proxies);
    await this.state.storage.put("current_index", 0);

    this.state.storage.setAlarm(Date.now() + 1000);
    console.log("Proxy list fetched and first alarm set.");
    return new Response("Health check process initiated.", { status: 202 });
  }
}

// --- Main Worker Logic ---
export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === 'POST' && path === '/force-health') {
        const id = env.HEALTH_CHECKER.idFromName("singleton-health-checker");
        const stub = env.HEALTH_CHECKER.get(id);
        // Send a request to the DO's fetch handler to trigger the process.
        return stub.fetch(new Request("https://do/start-full-check", { method: "POST" }));

      } else if (path === '/health') {
        if (!env.PROXY_CACHE) {
          return new Response("KV Namespace 'PROXY_CACHE' is not configured.", { status: 500, headers: corsHeaders });
        }

        const allKeys = [];
        let cursor = undefined;
        let listResult;
        do {
          listResult = await env.PROXY_CACHE.list({ cursor: cursor, limit: 1000 });
          allKeys.push(...listResult.keys);
          cursor = listResult.cursor;
        } while (listResult && !listResult.list_complete);

        const proxyKeys = allKeys.filter(key => !key.name.startsWith('_internal_'));
        const promises = proxyKeys.map(key => env.PROXY_CACHE.get(key.name, 'json'));
        let results = await Promise.all(promises);

        results = results
          .filter(result => result && result.status === 'alive')
          .sort((a, b) => a.latency - b.latency);

        return new Response(JSON.stringify(results, null, 2), {
          headers: { 'Content-Type': 'application/json;charset=UTF-8', ...corsHeaders },
        });
      } else {
        // Default behavior: return the raw, unchecked list.
        const proxies = await getProxyList(env);
        const proxyStrings = proxies.map(p => `${p.ip}:${p.port}`);
        return new Response(JSON.stringify(proxyStrings, null, 2), {
          headers: { 'Content-Type': 'application/json;charset=UTF-8', ...corsHeaders },
        });
      }

    } catch (error) {
      console.error('Worker error:', error);
      return new Response(error.message, {
        status: 500,
        headers: { ...corsHeaders },
      });
    }
  },
};
