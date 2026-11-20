import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/tools.js';
import { handleHttp } from '../src/index.js';
import { fakeGear, fixture, json } from './helpers.js';

async function connected(routes: Parameters<typeof fakeGear>[0]) {
  const { gear } = fakeGear(routes);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([buildServer(gear, '0', { allowClaim: false, allowCommands: false }).connect(a), client.connect(b)]);
  return client;
}

test('the server exposes six read-only tools', async () => {
  const client = await connected({});
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ['find_devices', 'get_device', 'get_endpoint_history', 'list_alarms', 'list_devices', 'list_facilities']);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.equal(t.annotations?.destructiveHint, false, t.name);
  }
});

test('a tool call returns JSON text', async () => {
  const client = await connected({ 'POST /services/core/FacilityService.svc/EnumAccountFacilities': json(fixture('EnumAccountFacilities.json')) });
  const r = await client.callTool({ name: 'list_facilities', arguments: {} });
  const content = r.content as { type: string; text: string }[];
  assert.equal(r.isError, undefined);
  assert.equal(JSON.parse(content[0].text).length, 2);
});

test('a Gear error comes back as a tool error with the FaultCode', async () => {
  const client = await connected({ 'POST /services/core/DeviceService.svc/GetDeviceLiveData': () => ({ status: 500, body: fixture('error-8001.json') }) });
  const r = await client.callTool({ name: 'get_device', arguments: { device_id: 1 } });
  assert.equal(r.isError, true);
  assert.match((r.content as { text: string }[])[0].text, /Gear 8001/);
});

test('HTTP transport: requires a Gear token, then serves MCP statelessly', async () => {
  const srv = createServer((req, res) => { void handleHttp('https://gear.test', req, res); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  try {
    const noToken = await fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify(init) });
    assert.equal(noToken.status, 401);
    const badToken = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer not-a-guid' }, body: JSON.stringify(init) });
    assert.equal(badToken.status, 401);
    const ok = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer 11111111-2222-3333-4444-555555555555' }, body: JSON.stringify(init) });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /"serverInfo":\{"name":"gear"/);
    assert.equal((await fetch(`${url}/mcp`, { headers })).status, 405);
    assert.equal((await fetch(`${url}/health`)).status, 200);
  } finally {
    srv.close();
  }
});
