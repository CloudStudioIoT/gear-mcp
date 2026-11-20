#!/usr/bin/env node
/**
 * Gear MCP server (read-only unless GEAR_MCP_ALLOW_CLAIM or GEAR_MCP_ALLOW_COMMANDS is set to 1).
 *
 * stdio (Claude Desktop, Claude Code):
 *   GEAR_URL=https://gear.example.com GEAR_TOKEN=<access token> gear-mcp
 *   or GEAR_APP_TOKEN + GEAR_EMAIL + GEAR_PASSWORD instead of GEAR_TOKEN (logs in with a 12 h token).
 *
 * Streamable HTTP (remote):
 *   GEAR_URL=https://gear.example.com gear-mcp --http [--port 3333] [--host 127.0.0.1]
 *   Each request must carry the user's Gear access token: Authorization: Bearer <token>.
 *   The server keeps no session and no token: every request gets its own server bound to its own token,
 *   so a user only ever sees what that token sees in Gear.
 */
import { realpathSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { GearClient } from './gear.js';
import { buildServer } from './tools.js';

const VERSION = '0.1.0';
const LOGIN_SECONDS = 12 * 3600;
const MAX_BODY = 1024 * 1024;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function gearUrl(): string {
  const url = (process.env.GEAR_URL ?? '').trim();
  if (!/^https?:\/\//.test(url)) {
    console.error('Set GEAR_URL to your Gear instance, e.g. GEAR_URL=https://gear.example.com');
    process.exit(2);
  }
  return url;
}

async function stdio(): Promise<void> {
  const base = gearUrl();
  let gear: GearClient;
  if (process.env.GEAR_TOKEN) {
    gear = new GearClient(base, process.env.GEAR_TOKEN.trim());
  } else if (process.env.GEAR_APP_TOKEN && process.env.GEAR_EMAIL && process.env.GEAR_PASSWORD) {
    gear = await GearClient.login(base, process.env.GEAR_APP_TOKEN, process.env.GEAR_EMAIL, process.env.GEAR_PASSWORD, LOGIN_SECONDS);
  } else {
    console.error('Set GEAR_TOKEN, or GEAR_APP_TOKEN + GEAR_EMAIL + GEAR_PASSWORD.');
    process.exit(2);
  }
  await buildServer(gear, VERSION).connect(new StdioServerTransport());
  console.error(`gear-mcp ${VERSION} on stdio -> ${base}`); // stdout belongs to the protocol
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/** The Gear access token of an HTTP request: "Authorization: Bearer <guid>". */
export function bearerToken(req: IncomingMessage): string | null {
  const m = /^Bearer\s+([0-9a-fA-F-]{36})\s*$/.exec(req.headers.authorization ?? '');
  return m ? m[1] : null;
}

export async function handleHttp(base: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '').split('?')[0];
  if (path === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (path !== '/mcp') { jsonRpcError(res, 404, 'Not found: the MCP endpoint is /mcp'); return; }
  if (req.method !== 'POST') { jsonRpcError(res, 405, 'Method not allowed: this server is stateless, use POST'); return; }
  const token = bearerToken(req);
  if (!token) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="gear"');
    jsonRpcError(res, 401, 'Missing Authorization: Bearer <Gear access token>');
    return;
  }
  let body: unknown;
  try { body = await readBody(req); } catch { jsonRpcError(res, 400, 'Invalid JSON body'); return; }

  const server = buildServer(new GearClient(base, token), VERSION);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function http(): Promise<void> {
  const base = gearUrl();
  const port = Number(arg('--port') ?? process.env.PORT ?? 3333);
  const host = arg('--host') ?? process.env.HOST ?? '127.0.0.1';
  createServer((req, res) => {
    handleHttp(base, req, res).catch((e) => {
      console.error('request failed:', e);
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal error');
    });
  }).listen(port, host, () => console.error(`gear-mcp ${VERSION} on http://${host}:${port}/mcp -> ${base}`));
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  (process.argv.includes('--http') ? http() : stdio()).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
