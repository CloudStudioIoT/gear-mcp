import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GearClient, GearError, gearDate, parseGearDate } from '../src/gear.js';
import { fakeGear, fixture, json, TOKEN } from './helpers.js';

test('parseGearDate understands the three formats Gear returns', () => {
  assert.equal(parseGearDate('/Date(1784030809603+0000)/')!.toISOString(), '2026-07-14T12:06:49.603Z');
  assert.equal(parseGearDate('2026-10-02T14:35:22')!.toISOString(), '2026-10-02T14:35:22.000Z');
  assert.equal(parseGearDate({ Date: { Year: 2026, Month: 10, Day: 2 }, Time: { Hour: 1, Minute: 2, Second: 3 } })!.toISOString(), '2026-10-02T01:02:03.000Z');
});

test('parseGearDate treats Gear empty dates as null', () => {
  assert.equal(parseGearDate('/Date(-62135596800000+0000)/'), null);
  assert.equal(parseGearDate({ Date: { Year: 0, Month: 0, Day: 0 }, Time: {} }), null);
  assert.equal(parseGearDate(null), null);
});

test('gearDate drops milliseconds, which Gear rejects', () => {
  assert.equal(gearDate(new Date('2026-10-02T14:35:22.123Z')), '2026-10-02T14:35:22');
});

test('Service API: token goes in the body and the result is unwrapped', async () => {
  const { gear, calls } = fakeGear({ 'POST /services/core/FacilityService.svc/EnumAccountFacilities': json(fixture('EnumAccountFacilities.json')) });
  const r = await gear.service<unknown[]>('core/FacilityService', 'EnumAccountFacilities', { accountID: 0 });
  assert.equal(r.length, 2);
  assert.deepEqual(calls[0].body, { accessToken: TOKEN, accountID: 0 });
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
});

test('REST v2: token goes as Bearer and empty params are dropped', async () => {
  const { gear, calls } = fakeGear({ 'GET /api/v2/alarms': json('[]') });
  await gear.rest('alarms', { facilityID: 12, state: 'open', dateFrom: undefined, deviceID: null });
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].url.search, '?facilityID=12&state=open');
});

test('a Gear fault (HTTP 500, recorded from a development instance) becomes a GearError with its FaultCode', async () => {
  const { gear } = fakeGear({ 'GET /api/v2/alarms': () => ({ status: 500, body: fixture('error-8001.json') }) });
  await assert.rejects(gear.rest('alarms', { clientID: 1 }), (e: GearError) => e.faultCode === '8001' && /invalid or has expired/.test(e.message));
});

test('a wrong URL (HTML 404) is reported as such, not as a parse error', async () => {
  const { gear } = fakeGear({});
  await assert.rejects(gear.rest('nope'), (e: GearError) => e.faultCode === 'HTTP' && e.httpStatus === 404);
});

test('login without an access token (2FA) fails clearly', async () => {
  const { fetchImpl } = fakeGear({
    'POST /services/core/AdminService.svc/LoginWithExpiration': json('{"LoginWithExpirationResult":{"AccessToken":null,"VerificationCode":{"Status":1}}}'),
  });
  await assert.rejects(GearClient.login('https://gear.test', 'app', 'a@b.c', 'x', 60, fetchImpl), /two-factor/);
});
