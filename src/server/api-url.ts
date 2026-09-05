/**
 * Where the agent (and the adapter itself) reaches the Paperclip API.
 *
 * A hosted Paperclip sets `PAPERCLIP_API_URL` to its *public* origin so that
 * links in the UI point at something a browser can open. That origin sits
 * behind the reverse proxy's SSO: an API call from the agent is answered with
 * a redirect to the identity provider instead of JSON, so every request the
 * agent makes fails. kiro-cli always runs on the same host as the Paperclip
 * server, so the API is reachable over loopback — use that instead, whatever
 * the public origin says.
 */

/** Bind addresses that mean "every interface" rather than a reachable host. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * True for a URL whose host is on this machine. `127.0.0.0/8` counts: some
 * deployments bind a second loopback address.
 */
export function isLocalApiUrl(value: string): boolean {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  // URL#hostname drops the brackets around an IPv6 literal.
  if (host === "::1") return true;
  return /^127\./.test(host);
}

/**
 * Turns a bind address into a host a client on the same machine can connect
 * to. A wildcard bind is resolved to the matching loopback literal rather than
 * to `localhost`: on a host where `localhost` resolves to `::1` first, an
 * IPv4-only server is unreachable under that name.
 */
function resolveLoopbackHost(rawHost: string): string {
  const host = rawHost.trim();
  if (!host || host === "0.0.0.0") return "127.0.0.1";
  if (WILDCARD_HOSTS.has(host)) return "[::1]";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

/**
 * The base URL the agent must use for `/api/...` calls. Never returns the
 * public origin unless an operator has explicitly pointed
 * `PAPERCLIP_LOCAL_API_URL` somewhere else (a bridge, a sidecar).
 */
export function resolveLocalApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.PAPERCLIP_LOCAL_API_URL ?? "").trim();
  if (override) return stripTrailingSlash(override);

  // A configured URL that is already local is kept verbatim — it carries the
  // port the server actually listens on.
  const configured = (env.PAPERCLIP_RUNTIME_API_URL ?? env.PAPERCLIP_API_URL ?? "").trim();
  if (configured && isLocalApiUrl(configured)) return stripTrailingSlash(configured);

  const host = resolveLoopbackHost(env.PAPERCLIP_LISTEN_HOST ?? env.HOST ?? "");
  const port = (env.PAPERCLIP_LISTEN_PORT ?? env.PORT ?? "3100").trim() || "3100";
  return `http://${host}:${port}`;
}

/**
 * Keeps loopback calls off any HTTP proxy configured for the host. Without
 * this, `curl` from the agent tunnels its API call out to the proxy, which
 * either cannot route back or lands on the public origin again.
 */
export function ensureLocalhostBypassesProxy(env: Record<string, string>): void {
  const entries = ["localhost", "127.0.0.1", "::1"];
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const current = (env[key] ?? process.env[key] ?? "").trim();
    const present = new Set(
      current
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    );
    const missing = entries.filter((entry) => !present.has(entry));
    if (missing.length === 0) {
      if (current) env[key] = current;
      continue;
    }
    env[key] = current ? `${current},${missing.join(",")}` : missing.join(",");
  }
}
