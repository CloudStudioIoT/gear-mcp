import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GearClient, GearError, gearDate, parseGearDate } from './gear.js';

/* Raw Gear shapes, only the fields used here. */
interface Facility { FacilityID: number; ClientID: number; Description: string; IsOnline?: boolean; Location?: { Latitude?: number; Longitude?: number } }
interface Device {
  DeviceID: number; FacilityID: number; Description: string; DeviceModel?: string; Address?: string; SerialNumber?: string;
  IsOnline?: boolean; FirmwareVersion?: string;
}
/* EnumDevices does not say when a device last sent data: that comes from its endpoints' LastStatusDateTime. */
interface FacilityEndpoint { EndpointID: number; DeviceID: number; LastStatusDateTime?: unknown }
interface LiveEndpoint {
  EndpointID?: number; Description?: string; NumericValue?: number | null; ValueString?: string | null; IsOnline?: boolean;
  LastStatusDateTime?: unknown;
}
interface DeviceData {
  Device?: {
    Description?: string; Address?: string; LastUpdate?: string; AlarmCount?: number; DeviceModel?: { Description?: string };
    Batteries?: { Percentage?: number | null; Voltage?: number | null }[]; Endpoints?: LiveEndpoint[];
  };
  Facility?: { FacilityID?: number; Description?: string };
}
interface EndpointData { EndpointID: number; Timestamp_UTC: string; SequenceNumber: number; [k: string]: unknown }
interface Alarm {
  AlarmID: number; AlarmTypeDescription?: string; AlarmSeverityDescription?: string; DeviceID: number; DeviceDescription?: string;
  EndpointID?: number | null; Details?: string; DateTimeCreated_UTC?: string; DateTimeClosed_UTC?: string | null; MTTRMinutes?: number | null;
}

export const MAX_HISTORY_POINTS = 5000;
const REST_PAGE = 500;
const SEARCH_FACILITY_LIMIT = 200;

function hoursSince(d: Date | null, now: Date): number | null {
  return d ? Math.round(((now.getTime() - d.getTime()) / 3.6e6) * 10) / 10 : null;
}

/** "2026-10-01", "2026-10-01T08:00:00Z" or anything Date understands, to Gear's format. */
function toGearDate(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(/T|Z|[+-]\d\d:?\d\d$/.test(value) ? value : value + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) throw new GearError('INPUT', `${name} is not a valid date: ${value}`, 0);
  return gearDate(d);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export async function listFacilities(gear: GearClient) {
  const facilities = await gear.service<Facility[]>('core/FacilityService', 'EnumAccountFacilities', { accountID: 0 });
  return (facilities ?? [])
    .map((f) => ({
      facility_id: f.FacilityID, name: f.Description, client_id: f.ClientID, online: f.IsOnline ?? null,
      latitude: f.Location?.Latitude ?? null, longitude: f.Location?.Longitude ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listDevices(gear: GearClient, facilityId: number, onlyProblems = false, silentHours = 24, now = new Date()) {
  const [devices, endpoints, alarms] = await Promise.all([
    gear.service<Device[]>('core/DeviceService', 'EnumDevices', { facilityID: facilityId }),
    gear.service<FacilityEndpoint[]>('core/DeviceService', 'EnumEndpointsForFacility', { facilityID: facilityId }),
    gear.rest<Alarm[]>('alarms', { facilityID: facilityId, state: 'open', maxCount: REST_PAGE }),
  ]);
  // A device's last data is the newest status of any of its endpoints.
  const lastData = new Map<number, Date>();
  for (const e of endpoints ?? []) {
    const when = parseGearDate(e.LastStatusDateTime);
    const known = lastData.get(e.DeviceID);
    if (when && (!known || when > known)) lastData.set(e.DeviceID, when);
  }
  const open = new Map<number, number>();
  for (const a of alarms ?? []) open.set(a.DeviceID, (open.get(a.DeviceID) ?? 0) + 1);
  const rows = (devices ?? []).map((d) => {
    const last = lastData.get(d.DeviceID) ?? null;
    const hours = hoursSince(last, now);
    const problems: string[] = [];
    if (!d.IsOnline) problems.push('offline');
    if (hours === null) problems.push('never sent data');
    else if (hours > silentHours) problems.push(`no data for ${Math.floor(hours)} h`);
    if (open.get(d.DeviceID)) problems.push(`${open.get(d.DeviceID)} open alarm(s)`);
    return {
      device_id: d.DeviceID, name: d.Description, model: d.DeviceModel ?? null, address: d.Address ?? null,
      online: !!d.IsOnline, last_data_utc: last ? last.toISOString() : null, hours_since_data: hours,
      open_alarms: open.get(d.DeviceID) ?? 0, problems,
    };
  });
  return {
    facility_id: facilityId,
    device_count: rows.length,
    devices_with_problems: rows.filter((r) => r.problems.length).length,
    open_alarms_capped: (alarms ?? []).length >= REST_PAGE,
    devices: (onlyProblems ? rows.filter((r) => r.problems.length) : rows).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Device.LastUpdate is display text in the facility's own date format and time zone
 * ("10/22/2026 10:46:40 - (UTC+02:00) Madrid"), to UTC. Null when it cannot be read without guessing:
 * no offset, or a date where day and month could be swapped.
 */
export function parseLastUpdateText(text: string | null | undefined): Date | null {
  const m = /^\s*(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?\.?[Mm]?\.?\s*-\s*\(UTC(?:([+-])(\d{1,2}):?(\d{2}))?\)/.exec(text ?? '');
  if (!m) return null;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let year: number, month: number, day: number;
  if (m[1].length === 4) [year, month, day] = [a, b, c];
  else if (m[3].length !== 4) return null;
  else if (a > 12 && b <= 12) [year, month, day] = [c, b, a];
  else if (b > 12 && a <= 12) [year, month, day] = [c, a, b];
  else if (a === b) [year, month, day] = [c, a, b];
  else return null; // 10/02 is 2 October or 10 February depending on the facility: not guessed
  let hour = Number(m[4]);
  if (m[7]) hour = (hour % 12) + (/p/i.test(m[7]) ? 12 : 0);
  const offsetMin = m[8] ? (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10])) : 0;
  const t = Date.UTC(year, month - 1, day, hour, Number(m[5]), Number(m[6] ?? 0)) - offsetMin * 60000;
  return Number.isNaN(t) || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 ? null : new Date(t);
}

function newest(dates: (Date | null)[]): Date | null {
  return dates.reduce<Date | null>((max, d) => (d && (!max || d > max) ? d : max), null);
}

export async function getDevice(gear: GearClient, deviceId: number) {
  const data = await gear.service<DeviceData>('core/DeviceService', 'GetDeviceLiveData', { deviceID: deviceId });
  const d = data?.Device ?? {};
  // Last data in UTC, as list_devices does: the newest status of any endpoint. GetDeviceLiveData only has it as
  // local display text, so it is read from the facility's endpoints; the text is the last resort.
  let last = newest((d.Endpoints ?? []).map((e) => parseGearDate(e.LastStatusDateTime)));
  if (!last && data?.Facility?.FacilityID) {
    try {
      const all = await gear.service<FacilityEndpoint[]>('core/DeviceService', 'EnumEndpointsForFacility', { facilityID: data.Facility.FacilityID });
      last = newest((all ?? []).filter((e) => e.DeviceID === deviceId).map((e) => parseGearDate(e.LastStatusDateTime)));
    } catch {
      // without it the text below still gives a date
    }
  }
  last ??= parseLastUpdateText(d.LastUpdate);
  return {
    device_id: deviceId,
    name: d.Description ?? null,
    model: d.DeviceModel?.Description ?? null,
    address: d.Address ?? null,
    facility: data?.Facility ? { facility_id: data.Facility.FacilityID, name: data.Facility.Description } : null,
    last_data_utc: last ? last.toISOString() : null,
    open_alarms: d.AlarmCount ?? 0,
    // Gear sends 0 % when it has a voltage but no percentage for that battery: that is "not calculated", not "empty".
    batteries: (d.Batteries ?? []).map((b) => ({
      percentage: !b.Percentage && (b.Voltage ?? 0) > 0 ? null : b.Percentage ?? null,
      voltage: b.Voltage ?? null,
    })),
    endpoints: (d.Endpoints ?? [])
      .filter((e) => e.EndpointID)
      .map((e) => ({
        endpoint_id: e.EndpointID!,
        name: e.Description ?? null,
        value: e.NumericValue ?? null,
        display: e.ValueString?.trim() || null,
        online: e.IsOnline ?? null,
      })),
  };
}

/** History of one endpoint between two dates, oldest first, paging past the API's 500-row limit. */
export async function getEndpointHistory(gear: GearClient, endpointId: number, dateFrom: string, dateTo: string | undefined, maxPoints: number) {
  const limit = Math.min(Math.max(1, maxPoints), MAX_HISTORY_POINTS);
  const start = toGearDate(dateFrom, 'date_from')!;
  let from = start;
  const to = toGearDate(dateTo, 'date_to');
  const seen = new Set<number>();
  const points: Record<string, unknown>[] = [];
  let truncated = false;
  for (;;) {
    const page = await gear.rest<EndpointData[]>('endpointData', { endpointID: endpointId, dateFrom: from, dateTo: to, maxCount: REST_PAGE });
    let added = 0;
    for (const p of page ?? []) {
      if (seen.has(p.SequenceNumber)) continue; // the next page starts at the last timestamp, inclusive
      seen.add(p.SequenceNumber);
      if (points.length >= limit) { truncated = true; break; }
      const point: Record<string, unknown> = { time_utc: p.Timestamp_UTC };
      for (const k of ['Value', 'IsOn', 'DimLevel', 'Position', 'IsMoving', 'ActiveEnergy', 'ReactiveEnergy', 'ApparentEnergy', 'Latitude', 'Longitude', 'LocationFlags']) {
        if (p[k] !== null && p[k] !== undefined) point[k.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase())] = p[k];
      }
      points.push(point);
      added++;
    }
    if (truncated || !page || page.length < REST_PAGE || added === 0) break;
    from = page[page.length - 1].Timestamp_UTC;
  }
  const values = points.map((p) => p.value).filter((v): v is number => typeof v === 'number');
  return {
    endpoint_id: endpointId,
    date_from: start,
    date_to: to ?? null,
    count: points.length,
    truncated,
    summary: values.length
      ? { min: Math.min(...values), max: Math.max(...values), avg: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000 }
      : null,
    points,
  };
}

export interface AlarmQuery {
  facility_id?: number; device_id?: number; endpoint_id?: number; client_id?: number;
  state?: 'open' | 'closed' | 'all'; date_from?: string; date_to?: string; max?: number;
}

export async function listAlarms(gear: GearClient, q: AlarmQuery) {
  const filters = { clientID: q.client_id, facilityID: q.facility_id, deviceID: q.device_id, endpointID: q.endpoint_id };
  const given = Object.entries(filters).filter(([, v]) => v);
  if (given.length !== 1) {
    throw new GearError('INPUT', 'give exactly one of client_id, facility_id, device_id or endpoint_id', 0);
  }
  const alarms = await gear.rest<Alarm[]>('alarms', {
    [given[0][0]]: given[0][1] as number,
    state: q.state ?? 'open',
    dateFrom: toGearDate(q.date_from, 'date_from'),
    dateTo: toGearDate(q.date_to, 'date_to'),
    maxCount: Math.min(Math.max(1, q.max ?? 100), REST_PAGE),
  });
  return {
    count: (alarms ?? []).length,
    alarms: (alarms ?? [])
      .map((a) => ({
        alarm_id: a.AlarmID, type: a.AlarmTypeDescription ?? null, severity: a.AlarmSeverityDescription ?? null,
        device_id: a.DeviceID, device: a.DeviceDescription ?? null, endpoint_id: a.EndpointID ?? null, details: a.Details ?? null,
        opened_utc: a.DateTimeCreated_UTC ?? null, closed_utc: a.DateTimeClosed_UTC ?? null, minutes_to_resolve: a.MTTRMinutes ?? null,
      }))
      .sort((a, b) => String(b.opened_utc).localeCompare(String(a.opened_utc))),
  };
}

export async function findDevices(gear: GearClient, query: string, facilityId?: number) {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new GearError('INPUT', 'query is empty', 0);
  const facilities = facilityId ? [{ facility_id: facilityId, name: null as string | null }] : await listFacilities(gear);
  const searched = facilities.slice(0, SEARCH_FACILITY_LIMIT);
  const lists = await mapLimit(searched, 4, async (f) => {
    const devices = await gear.service<Device[]>('core/DeviceService', 'EnumDevices', { facilityID: f.facility_id });
    return (devices ?? []).map((d) => ({ d, facility: f.name }));
  });
  const matches = lists.flat().filter(({ d }) =>
    [d.Description, d.Address, d.SerialNumber].some((v) => v && v.toLowerCase().includes(needle)));
  return {
    query,
    facilities_searched: searched.length,
    facilities_skipped: facilities.length - searched.length,
    count: matches.length,
    devices: matches.slice(0, 50).map(({ d, facility }) => ({
      device_id: d.DeviceID, name: d.Description, facility_id: d.FacilityID, facility, address: d.Address ?? null,
      serial_number: d.SerialNumber || null, model: d.DeviceModel ?? null, online: !!d.IsOnline,
    })),
  };
}

/* ---- Write tools: off unless switched on by environment variable (see writeOptionsFromEnv). ---- */

interface ClaimResult { Outcome?: string; DeviceID?: number | null; BlockedMinutes?: number | null }
interface CommandResponse { ResponseType?: number; ErrorCode?: string | number | null; ErrorMessage?: string | null; ResponseData?: string | null }

/** Which write tools this server registers. Both off by default: without them the server only reads. */
export interface WriteOptions { allowClaim: boolean; allowCommands: boolean }

/** GEAR_MCP_ALLOW_CLAIM=1 and GEAR_MCP_ALLOW_COMMANDS=1 switch the write tools on; anything else leaves them off. */
export function writeOptionsFromEnv(env: Record<string, string | undefined> = process.env): WriteOptions {
  const on = (v: string | undefined) => (v ?? '').trim() === '1';
  return { allowClaim: on(env.GEAR_MCP_ALLOW_CLAIM), allowCommands: on(env.GEAR_MCP_ALLOW_COMMANDS) };
}

/**
 * Claims a device from a manufacturer's inventory into a facility (POST /api/v2/deviceInventory/claim). Gear checks
 * the Devices.Create API permission, the right to create devices in that facility and the Core.DeviceClaiming add-on.
 * A rejected claim does not say why (unknown serial, wrong code or already claimed), and five rejections in fifteen
 * minutes block the account for an hour: the outcome is passed on as Gear gives it.
 */
export async function claimDevice(gear: GearClient, facilityId: number, serialNumber: string, claimCode: string,
  address?: string, description?: string) {
  const r = await gear.restPost<ClaimResult>('deviceInventory/claim', {
    FacilityID: facilityId, SerialNumber: serialNumber.trim(), ClaimCode: claimCode.trim(),
    Address: address?.trim() || null, Description: description?.trim() || null,
  });
  return {
    outcome: r?.Outcome ?? null,
    device_id: r?.DeviceID ?? null,
    blocked_minutes: r?.BlockedMinutes ?? null,
    facility_id: facilityId,
  };
}

export type CommandAction = 'on' | 'off' | 'toggle' | 'custom';
const ON_OFF: Record<string, number> = { on: 0, off: 1, toggle: 2 };
const RESPONSE = ['success', 'error', 'unsupported'];

/**
 * Sends a command to one endpoint (CommandService.ExecuteCommand). Gear checks Devices.Operate and that the user can
 * operate that endpoint. Radio devices apply many commands at their next uplink: success means accepted.
 */
export async function sendCommand(gear: GearClient, deviceId: number, endpointId: number, action: CommandAction,
  commandId?: number, commandData?: string, password?: string, timeoutSeconds = 30) {
  let typed: Record<string, unknown>;
  if (action === 'custom') {
    if (!commandId) throw new GearError('INPUT', 'command_id is required for a custom command', 0);
    typed = { Custom: { CommandID: commandId, CommandData: commandData ?? '' } };
  } else {
    typed = { OnOff: { CommandType: ON_OFF[action] } };
  }
  const r = await gear.service<CommandResponse>('core/CommandService', 'ExecuteCommand', {
    command: { DeviceID: deviceId, EndpointID: endpointId, ...typed },
    timeoutSeconds,
    password: password || null,
  });
  return {
    device_id: deviceId,
    endpoint_id: endpointId,
    action,
    result: RESPONSE[r?.ResponseType ?? -1] ?? 'unknown',
    error_code: r?.ErrorCode ?? null,
    error_message: r?.ErrorMessage || null,
    response: r?.ResponseData || null,
  };
}

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function fail(e: unknown) {
  const message = e instanceof GearError ? e.message : `Unexpected error: ${(e as Error)?.message ?? e}`;
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

async function run(fn: () => Promise<unknown>) {
  try { return ok(await fn()); } catch (e) { return fail(e); }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const isoDate = z.string().describe('UTC date, "2026-10-01" or "2026-10-01T08:00:00Z"');

/** Builds an MCP server whose tools all use this Gear client (and so this user's permissions). */
export function buildServer(gear: GearClient, version = '0.1.0', write: WriteOptions = writeOptionsFromEnv()): McpServer {
  const writes = [write.allowClaim ? 'claim_device claims a device into a facility' : '',
    write.allowCommands ? 'send_command switches real equipment' : ''].filter(Boolean);
  const server = new McpServer({ name: 'gear', version }, {
    instructions:
      (writes.length ? 'Access to a Cloud Studio Gear IoT account. ' : 'Read-only access to a Cloud Studio Gear IoT account. ') +
      'Hierarchy: client > facility > device > endpoint ' +
      '(an endpoint is one variable of a device, e.g. a temperature). Start with list_facilities, then list_devices, ' +
      'get_device for live values, get_endpoint_history for trends and list_alarms for alarms. Times are UTC.' +
      (writes.length ? ' Write tools: ' + writes.join('; ') + '. Always confirm with the user before calling them, ' +
        'naming the facility, device, endpoint and action.' : ''),
  });

  server.registerTool('list_facilities', {
    title: 'List facilities',
    description: 'Facilities (sites) the user can see, with their client and location.',
    inputSchema: {},
    annotations: readOnly,
  }, () => run(() => listFacilities(gear)));

  server.registerTool('list_devices', {
    title: 'List devices of a facility',
    description: 'Devices of a facility with online/offline status, hours since last data and open alarms. ' +
      'Use only_problems to get just the offline, silent or alarmed ones.',
    inputSchema: {
      facility_id: z.number().int().positive(),
      only_problems: z.boolean().optional().describe('Only devices that are offline, silent or have open alarms'),
      silent_hours: z.number().positive().optional().describe('Hours without data to call a device silent (default 24)'),
    },
    annotations: readOnly,
  }, (a) => run(() => listDevices(gear, a.facility_id, a.only_problems ?? false, a.silent_hours ?? 24)));

  server.registerTool('get_device', {
    title: 'Device with live values',
    description: 'One device with the current value of each of its endpoints (number and display text with unit), battery and open alarm count.',
    inputSchema: { device_id: z.number().int().positive() },
    annotations: readOnly,
  }, (a) => run(() => getDevice(gear, a.device_id)));

  server.registerTool('get_endpoint_history', {
    title: 'Endpoint history',
    description: `Readings of one endpoint between two dates, oldest first, with min/max/avg. Up to ${MAX_HISTORY_POINTS} points; ` +
      'for long ranges ask for a shorter one or accept the truncated flag.',
    inputSchema: {
      endpoint_id: z.number().int().positive(),
      date_from: isoDate,
      date_to: isoDate.optional(),
      max_points: z.number().int().positive().max(MAX_HISTORY_POINTS).optional().describe('Default 1000'),
    },
    annotations: readOnly,
  }, (a) => run(() => getEndpointHistory(gear, a.endpoint_id, a.date_from, a.date_to, a.max_points ?? 1000)));

  server.registerTool('list_alarms', {
    title: 'List alarms',
    description: 'Alarms of exactly one client, facility, device or endpoint. state: open (default), closed or all. ' +
      'Newest first, up to 500.',
    inputSchema: {
      client_id: z.number().int().positive().optional(),
      facility_id: z.number().int().positive().optional(),
      device_id: z.number().int().positive().optional(),
      endpoint_id: z.number().int().positive().optional(),
      state: z.enum(['open', 'closed', 'all']).optional(),
      date_from: isoDate.optional(),
      date_to: isoDate.optional(),
      max: z.number().int().positive().max(REST_PAGE).optional().describe('Default 100'),
    },
    annotations: readOnly,
  }, (a) => run(() => listAlarms(gear, a)));

  server.registerTool('find_devices', {
    title: 'Find devices',
    description: 'Find devices by name, network address (DevEUI, IMEI...) or serial number, across all facilities ' +
      'the user can see or within one.',
    inputSchema: {
      query: z.string().min(1),
      facility_id: z.number().int().positive().optional(),
    },
    annotations: readOnly,
  }, (a) => run(() => findDevices(gear, a.query, a.facility_id)));

  if (write.allowClaim) {
    server.registerTool('claim_device', {
      title: 'Claim a device into a facility',
      description: 'Claims a device from its manufacturer\'s inventory into a facility, with its serial number and claim code. ' +
        'Outcome: Claimed (with device_id), Rejected (no reason given) or Blocked (too many rejections; wait blocked_minutes). ' +
        'Needs the Devices.Create permission and the right to create devices in that facility. Confirm with the user first.',
      inputSchema: {
        facility_id: z.number().int().positive(),
        serial_number: z.string().min(1).max(100),
        claim_code: z.string().min(1).max(100),
        address: z.string().max(100).optional().describe('Network address (DevEUI, IMEI...); default: the serial number'),
        description: z.string().max(200).optional().describe('Name of the device in Gear'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, (a) => run(() => claimDevice(gear, a.facility_id, a.serial_number, a.claim_code, a.address, a.description)));
  }

  if (write.allowCommands) {
    server.registerTool('send_command', {
      title: 'Send a command to an endpoint',
      description: 'Switches real equipment: on, off or toggle an endpoint, or a custom command of its device model. ' +
        'Always confirm with the user first, naming the device, endpoint and action. Radio devices may apply it at their next uplink. ' +
        'Needs the Devices.Operate permission on that endpoint.',
      inputSchema: {
        device_id: z.number().int().positive(),
        endpoint_id: z.number().int().positive(),
        action: z.enum(['on', 'off', 'toggle', 'custom']),
        command_id: z.number().int().positive().optional().describe('Only for action custom'),
        command_data: z.string().max(1000).optional().describe('Only for action custom'),
        password: z.string().optional().describe('Only for endpoints that ask the user to retype the password'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, (a) => run(() => sendCommand(gear, a.device_id, a.endpoint_id, a.action, a.command_id, a.command_data, a.password)));
  }

  return server;
}
