import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureLocalhostBypassesProxy, isLocalApiUrl, resolveLocalApiUrl } from "./api-url.js";

describe("resolveLocalApiUrl", () => {
  it("ignores a public API URL and uses the loopback listener instead", () => {
    const url = resolveLocalApiUrl({
      PAPERCLIP_API_URL: "https://paperclip.ateam.dev.eggs.de",
      PORT: "3100",
    } as NodeJS.ProcessEnv);

    expect(url).toBe("http://127.0.0.1:3100");
  });

  it("ignores a public runtime API URL as well", () => {
    const url = resolveLocalApiUrl({
      PAPERCLIP_RUNTIME_API_URL: "https://paperclip.ateam.dev.eggs.de",
      PAPERCLIP_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_LISTEN_PORT: "4000",
    } as NodeJS.ProcessEnv);

    expect(url).toBe("http://127.0.0.1:4000");
  });

  it("keeps a configured URL that is already local, port and all", () => {
    const url = resolveLocalApiUrl({
      PAPERCLIP_API_URL: "http://localhost:8080/",
      PORT: "3100",
    } as NodeJS.ProcessEnv);

    expect(url).toBe("http://localhost:8080");
  });

  it("resolves a wildcard bind to the matching loopback literal", () => {
    expect(resolveLocalApiUrl({ PAPERCLIP_LISTEN_HOST: "0.0.0.0", PORT: "3100" } as NodeJS.ProcessEnv))
      .toBe("http://127.0.0.1:3100");
    expect(resolveLocalApiUrl({ PAPERCLIP_LISTEN_HOST: "::", PORT: "3100" } as NodeJS.ProcessEnv))
      .toBe("http://[::1]:3100");
  });

  it("brackets a bare IPv6 bind address", () => {
    expect(resolveLocalApiUrl({ PAPERCLIP_LISTEN_HOST: "::1", PORT: "3100" } as NodeJS.ProcessEnv))
      .toBe("http://[::1]:3100");
  });

  it("falls back to the default port", () => {
    expect(resolveLocalApiUrl({} as NodeJS.ProcessEnv)).toBe("http://127.0.0.1:3100");
  });

  it("honours an explicit local override", () => {
    const url = resolveLocalApiUrl({
      PAPERCLIP_LOCAL_API_URL: "http://paperclip-api:3100/",
      PAPERCLIP_API_URL: "https://paperclip.ateam.dev.eggs.de",
    } as NodeJS.ProcessEnv);

    expect(url).toBe("http://paperclip-api:3100");
  });
});

describe("isLocalApiUrl", () => {
  it("recognises loopback hosts", () => {
    expect(isLocalApiUrl("http://localhost:3100")).toBe(true);
    expect(isLocalApiUrl("http://127.0.0.1:3100")).toBe(true);
    expect(isLocalApiUrl("http://127.0.0.53:3100")).toBe(true);
    expect(isLocalApiUrl("http://[::1]:3100")).toBe(true);
  });

  it("rejects public hosts and unparseable values", () => {
    expect(isLocalApiUrl("https://paperclip.ateam.dev.eggs.de")).toBe(false);
    expect(isLocalApiUrl("paperclip.ateam.dev.eggs.de")).toBe(false);
    expect(isLocalApiUrl("")).toBe(false);
  });
});

describe("ensureLocalhostBypassesProxy", () => {
  // The helper falls back to the host's own no-proxy settings, so pin them.
  beforeEach(() => {
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds the loopback names to an existing no-proxy list without dropping it", () => {
    const env: Record<string, string> = { NO_PROXY: "example.com,localhost" };
    ensureLocalhostBypassesProxy(env);

    expect(env.NO_PROXY).toBe("example.com,localhost,127.0.0.1,::1");
    expect(env.no_proxy).toBe("localhost,127.0.0.1,::1");
  });

  it("leaves a complete list alone", () => {
    const env: Record<string, string> = { NO_PROXY: "localhost,127.0.0.1,::1" };
    ensureLocalhostBypassesProxy(env);

    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
  });
});
