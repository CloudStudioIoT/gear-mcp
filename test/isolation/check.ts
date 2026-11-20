/**
 * Isolation check against a real Gear instance: two users of two different clients, through the HTTP transport.
 *
 *   GEAR_URL=https://gear.example.com GEAR_TOKEN_A=<guid> GEAR_TOKEN_B=<guid> npm run test:isolation
 *
 * Each user must see only their own client in the six tools, also when they pass the other client's
 * facility, device, endpoint or client ID by hand. Requests of both users go interleaved through one server
 * process, to show that nothing of one request reaches the next. Without the write variables it only reads.
 *
 * With GEAR_MCP_ALLOW_CLAIM=1 and/or GEAR_MCP_ALLOW_COMMANDS=1 it also checks that each user cannot claim into, or send a
 * command to, the other's facility or device. Those calls only use the other user's IDs and made-up serials and command
 * IDs: they must fail at the permission check. Run them against a development instance.
 *
 * Not part of `npm test`: it needs two real tokens. Exit code 0 = no leak (read the last line: it says when the check
 * was only partial), 1 = a leak or a failed check, 2 = setup.
 */
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleHttp } from '../../src/index.js';
import { writeOptionsFromEnv } from '../../src/tools.js';

const writes = writeOptionsFromEnv();

type Result = { isError?: boolean; text: string; data: unknown };
interface Sample { facilities: Set<number>; clients: Set<number>; facility: number; client: number; device?: { id: number; name: string }; endpoint?: number }

const base = (process.env.GEAR_URL ?? '').trim();
const tokens = { A: (process.env.GEAR_TOKEN_A ?? '').trim(), B: (process.env.GEAR_TOKEN_B ?? '').trim() };
if (!/^https?:\/\//.test(base) || !tokens.A || !tokens.B || tokens.A === tokens.B) {
  console.error('Set GEAR_URL, GEAR_TOKEN_A and GEAR_TOKEN_B (two users of two different clients).');
  process.exit(2);
}

let failures = 0;
let partial = false;
let inconclusive = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'isolation-check', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]?.text ?? '';
  let data: unknown = null;
  if (!r.isError) { try { data = JSON.parse(text); } catch { /* left null */ } }
  return { isError: r.isError === true, text, data };
}

/** What a user legitimately sees: their facilities and clients, and one device and endpoint to aim at. */
async function sample(client: Client, who: string, unseenBy: Set<number> = new Set()): Promise<Sample> {
  const r = await call(client, 'list_facilities');
  const list = (r.data ?? []) as { facility_id: number; client_id: number }[];
  if (r.isError || !list.length) { console.error(`${who}: list_facilities gave nothing (${r.text}). Use a user with at least one facility.`); process.exit(2); }
  const s: Sample = { facilities: new Set(list.map((f) => f.facility_id)), clients: new Set(list.map((f) => f.client_id)), facility: list[0].facility_id, client: list[0].client_id };
  // Aim at what the other user cannot see: when one user sees part of the other's clients, only that part counts.
  const foreign = list.filter((f) => !unseenBy.has(f.facility_id));
  if (foreign[0]) { s.facility = foreign[0].facility_id; s.client = foreign[0].client_id; }
  for (const f of foreign.slice(0, 20)) {
    const d = await call(client, 'list_devices', { facility_id: f.facility_id });
    if (d.isError) { console.log(`${who}: own list_devices(${f.facility_id}) fails: ${d.text.slice(0, 120)}`); break; }
    const dev = ((d.data as { devices?: { device_id: number; name: string }[] })?.devices ?? [])[0];
    if (!dev) continue;
    s.facility = f.facility_id; s.client = f.client_id; s.device = { id: dev.device_id, name: dev.name };
    const g = await call(client, 'get_device', { device_id: dev.device_id });
    s.endpoint = ((g.data as { endpoints?: { endpoint_id: number }[] })?.endpoints ?? [])[0]?.endpoint_id;
    break;
  }
  console.log(`${who}: ${s.facilities.size} facilities, clients [${[...s.clients].join(', ')}], aims at facility ${s.facility}, ` +
    `device ${s.device?.id ?? '-'}, endpoint ${s.endpoint ?? '-'}`);
  return s;
}

/** A call with the other user's IDs must fail, and the error must not carry the other user's data. */
function denied(r: Result, what: string, foreignName?: string): void {
  // 8000 = the application behind the token lacks that API permission: Gear stops before looking at whose data it
  // is, so it proves nothing about isolation. Only 8004 (no access to that facility, device...) does.
  if (r.isError && /^Gear 8000\b/.test(r.text)) {
    console.log(`N/A   ${what}  — ${r.text.slice(0, 120)}`);
    inconclusive++;
    return;
  }
  const leaked = !!foreignName && r.text.includes(foreignName);
  check(r.isError === true && !leaked, what, r.isError ? r.text.slice(0, 120) : `returned data: ${r.text.slice(0, 160)}`);
}

async function cross(me: Client, who: string, mine: Sample, other: Sample): Promise<void> {
  denied(await call(me, 'list_devices', { facility_id: other.facility }), `${who} list_devices(foreign facility ${other.facility})`);
  denied(await call(me, 'list_alarms', { facility_id: other.facility, state: 'all' }), `${who} list_alarms(foreign facility)`);
  if (!mine.clients.has(other.client)) {
    denied(await call(me, 'list_alarms', { client_id: other.client, state: 'all' }), `${who} list_alarms(foreign client ${other.client})`);
  }
  if (other.device) {
    denied(await call(me, 'get_device', { device_id: other.device.id }), `${who} get_device(foreign device ${other.device.id})`, other.device.name);
    denied(await call(me, 'list_alarms', { device_id: other.device.id, state: 'all' }), `${who} list_alarms(foreign device)`);
    const all = await call(me, 'find_devices', { query: other.device.name });
    if (all.isError) denied(all, `${who} find_devices("${other.device.name}")`); // an error is no answer: 8000 is N/A, else a leak-free failure
    const hits = ((all.data as { devices?: { device_id: number; facility_id: number }[] })?.devices ?? []);
    if (!all.isError) check(!hits.some((h) => h.device_id === other.device!.id || other.facilities.has(h.facility_id)),
      `${who} find_devices("${other.device.name}") finds nothing of the other client`, `${hits.length} hit(s), all own`);
    denied(await call(me, 'find_devices', { query: other.device.name, facility_id: other.facility }), `${who} find_devices(.., foreign facility_id)`);
  }
  if (other.endpoint) {
    denied(await call(me, 'get_endpoint_history', { endpoint_id: other.endpoint, date_from: '2020-01-01' }), `${who} get_endpoint_history(foreign endpoint ${other.endpoint})`);
    denied(await call(me, 'list_alarms', { endpoint_id: other.endpoint, state: 'all' }), `${who} list_alarms(foreign endpoint)`);
  }
  const facilities = ((await call(me, 'list_facilities')).data ?? []) as { facility_id: number }[];
  check(facilities.every((f) => mine.facilities.has(f.facility_id)), `${who} list_facilities lists only its own`);

  // Write tools, only when the server was started with them. Only foreign IDs are used, so nothing of the caller's
  // own changes: a claim into the other's facility with a made-up serial and a custom command with a made-up ID.
  // Both must stop at the permission check; a "Rejected" claim or any command answer means it got past it.
  if (writes.allowClaim) {
    const r = await call(me, 'claim_device', { facility_id: other.facility, serial_number: 'ISOLATION-CHECK-0000', claim_code: 'ISOLATION-CHECK' });
    denied(r, `${who} claim_device(into foreign facility ${other.facility})`);
  }
  if (writes.allowCommands && other.device && other.endpoint) {
    const r = await call(me, 'send_command', { device_id: other.device.id, endpoint_id: other.endpoint, action: 'custom', command_id: 999999999 });
    denied(r, `${who} send_command(foreign device ${other.device.id}, endpoint ${other.endpoint})`);
  }
}

const srv = createServer((req, res) => { void handleHttp(base, req, res); });
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
try {
  const [a, b] = await Promise.all([connect(url, tokens.A), connect(url, tokens.B)]);
  const [sa0, sb0] = [await sample(a, 'A'), await sample(b, 'B')];
  // Each user is aimed at the other's facilities that it does not see itself.
  const sa = await sample(a, 'A (aimed at by B)', sb0.facilities);
  const sb = await sample(b, 'B (aimed at by A)', sa0.facilities);
  sa.facilities = sa0.facilities; sb.facilities = sb0.facilities;

  const shared = [...sa.facilities].filter((f) => sb.facilities.has(f));
  const aForeign = [...sb.facilities].filter((f) => !sa.facilities.has(f));
  const bForeign = [...sa.facilities].filter((f) => !sb.facilities.has(f));
  if (shared.length) {
    console.log(`NOTE  A and B share ${shared.length} facilities: each direction only uses what the caller does not see. ` +
      'For the full check use users of two different clients, neither an administrator.');
  }
  if (aForeign.length) await cross(a, 'A', sa, sb); else console.log('SKIP  A → B: B sees nothing that A does not');
  if (bForeign.length) await cross(b, 'B', sb, sa); else console.log('SKIP  B → A: A sees nothing that B does not');
  partial = !aForeign.length || !bForeign.length || shared.length > 0;

  // Interleaved requests on the same process: each answer must match its own token, never the other's.
  const rounds = await Promise.all(Array.from({ length: 10 }, (_, i) => call(i % 2 ? b : a, 'list_facilities')));
  check(rounds.every((r, i) => ((r.data ?? []) as { facility_id: number }[]).every((f) => (i % 2 ? sb : sa).facilities.has(f.facility_id))),
    'interleaved requests of A and B each get their own facilities');

  // No token and a wrong token.
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  check((await fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify(init) })).status === 401, 'no token → 401');
  const stranger = await connect(url, '00000000-0000-0000-0000-000000000000');
  const s = await call(stranger, 'list_facilities');
  check(s.isError === true && /8001/.test(s.text), 'unknown token → Gear 8001', s.text.slice(0, 80));

  await Promise.all([a.close(), b.close(), stranger.close()]);
} finally {
  srv.close();
}
console.log(failures ? `\n${failures} check(s) FAILED`
  : partial || inconclusive ? `\nNo leak found, but the check was PARTIAL (${[partial && 'overlapping users', inconclusive && `${inconclusive} call(s) stopped by a missing application permission`].filter(Boolean).join('; ')}): ` +
    'repeat with two users of different clients whose application has the six API permissions in the README'
  : '\nAll isolation checks passed');
process.exit(failures ? 1 : 0);
