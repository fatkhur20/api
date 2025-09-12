import { connect } from 'cloudflare:sockets';

// --- Helper Functions ---

// Performs a TCP connection test to a given proxy.
async function checkProxy(proxy, timeout) {
  const [hostname, portStr] = proxy.split(":");
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
        // re-throw to be caught by Promise.race
        throw e;
    }
  })();

  try {
    return await Promise.race([connectPromise, timeoutPromise]);
  } catch (error) {
    return { proxy, status: "dead", latency: null };
  }
}


// Fetches and parses the list of proxies from the source URL.
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

// --- Durable Object Class ---

export class HealthCheckerDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // We use `this.state.blockConcurrencyWhile()` to ensure we don't have races
    // between the alarm and other events.
    this.state.blockConcurrencyWhile(async () => {
        let stored = await this.state.storage.get("current_index");
        this.currentIndex = stored || 0;
    });
  }

  async alarm() {
    // Get the list of proxies from storage
    const proxies = await this.state.storage.get("proxies") || [];
    if (this.currentIndex >= proxies.length) {
      console.log("Health check cycle complete.");
      // Optional: clear the list and index if you want it to stop until `startFullCheck` is called again
      await this.state.storage.delete("current_index");
      await this.state.storage.delete("proxies");
      return;
    }

    // Get the specific proxy for this alarm
    const proxyData = proxies[this.currentIndex];
    const proxyAddress = `${proxyData.ip}:${proxyData.port}`;
    console.log(`DO Alarm: Checking proxy #${this.currentIndex}: ${proxyAddress}`);

    // Perform the health check
    const timeout = parseInt(this.env.HEALTH_CHECK_TIMEOUT || '5000', 10);
    const healthResult = await checkProxy(proxyAddress, timeout);

    // Combine with enrichment data
    const finalData = {
      proxy: proxyAddress,
      status: healthResult.status,
      latency: healthResult.latency,
      country: proxyData.country,
      isp: proxyData.isp,
    };

    // Save the result to KV with a 1-hour TTL
    await this.env.PROXY_CACHE.put(proxyAddress, JSON.stringify(finalData), { expirationTtl: 3600 });

    // Increment index and set alarm for the next one
    this.currentIndex++;
    await this.state.storage.put("current_index", this.currentIndex);

    // Set the next alarm
    this.state.storage.setAlarm(Date.now() + 1000); // 1 second between checks
  }

  // This method is called by the main worker to kick off a check cycle.
  async startFullCheck() {
    console.log("startFullCheck called. Fetching proxy list...");
    const proxies = await getProxyList(this.env);
    await this.state.storage.put("proxies", proxies);
    await this.state.storage.put("current_index", 0);
    this.currentIndex = 0;

    // Set the first alarm to kick off the process
    const currentAlarm = await this.state.storage.getAlarm();
    if (currentAlarm == null) {
        this.state.storage.setAlarm(Date.now() + 1000);
        console.log("Proxy list fetched and first alarm set.");
        return new Response("Health check process initiated.", { status: 200 });
    } else {
        console.log("Health check process is already running.");
        return new Response("Health check process is already running.", { status: 200 });
    }
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

      const id = env.HEALTH_CHECKER.idFromName("singleton-health-checker");
      const stub = env.HEALTH_CHECKER.get(id);

      if (request.method === 'POST' && path === '/force-health') {
        const response = await stub.startFullCheck();
        return new Response(response.body, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } else if (path === '/health') {
        if (!env.PROXY_CACHE) {
          return new Response("KV Namespace not configured.", { status: 500, headers: corsHeaders });
        }

        // Use a loop with a cursor to fetch all keys, overcoming the 1000-key limit.
        const allKeys = [];
        let cursor = undefined;
        do {
          const listResult = await env.PROXY_CACHE.list({ cursor: cursor, limit: 1000 });
          allKeys.push(...listResult.keys);
          cursor = listResult.cursor;
        } while (!listResult.list_complete);

        // Filter out the internal state key before fetching values
        const proxyKeys = allKeys.filter(key => key.name !== '_internal_state');

        const promises = proxyKeys.map(key => env.PROXY_CACHE.get(key.name, 'json'));
        let results = await Promise.all(promises);

        results = results
          .filter(result => result && result.status === 'alive')
          .sort((a, b) => a.latency - b.latency);

        return new Response(JSON.stringify(results, null, 2), {
          headers: { 'Content-Type': 'application/json;charset=UTF-8', ...corsHeaders },
        });
      } else {
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
