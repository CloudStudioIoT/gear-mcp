import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDevices, getDevice, getEndpointHistory, listAlarms, listDevices, listFacilities, parseLastUpdateText } from '../src/tools.js';
import { fakeGear, fixture, json, Call } from './helpers.js';

const NOW = new Date(1790953600000); // 1 h after Freezer 1's last data

test('list_facilities maps and sorts by name', async () => {
  const { gear } = fakeGear({ 'POST /services/core/FacilityService.svc/EnumAccountFacilities': json(fixture('EnumAccountFacilities.json')) });
  const r = await listFacilities(gear);
  assert.deepEqual(r.map((f) => [f.facility_id, f.name, f.client_id, f.online]), [[7, 'Cold room A', 3, false], [12, 'Warehouse North', 3, true]]);
});

test('list_devices flags offline, silent, never-seen and alarmed devices', async () => {
  const { gear, calls } = fakeGear({
    'POST /services/core/DeviceService.svc/EnumDevices': json(fixture('EnumDevices-12.json')),
    'POST /services/core/DeviceService.svc/EnumEndpointsForFacility': json(fixture('EnumEndpointsForFacility-12.json')),
    'GET /api/v2/alarms': json(fixture('alarms-facility-12-open.json')),
  });
  const r = await listDevices(gear, 12, false, 24, NOW);
  const by = Object.fromEntries(r.devices.map((d) => [d.device_id, d]));
  assert.deepEqual(by[501].problems, []);
  assert.equal(by[501].hours_since_data, 1);
  assert.deepEqual(by[502].problems, ['offline', 'no data for 70 h', '2 open alarm(s)']);
  assert.deepEqual(by[503].problems, ['never sent data']);
  assert.equal(by[503].last_data_utc, null);
  assert.equal(r.devices_with_problems, 2);
  const alarmsCall = calls.find((c) => c.url.pathname === '/api/v2/alarms') as Call;
  assert.equal(alarmsCall.url.searchParams.get('facilityID'), '12');
  assert.equal(alarmsCall.url.searchParams.get('state'), 'open');
  assert.equal(alarmsCall.url.searchParams.get('maxCount'), '500');
});

test('list_devices only_problems leaves the healthy ones out', async () => {
  const { gear } = fakeGear({
    'POST /services/core/DeviceService.svc/EnumDevices': json(fixture('EnumDevices-12.json')),
    'POST /services/core/DeviceService.svc/EnumEndpointsForFacility': json(fixture('EnumEndpointsForFacility-12.json')),
    'GET /api/v2/alarms': json(fixture('alarms-facility-12-open.json')),
  });
  const r = await listDevices(gear, 12, true, 24, NOW);
  assert.deepEqual(r.devices.map((d) => d.device_id).sort(), [502, 503]);
});

const LIVE_501 = 'POST /services/core/DeviceService.svc/GetDeviceLiveData';
const ENDPOINTS_12 = 'POST /services/core/DeviceService.svc/EnumEndpointsForFacility';

test('get_device returns the live value of each endpoint as number and display text', async () => {
  const { gear, calls } = fakeGear({ [LIVE_501]: json(fixture('GetDeviceLiveData-501.json')), [ENDPOINTS_12]: json(fixture('EnumEndpointsForFacility-12.json')) });
  const r = await getDevice(gear, 501);
  assert.equal(calls[0].body!.deviceID, 501);
  assert.equal(r.name, 'Freezer 1');
  assert.equal(r.model, 'Tekelek TEK-811');
  assert.deepEqual(r.facility, { facility_id: 12, name: 'Warehouse North' });
  assert.deepEqual(r.endpoints, [
    { endpoint_id: 9501, name: 'Temperature', value: -19.4, display: '-19.4 °C', online: true },
    { endpoint_id: 9503, name: 'Door', value: 0, display: 'Closed', online: true },
    { endpoint_id: 9504, name: 'Parking spot', value: 0, display: 'Vacant', online: true }, // "Vacant " in Gear
    { endpoint_id: 9505, name: 'Spare', value: null, display: null, online: false }, // " " in Gear
  ]);
});

test('get_device gives the last data in UTC from the endpoints, never the local text', async () => {
  const { gear, calls } = fakeGear({ [LIVE_501]: json(fixture('GetDeviceLiveData-501.json')), [ENDPOINTS_12]: json(fixture('EnumEndpointsForFacility-12.json')) });
  const r = await getDevice(gear, 501);
  assert.equal(calls[1].body!.facilityID, 12);
  assert.equal(r.last_data_utc, '2026-10-02T14:06:40.000Z'); // newest of 9501 and 9503; 502's endpoints do not count
  assert.equal('last_update' in r, false);
});

test('get_device falls back to the text with its offset when the endpoints cannot be read', async () => {
  const live = JSON.parse(fixture('GetDeviceLiveData-501.json'));
  live.GetDeviceLiveDataResult.Device.LastUpdate = '22/10/2026 10:46:40 - (UTC+02:00) Madrid';
  const { gear } = fakeGear({ [LIVE_501]: json(JSON.stringify(live)), [ENDPOINTS_12]: () => ({ status: 500, body: fixture('error-8001.json') }) });
  assert.equal((await getDevice(gear, 501)).last_data_utc, '2026-10-22T08:46:40.000Z');
  // The fixture's own text, 10/02/2026, could be 2 October or 10 February: null, not a guess.
  const { gear: ambiguous } = fakeGear({ [LIVE_501]: json(fixture('GetDeviceLiveData-501.json')) });
  assert.equal((await getDevice(ambiguous, 501)).last_data_utc, null);
});

test('parseLastUpdateText reads only what is not ambiguous', () => {
  const iso = (t: string) => parseLastUpdateText(t)?.toISOString() ?? null;
  assert.equal(iso('10/22/2026 10:46:40 - (UTC+02:00) Madrid'), '2026-10-22T08:46:40.000Z');
  assert.equal(iso('22/10/2026 10:46:40 - (UTC+02:00) Madrid'), '2026-10-22T08:46:40.000Z');
  assert.equal(iso('2026-10-02 10:46:40 - (UTC-05:00) Bogota'), '2026-10-02T15:46:40.000Z');
  assert.equal(iso('10/22/2026 01:15:00 PM - (UTC-03:00) Buenos Aires'), '2026-10-22T16:15:00.000Z');
  assert.equal(iso('10/22/2026 12:05 AM - (UTC) Coordinated Universal Time'), '2026-10-22T00:05:00.000Z');
  assert.equal(iso('05/05/2026 23:30:00 - (UTC+05:30) Kolkata'), '2026-05-05T18:00:00.000Z');
  assert.equal(iso('10/02/2026 10:46:40 - (UTC+02:00) Madrid'), null); // day and month could be swapped
  assert.equal(iso('10/22/2026 10:46:40'), null); // no offset: it would be local time
  assert.equal(iso(''), null);
  assert.equal(parseLastUpdateText(undefined), null);
});

test('get_device gives no battery percentage when Gear did not calculate one', async () => {
  const live = JSON.parse(fixture('GetDeviceLiveData-501.json'));
  live.GetDeviceLiveDataResult.Device.Batteries.push({ Percentage: 0, Voltage: 0 }, { Voltage: 3.3 }, { Percentage: 0 });
  const { gear } = fakeGear({ [LIVE_501]: json(JSON.stringify(live)) });
  assert.deepEqual((await getDevice(gear, 501)).batteries, [
    { percentage: 87, voltage: 3.6 },
    { percentage: null, voltage: 3.15 }, // 0 % with 3.15 V: not calculated
    { percentage: 0, voltage: 0 }, // a 0 without voltage stays as it comes
    { percentage: null, voltage: 3.3 },
    { percentage: 0, voltage: null },
  ]);
});

function historyRows(startMs: number, n: number, seq0: number) {
  return Array.from({ length: n }, (_, i) => ({
    EndpointID: 9501, Description: 'Temperature', SequenceNumber: seq0 + i,
    Timestamp_UTC: new Date(startMs + i * 60000).toISOString().slice(0, 19), Value: -20 + (i % 5),
    IsOn: null, DimLevel: null, Position: null, IsMoving: null, ActiveEnergy: null, ReactiveEnergy: null, ApparentEnergy: null,
    Latitude: null, Longitude: null, LocationFlags: null,
  }));
}

test('get_endpoint_history pages past 500 rows from the last timestamp and drops the overlap', async () => {
  const t0 = Date.UTC(2026, 9, 1);
  const page1 = historyRows(t0, 500, 1000);
  const page2 = [page1[499], ...historyRows(t0 + 500 * 60000, 120, 1500)]; // starts at the last timestamp, inclusive
  const { gear, calls } = fakeGear({ 'GET /api/v2/endpointData': (c) => ({ body: JSON.stringify(c.url.searchParams.get('dateFrom') === '2026-10-01T00:00:00' ? page1 : page2) }) });
  const r = await getEndpointHistory(gear, 9501, '2026-10-01', '2026-10-02T00:00:00.000Z', 5000);
  assert.equal(r.count, 620);
  assert.equal(r.truncated, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.searchParams.get('dateTo'), '2026-10-02T00:00:00');
  assert.equal(calls[1].url.searchParams.get('dateFrom'), page1[499].Timestamp_UTC);
  assert.deepEqual(r.points[0], { time_utc: '2026-10-01T00:00:00', value: -20 });
  assert.deepEqual(r.summary, { min: -20, max: -16, avg: -18 });
});

test('get_endpoint_history stops at max_points and says so', async () => {
  const { gear } = fakeGear({ 'GET /api/v2/endpointData': json(JSON.stringify(historyRows(Date.UTC(2026, 9, 1), 500, 1))) });
  const r = await getEndpointHistory(gear, 9501, '2026-10-01', undefined, 100);
  assert.equal(r.count, 100);
  assert.equal(r.truncated, true);
});

test('get_endpoint_history rejects a date it cannot read', async () => {
  const { gear } = fakeGear({});
  await assert.rejects(getEndpointHistory(gear, 1, 'yesterday', undefined, 10), /date_from is not a valid date/);
});

test('list_alarms needs exactly one scope and sorts newest first', async () => {
  const { gear, calls } = fakeGear({ 'GET /api/v2/alarms': json(fixture('alarms-facility-12-open.json')) });
  await assert.rejects(listAlarms(gear, {}), /exactly one/);
  await assert.rejects(listAlarms(gear, { facility_id: 1, device_id: 2 }), /exactly one/);
  const r = await listAlarms(gear, { device_id: 502, state: 'all', date_from: '2026-10-01', max: 9999 });
  assert.deepEqual(r.alarms.map((a) => a.alarm_id), [9002, 9001]);
  const q = calls[calls.length - 1].url.searchParams;
  assert.equal(q.get('deviceID'), '502');
  assert.equal(q.get('state'), 'all');
  assert.equal(q.get('dateFrom'), '2026-10-01T00:00:00');
  assert.equal(q.get('maxCount'), '500');
});

test('find_devices searches name, address and serial across facilities', async () => {
  const { gear } = fakeGear({
    'POST /services/core/FacilityService.svc/EnumAccountFacilities': json(fixture('EnumAccountFacilities.json')),
    'POST /services/core/DeviceService.svc/EnumDevices': (c) => ({ body: fixture(`EnumDevices-${c.body!.facilityID}.json`) }),
  });
  assert.deepEqual((await findDevices(gear, 'freezer')).devices.map((d) => d.device_id), [501, 502]);
  assert.deepEqual((await findDevices(gear, '6b502217')).devices.map((d) => [d.device_id, d.facility]), [[601, 'Cold room A']]);
  assert.deepEqual((await findDevices(gear, 'SN-0002')).devices.map((d) => d.device_id), [502]);
  const r = await findDevices(gear, 'door', 12);
  assert.equal(r.facilities_searched, 1);
  assert.deepEqual(r.devices.map((d) => d.device_id), [503]);
});
