/**
 * Minimal Gear API client: Service API (WCF, POST with a wrapped JSON body) and REST v2 (GET, and POST for the
 * optional write tools).
 *
 * Every call carries the user's access token, so this client sees exactly what that user sees in Gear:
 * permissions are enforced by the instance, not here. Reference: https://github.com/CloudStudioIoT/gear-api-skill.
 */

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  status: number;
  ok: boolean;
  text(): Promise<string>;
}>;

export class GearError extends Error {
  constructor(public readonly faultCode: string, message: string, public readonly httpStatus: number) {
    super(`Gear ${faultCode}: ${message}`);
    this.name = 'GearError';
  }
}

/** Gear's REST v2 date format: UTC, seconds precision, no zone suffix. */
export function gearDate(date: Date): string {
  return date.toISOString().slice(0, 19);
}

/**
 * Any date Gear returns, as a Date, or null when empty:
 * "/Date(ms+0000)/" (WCF DateTime), {Date:{...},Time:{...}} (DateTimeDT), "yyyy-MM-ddTHH:mm:ss" (REST v2, UTC).
 */
export function parseGearDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const m = /\/Date\((-?\d+)/.exec(value);
    if (m) {
      const ms = Number(m[1]);
      return ms > 0 ? new Date(ms) : null; // year 1 = never set
    }
    const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : value + 'Z';
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : new Date(t);
  }
  if (typeof value === 'object') {
    const v = value as { Date?: { Year: number; Month: number; Day: number }; Time?: { Hour?: number; Minute?: number; Second?: number; Millisecond?: number } };
    if (!v.Date || !v.Date.Year) return null;
    const t = v.Time ?? {};
    return new Date(Date.UTC(v.Date.Year, v.Date.Month - 1, v.Date.Day, t.Hour ?? 0, t.Minute ?? 0, t.Second ?? 0, t.Millisecond ?? 0));
  }
  return null;
}

export class GearClient {
  readonly baseUrl: string;

  constructor(baseUrl: string, private accessToken: string, private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Logs in with LoginWithExpiration and returns a client holding the new token. */
  static async login(baseUrl: string, applicationToken: string, eMail: string, password: string, expirationSeconds: number,
    fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<GearClient> {
    const anon = new GearClient(baseUrl, '', fetchImpl);
    const r = await anon.post<{ AccessToken?: string }>('core/AdminService', 'LoginWithExpiration',
      { applicationToken, eMail, password, expiration: expirationSeconds });
    if (!r || !r.AccessToken) {
      throw new GearError('LOGIN', 'no access token returned (two-factor authentication or password change required?)', 200);
    }
    return new GearClient(baseUrl, r.AccessToken, fetchImpl);
  }

  /** Service API: POST /services/{service}.svc/{op}; returns the unwrapped {op}Result. */
  async service<T>(service: string, op: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.post<T>(service, op, { accessToken: this.accessToken, ...params });
  }

  /** REST v2: GET /api/v2/{path}. Null and undefined params are left out. */
  async rest<T>(path: string, params: Record<string, string | number | null | undefined> = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined && v !== '') qs.set(k, String(v));
    }
    const q = qs.toString();
    const res = await this.fetchImpl(`${this.baseUrl}/api/v2/${path}${q ? '?' + q : ''}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    return (await GearClient.parse(res)) as T;
  }

  /** REST v2: POST /api/v2/{path} with a JSON body. Only the write tools use it, and only when they are switched on. */
  async restPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v2/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await GearClient.parse(res)) as T;
  }

  private async post<T>(service: string, op: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/services/${service}.svc/${op}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await GearClient.parse(res)) as Record<string, unknown> | null;
    return (data && typeof data === 'object' && `${op}Result` in data ? data[`${op}Result`] : data) as T;
  }

  private static async parse(res: { status: number; ok: boolean; text(): Promise<string> }): Promise<unknown> {
    // Gear answers every error with HTTP 500 and a JSON body; anything else that is not 2xx is a wrong URL.
    if (!res.ok && res.status !== 500) {
      throw new GearError('HTTP', `${res.status} (wrong GEAR_URL or route?)`, res.status);
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new GearError('HTTP', `${res.status} non-JSON response (wrong GEAR_URL?)`, res.status);
    }
    if (data && typeof data === 'object' && ('Exception' in data || 'FaultCode' in data)) {
      const e = ((data as { Exception?: unknown }).Exception ?? data) as { FaultCode?: unknown; Message?: string };
      throw new GearError(String(e.FaultCode), e.Message ?? '', res.status);
    }
    if (!res.ok) throw new GearError('HTTP', String(res.status), res.status);
    return data;
  }
}
