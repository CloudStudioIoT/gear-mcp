# Security

Report vulnerabilities to Cloud Studio IoT as described in
https://cloudstudioiot.com/.well-known/security.txt. Please do not open a public issue for them.

## Write tools

The server only reads unless `GEAR_MCP_ALLOW_CLAIM=1` or `GEAR_MCP_ALLOW_COMMANDS=1` is set; without them the write
tools are not registered. When they are on, the server does not add any check of its own: it passes the user's
access token to Gear, and Gear decides with that user's permissions, exactly as in the Gear web app. To limit what an
assistant can do, limit the user and the application behind the token (for example, an application without
Devices.Operate cannot send commands even with `GEAR_MCP_ALLOW_COMMANDS=1`).

`send_command` switches real equipment. Switch it on only for users who are allowed to operate those devices, and in
clients that ask before running a destructive tool.
