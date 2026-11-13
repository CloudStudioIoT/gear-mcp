import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, claimDevice, sendCommand, writeOptionsFromEnv, WriteOptions } from '../src/tools.js';
import { fakeGear, fixture, TOKEN } from './helpers.js';

const READ = ['find_devices', 'get_device', 'get_endpoint_history', 'list_alarms', 'list_devices', 'list_facilities'];
const CLAIM = 'POST /api/v2/deviceInventory/claim';
const EXECUTE = 'POST /services/core/CommandService.svc/ExecuteCommand';

async function toolsWith(write: WriteOptions) {
  const { gear } = fakeGear({});
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([buildServer(gear, '0', write).connect(a), client.connect(b)]);
  return (await client.listTools()).tools;
}

test('without the variables the write tools do not exist', async () => {
  const tools = await toolsWith({ allowClaim: false, allowCommands: false });
  assert.deepEqual(tools.map((t) => t.name).sort(), READ);
});

test('each variable switches on its own tool, with write annotations', async () => {
  const claimOnly = await toolsWith({ allowClaim: true, allowCommands: false });
  assert.deepEqual(claimOnly.map((t) => t.name).sort(), [...READ, 'claim_device'].sort());
  const both = await toolsWith({ allowClaim: true, allowCommands: true });
  const by = Object.fromEntries(both.map((t) => [t.name, t]));
  assert.equal(both.length, 8);
  assert.equal(by.claim_device.annotations?.readOnlyHint, false);
  assert.equal(by.claim_device.annotations?.destructiveHint, false);
  assert.equal(by.send_command.annotations?.readOnlyHint, false);
  assert.equal(by.send_command.annotations?.destructiveHint, true);
});

test('only "1" switches a tool on', () => {
  assert.deepEqual(writeOptionsFromEnv({}), { allowClaim: false, allowCommands: false });
  assert.deepEqual(writeOptionsFromEnv({ GEAR_MCP_ALLOW_CLAIM: 'true', GEAR_MCP_ALLOW_COMMANDS: 'yes' }), { allowClaim: false, allowCommands: false });
  assert.deepEqual(writeOptionsFromEnv({ GEAR_MCP_ALLOW_CLAIM: ' 1 ', GEAR_MCP_ALLOW_COMMANDS: '1' }), { allowClaim: true, allowCommands: true });
});

test('claim_device posts to REST v2 with the user token and passes the outcome on', async () => {
  const { gear, calls } = fakeGear({ [CLAIM]: () => ({ body: '{"Outcome":"Claimed","DeviceID":777,"BlockedMinutes":null}' }) });
  const r = await claimDevice(gear, 12, ' SN-001 ', 'ABC123', '70B3D57ED0000001', 'Freezer 9');
  assert.deepEqual(r, { outcome: 'Claimed', device_id: 777, blocked_minutes: null, facility_id: 12 });
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(calls[0].body, { FacilityID: 12, SerialNumber: 'SN-001', ClaimCode: 'ABC123', Address: '70B3D57ED0000001', Description: 'Freezer 9' });
});

test('claim_device: a rejection and a block come back as Gear gives them', async () => {
  const { gear } = fakeGear({ [CLAIM]: () => ({ body: '{"Outcome":"Blocked","DeviceID":null,"BlockedMinutes":60}' }) });
  assert.deepEqual(await claimDevice(gear, 12, 'SN', 'X'), { outcome: 'Blocked', device_id: null, blocked_minutes: 60, facility_id: 12 });
});

test('claim_device: without permission it is a Gear error', async () => {
  const { gear } = fakeGear({ [CLAIM]: () => ({ status: 500, body: '{"Exception":{"FaultCode":"8004","Message":"Access denied"}}' }) });
  await assert.rejects(claimDevice(gear, 99, 'SN', 'X'), /Gear 8004/);
});

test('send_command builds an on/off command and reads the response', async () => {
  const { gear, calls } = fakeGear({ [EXECUTE]: () => ({ body: '{"ExecuteCommandResult":{"ResponseType":0,"ErrorCode":null,"ErrorMessage":"","ResponseData":"ok"}}' }) });
  const r = await sendCommand(gear, 501, 9503, 'off');
  assert.deepEqual(calls[0].body, { accessToken: TOKEN, command: { DeviceID: 501, EndpointID: 9503, OnOff: { CommandType: 1 } }, timeoutSeconds: 30, password: null });
  assert.equal(r.result, 'success');
  assert.equal(r.response, 'ok');
});

test('send_command: custom needs a command id, and an unsupported answer says so', async () => {
  const { gear, calls } = fakeGear({ [EXECUTE]: () => ({ body: '{"ExecuteCommandResult":{"ResponseType":2,"ErrorCode":"4008","ErrorMessage":"No driver"}}' }) });
  await assert.rejects(sendCommand(gear, 501, 9503, 'custom'), /command_id is required/);
  assert.equal(calls.length, 0, 'nothing is sent');
  const r = await sendCommand(gear, 501, 9503, 'custom', 7, 'reboot');
  assert.deepEqual((calls[0].body as { command: unknown }).command, { DeviceID: 501, EndpointID: 9503, Custom: { CommandID: 7, CommandData: 'reboot' } });
  assert.equal(r.result, 'unsupported');
  assert.equal(r.error_message, 'No driver');
});

test('send_command: an endpoint the user cannot operate is a Gear error', async () => {
  const { gear } = fakeGear({ [EXECUTE]: () => ({ status: 500, body: fixture('error-8001.json').replace('8001', '18004') }) });
  await assert.rejects(sendCommand(gear, 1, 2, 'on'), /Gear 18004/);
});
