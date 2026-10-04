// auth.js — shared auth helper for stluker Workers
// Drop this file into each Worker's src/ and import checkAuth().
// Fixes the two bug classes seen on 2026-06-30:
//   1. malformed "bearer" header (keepalive) — enforces canonical Authorization: Bearer <token>
//   2. plaintext ?secret= query string (stl-bucket) — header-only, query secrets rejected
//
// Usage in a Worker:
//   import { checkAuth } from "./auth.js";
//   export default {
//     async fetch(req, env, ctx) {
//       const unauthorized = checkAuth(req, env.KEEPALIVE_SECRET);
//       if (unauthorized) return unauthorized;   // 401 short-circuit
//       ...normal handler...
//     }
//   }

/**
 * Constant-time string comparison. Avoids leaking secret length/prefix
 * via early-exit timing. Both sides are hashed to fixed-width bytes first
 * so even length is not observable.
 */
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ha = await crypto.subtle.digest("SHA-256", enc.encode(a));
  const hb = await crypto.subtle.digest("SHA-256", enc.encode(b));
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/**
 * Validates the Authorization: Bearer <token> header against the expected secret.
 * Returns null on success, or a Response(401) on failure — non-instructive body
 * so the endpoint doesn't advertise its own auth scheme to probers.
 *
 * @param {Request} request
 * @param {string} expectedSecret  e.g. env.KEEPALIVE_SECRET
 * @returns {Promise<Response|null>}
 */
export async function checkAuth(request, expectedSecret) {
  if (!expectedSecret) {
    // Misconfiguration: secret not bound. Fail closed, log loudly.
    console.error("AUTH MISCONFIG: expected secret is empty/undefined");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // Reject query-string secrets outright so nobody reintroduces ?secret=
  const url = new URL(request.url);
  if (url.searchParams.has("secret") || url.searchParams.has("token")) {
    console.warn("AUTH: query-string secret attempt rejected", url.pathname);
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const provided = match[1].trim();
  const ok = await timingSafeEqual(provided, expectedSecret);
  if (!ok) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  return null; // authorized
}
