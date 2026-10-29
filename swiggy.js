// Swiggy's official MCP servers (Swiggy Builders Club): https://mcp.swiggy.com/builders/docs/
// Login is OAuth 2.1 + PKCE. The user types their phone number and OTP on Swiggy's own page;
// we only ever receive an access token (5 days) and a refresh token (rotates on every refresh).
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const AUTH = 'https://mcp.swiggy.com/auth';
const RESOURCE = 'https://mcp.swiggy.com';
export const FOOD_URL = 'https://mcp.swiggy.com/food';

const b64url = (buf) => buf.toString('base64url');

/**
 * @param {object} store  the app's db object; Swiggy client registration and tokens are kept in it
 * @param {() => void} save
 * @param {string} publicUrl  where this app is reachable, e.g. http://localhost:3000
 */
export function swiggy(store, save, publicUrl) {
  const redirectUri = `${publicUrl}/oauth/swiggy/callback`;
  const pending = new Map(); // state -> { userId, verifier, at }

  // Dynamic Client Registration (RFC 7591): done once per redirect URI and remembered.
  async function clientId() {
    store.swiggyClient ||= {};
    if (store.swiggyClient[redirectUri]) return store.swiggyClient[redirectUri];
    const res = await fetch(`${AUTH}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Order Agent', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mcp:tools',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.client_id) throw new Error(`Swiggy registration failed: ${data.error_description || data.error || res.status}`);
    store.swiggyClient[redirectUri] = data.client_id;
    save();
    return data.client_id;
  }

  /** The Swiggy login URL to send the user to. */
  async function loginUrl(userId) {
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(16));
    for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60 * 1000) pending.delete(k);
    pending.set(state, { userId, verifier, at: Date.now() });
    const q = new URLSearchParams({
      response_type: 'code', client_id: await clientId(), redirect_uri: redirectUri, scope: 'mcp:tools', state,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    return `${AUTH}/authorize?${q}`;
  }

  async function tokenRequest(params) {
    const res = await fetch(`${AUTH}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: await clientId(), resource: RESOURCE, ...params }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(`Swiggy token error: ${data.error_description || data.error || res.status}`);
    return {
      accessToken: data.access_token, refreshToken: data.refresh_token || null,
      expiresAt: Date.now() + (Number(data.expires_in) || 5 * 24 * 60 * 60) * 1000,
    };
  }

  /** Swiggy redirects back here with ?code&state. Returns { userId, tokens }. */
  async function finishLogin(code, state) {
    const p = pending.get(state);
    if (!p) throw new Error('This Swiggy login link expired. Please try again.');
    pending.delete(state);
    const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: p.verifier });
    return { userId: p.userId, tokens };
  }

  /** A valid access token for this link, refreshing it if it expires within the hour. */
  async function accessToken(link) {
    const t = link.tokens;
    if (!t) throw new Error('Swiggy is not linked');
    if (t.expiresAt - Date.now() > 60 * 60 * 1000) return t.accessToken;
    if (!t.refreshToken) throw new Error('Swiggy login expired. Link Swiggy again.');
    link.tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken });
    if (!link.tokens.refreshToken) link.tokens.refreshToken = t.refreshToken;
    save();
    return link.tokens.accessToken;
  }

  /** Opens an MCP session to Swiggy Food for this link. Caller must close() it. */
  async function connect(link) {
    const token = await accessToken(link);
    const client = new Client({ name: 'order-agent', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(FOOD_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    return client;
  }

  return { redirectUri, loginUrl, finishLogin, accessToken, connect };
}
