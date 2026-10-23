import { readFileSync } from 'node:fs';
import { FetchLike, GearClient } from '../src/gear.js';

export const BASE = 'https://gear.test';
export const TOKEN = '11111111-2222-3333-4444-555555555555';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url);
export const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

export interface Call { method: string; url: URL; headers: Record<string, string>; body: Record<string, unknown> | null }

/** A fake fetch that answers from a route table: key "POST /services/core/X.svc/Op" or "GET /api/v2/alarms". */
export function fakeGear(routes: Record<string, (c: Call) => { status?: number; body: string }>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    const u = new URL(url);
    const c: Call = { method: init.method ?? 'GET', url: u, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(c);
    const route = routes[`${c.method} ${u.pathname}`];
    const r = route ? route(c) : { status: 404, body: '<html>The resource cannot be found.</html>' };
    const status = r.status ?? 200;
    return { status, ok: status >= 200 && status < 300, text: async () => r.body };
  };
  return { gear: new GearClient(BASE, TOKEN, fetchImpl), calls, fetchImpl };
}

export const json = (body: string) => () => ({ body });
