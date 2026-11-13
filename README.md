# Gear MCP server

An [MCP](https://modelcontextprotocol.io) server for the [Cloud Studio](https://cloudstudioiot.com) Gear IoT
platform. It lets Claude, ChatGPT, Cursor, VS Code or any other MCP client read a Gear account: sites,
devices and their status, live values, history and alarms. Ask *"which freezers in the Madrid warehouse
have been offline since yesterday?"* and the assistant finds out on its own.

By default it only reads: no tool claims devices, sends commands or changes configuration. Two optional write
tools exist, each off until you switch it on (see [Write tools](#write-tools-off-by-default)). Every call to Gear
carries the user's own access token, so the assistant sees and does exactly what that user can in Gear and nothing
else.

## Tools

| Tool | What it answers |
|------|-----------------|
| `list_facilities` | Which sites do I have? |
| `list_devices` | Which devices are in this site, and which are offline, silent or alarmed? (`only_problems`) |
| `get_device` | What is this device reading right now? Values with units, battery, open alarms, time of last data. |
| `get_endpoint_history` | How did this temperature change between two dates? Points plus min, max and average, up to 5,000. |
| `list_alarms` | Open, closed or all alarms of a client, site, device or endpoint. |
| `find_devices` | Where is the device called "freezer 3", with address 70B3D57E… or serial SN-0042? |

All six are marked read-only (`readOnlyHint`) for clients that ask before running a tool.

### Write tools (off by default)

| Tool | Switched on by | What it does |
|------|----------------|--------------|
| `claim_device` | `GEAR_MCP_ALLOW_CLAIM=1` | Claims a device from its manufacturer's inventory into a site, with its serial number and claim code. |
| `send_command` | `GEAR_MCP_ALLOW_COMMANDS=1` | Turns an endpoint on, off or toggles it, or sends a custom command of its device model. **It switches real equipment.** |

Without the variable the tool is not registered at all: it does not appear in the tool list. Only the value `1`
switches one on. Both are marked as not read-only, and `send_command` as destructive, so clients that ask before
running a tool will ask; the server also tells the assistant to confirm with the user first.

Gear decides whether each call is allowed, with the user's token: `claim_device` needs the Devices.Create API
permission, the right to create devices in that site and the Core.DeviceClaiming add-on on the instance;
`send_command` needs Devices.Operate and the right to operate that endpoint. A claim answers `Claimed` (with the new
`device_id`), `Rejected` (Gear does not say why) or `Blocked`: five rejected claims in fifteen minutes block the
account for an hour. Many radio devices apply a command at their next uplink, so `success` means *accepted*.

## What you need

- Node.js 20 or newer.
- The URL of your Gear instance, for example `https://gear.cloud.studio` or your own domain.
- A Gear **access token** for the user the assistant will act as. Ask your Gear administrator for:
  - an application with these API permissions: Accounts.Login, Accounts.Read, Facilities.Read,
    Facilities.ReadAlarms, Devices.Read and Endpoints.Read (Manager → Global → Applications);
  - a user limited to the client the assistant should see. Every answer is filtered by this user's
    permissions, so a user who sees one client gives an assistant that sees one client.

  With both, get a token with `AdminService.LoginWithExpiration` or a
  [persistent access token](https://cloudstudioiot.com/docs/apis-de-extraccion-de-datos/access-tokens-persistentes).
  The [Gear API skill](https://github.com/CloudStudioIoT/gear-api-skill/blob/main/references/auth.md)
  explains the login in detail.

Instead of a token you can give the server `GEAR_APP_TOKEN`, `GEAR_EMAIL` and `GEAR_PASSWORD`: it logs in at
start with a token that lasts 12 hours. This does not work for users with two-factor authentication.

## Install

The package runs with `npx`; there is nothing to install by hand.

### Claude Code

```bash
claude mcp add gear \
  --env GEAR_URL=https://gear.example.com \
  --env GEAR_TOKEN=<access token> \
  -- npx -y @cloudstudioiot/gear-mcp
```

### Claude Desktop

Settings → Developer → Edit Config, and add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gear": {
      "command": "npx",
      "args": ["-y", "@cloudstudioiot/gear-mcp"],
      "env": {
        "GEAR_URL": "https://gear.example.com",
        "GEAR_TOKEN": "<access token>"
      }
    }
  }
}
```

Restart Claude Desktop. The six tools appear under the tools icon.

### Cursor

The same `mcpServers` block as Claude Desktop, in `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json`
(one project).

### VS Code

In `.vscode/mcp.json`. VS Code asks for the token once and keeps it out of the file:

```json
{
  "inputs": [
    { "type": "promptString", "id": "gear-token", "description": "Gear access token", "password": true }
  ],
  "servers": {
    "gear": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cloudstudioiot/gear-mcp"],
      "env": { "GEAR_URL": "https://gear.example.com", "GEAR_TOKEN": "${input:gear-token}" }
    }
  }
}
```

### Other clients

Any client that starts a local MCP server over stdio works: the command is
`npx -y @cloudstudioiot/gear-mcp` with `GEAR_URL` and `GEAR_TOKEN` in its environment.

## Running it as a remote server

The server also speaks Streamable HTTP, for a team that wants one shared server instead of one per laptop:

```bash
GEAR_URL=https://gear.example.com npx -y @cloudstudioiot/gear-mcp --http --port 3333 --host 127.0.0.1
```

- Endpoint `POST /mcp`; health check `GET /health`.
- Each request must carry the user's Gear token: `Authorization: Bearer <access token>`. Without it the
  answer is 401. The server is stateless: it keeps no sessions and no tokens, and each request runs with its
  own token, so two users on the same server never see each other's data.
- It listens on `127.0.0.1` by default. To expose it, put it behind HTTPS (a reverse proxy). Tokens must never
  travel in clear text.

Cloud Studio does not host a public instance of this server.

## Good to know

- Times are UTC. Dates are accepted as `2026-10-01` or `2026-10-01T08:00:00Z`.
- `last_data_utc` is the newest reading of any of the device's endpoints, or `null` if it never sent data.
- A battery's `percentage` is `null` when Gear has a voltage but no percentage for it; read `voltage` then.
  The server does not estimate one from the other.
- Gear returns at most 500 rows per API call. `get_endpoint_history` pages for you up to 5,000 points and sets
  `truncated` when there is more. `list_devices` counts up to 500 open alarms per site (`open_alarms_capped`),
  and `find_devices` searches up to 200 sites.
- Gear's errors come back as tool errors with Gear's code, for example
  `Gear 8001: The access token is invalid or has expired`, or `Gear 8004` when the user has no access to what
  was asked.

## Develop

```bash
git clone https://github.com/CloudStudioIoT/gear-mcp
cd gear-mcp
npm install
npm test          # 34 tests against recorded response shapes, no network
npm run build
GEAR_URL=... GEAR_TOKEN=... node dist/src/index.js
```

`npm run test:isolation` checks, against a real instance, that two users of different clients each see only
their own data in all six tools, also when one passes the other's IDs by hand. It needs `GEAR_URL`,
`GEAR_TOKEN_A` and `GEAR_TOKEN_B`, and only reads. With `GEAR_MCP_ALLOW_CLAIM=1` and `GEAR_MCP_ALLOW_COMMANDS=1` it
also checks that neither user can claim into, or send a command to, the other's site or device. Those calls only use
the other user's IDs with made-up serials and command IDs, and must stop at Gear's permission check: run them against
a development instance.

To build your own integration on the Gear API rather than through an assistant, see the
[Gear API skill](https://github.com/CloudStudioIoT/gear-api-skill) and the
[API documentation](https://cloudstudioiot.com/docs/apis-de-extraccion-de-datos).

## Security

Report vulnerabilities as described in https://cloudstudioiot.com/.well-known/security.txt.

## License

MIT © Cloud Studio IoT, S.L.
