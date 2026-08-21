import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_MIME = /^(?:text\/plain|text\/html|application\/json)(?:\s*;|$)/i;

function ipv4Parts(value) {
  if (isIP(value) !== 4) return null;
  const parts = value.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

export function isPrivateAddress(address) {
  const ipv4 = ipv4Parts(address);
  if (ipv4) {
    const [a, b] = ipv4;
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
  }
  if (isIP(address) !== 6) return true;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (ipv4Parts(normalized)) return isPrivateAddress(normalized);
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
}

export function validateSearchUrl(value) {
  const url = new URL(value);
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) throw new Error("search endpoint must use http or https");
  if (url.username || url.password) throw new Error("search endpoint must not contain credentials");
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) throw new Error("search endpoint hostname is not public");
  if (isIP(url.hostname) && isPrivateAddress(url.hostname)) throw new Error("search endpoint resolves to a private address");
  return url;
}

async function publicAddress(hostname) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new Error("search endpoint DNS result is not public");
  return addresses[0];
}

export async function safeSearchFetch(endpoint, { maxBytes = 1_000_000, timeoutMs = 10_000, signal } = {}) {
  const url = validateSearchUrl(endpoint);
  const address = await publicAddress(url.hostname);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve(value);
    };
    const onAbort = () => req.destroy(new Error("search request aborted"));
    const req = request({
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { host: url.host, accept: "text/plain, text/html, application/json", "user-agent": "dsh-codex-search/0.1.0" },
      ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); finish(new Error("search endpoint redirects are not allowed")); return; }
      if (response.statusCode < 200 || response.statusCode >= 300) { response.resume(); finish(new Error(`search endpoint returned HTTP ${response.statusCode}`)); return; }
      if (!ALLOWED_MIME.test(response.headers["content-type"] ?? "")) { response.resume(); finish(new Error("search endpoint returned a disallowed MIME type")); return; }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) { response.resume(); finish(new Error("search response exceeds the configured size limit")); return; }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(new Error("search response exceeds the configured size limit")); return; }
        chunks.push(chunk);
      });
      response.on("error", (error) => finish(error));
      response.on("end", () => finish(null, { status: response.statusCode, contentType: response.headers["content-type"] ?? "", text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("search request timed out")));
    req.on("error", (error) => finish(error));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}
