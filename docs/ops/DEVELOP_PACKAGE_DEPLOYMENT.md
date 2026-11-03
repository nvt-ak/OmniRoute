---
title: "Develop Package Deployment"
version: 3.8.53
lastUpdated: 2026-11-03
---

# Develop package deployment

`develop-package-deploy.yml` builds the npm package after every push to `develop`, transfers the
exact tarball to one Ubuntu server, installs or updates it for the deployment user, and restarts the
CLI daemon. The workflow never publishes to npm, creates a GitHub Release, or uses Docker.

## GitHub configuration

Configure these at repository level in **Settings → Secrets and variables → Actions**:

| Kind     | Name                  | Required value                                               |
| -------- | --------------------- | ------------------------------------------------------------ |
| Variable | `VPS_HOST`            | DNS name or IP address reachable from a GitHub-hosted runner |
| Variable | `VPS_USER`            | Dedicated non-root deployment user                           |
| Variable | `VPS_PORT`            | SSH port; omit it to use `22`                                |
| Secret   | `VPS_SSH_KEY`         | Private SSH key for `VPS_USER`                               |
| Secret   | `VPS_SSH_KNOWN_HOSTS` | Trusted OpenSSH `known_hosts` line for the server            |

`VPS_SSH_KNOWN_HOSTS` is mandatory. The workflow uses `StrictHostKeyChecking=yes`; it does not
learn a key with `ssh-keyscan` during deployment. Obtain the key through a trusted channel,
verify its fingerprint with the server operator, and store the complete line. For a non-default
SSH port, the host field normally has the form `[host]:port`.

## Server prerequisites

The deployment user must have all of the following available in a non-interactive SSH session:

- Node.js 24 with `npm`, plus `curl`, `tar`, and Bash. No existing OmniRoute installation is required.
- A user-owned npm global prefix. `npm install -g` must succeed without `sudo`.
- Write access to `~/.omniroute/`, including the deployment storage described below.
- Enough free disk space for five release tarballs plus one last-known-good copy.
- Port `20128` available to OmniRoute. The workflow starts
  `omniroute serve --daemon --port 20128` bound to `127.0.0.1` (loopback only — see
  [Network exposure and persistent bind](#network-exposure-and-persistent-bind)) and checks
  `http://127.0.0.1:20128/api/monitoring/health`.

Install Node.js 24 with npm system-wide through an operator-approved Ubuntu package source
before deployment. The prerequisite check reports every missing command and rejects other Node
major versions. It does not install operating-system packages. Do not install the public npm
package `omniroute` first: that is the upstream package, not this fork. The workflow installs
this fork's built tarball directly.

Running as root works with a writable global npm prefix, but deviates from the recommended
dedicated non-root user. The workflow resolves `npm prefix -g`, adds its `bin` directory to PATH,
and uses that exact OmniRoute executable after installation. It creates missing data/release
directories. Node and npm themselves must already be on the non-interactive SSH PATH.

The GitHub-hosted build mirrors the existing fork artifact build: Node 24, Webpack,
`NODE_OPTIONS=--max-old-space-size=8192`, docs skipped, and the MITM native component stubbed.
This repository has previously exhausted memory on GitHub-hosted runners. A build that dies from
runner memory pressure does not reach the deploy job; rerun it or move this workflow to the
existing `omni-build` runner pool in a separate, reviewed change.

## What `serve --daemon` does

The implementation is in `bin/cli/commands/serve.mjs` and `bin/cli/utils/pid.mjs`:

- It launches the packaged server with Node using `detached: true`, disconnects it with
  `unref()`, and sets stdin/stdout/stderr to `ignore`.
- It writes the child PID to `${DATA_DIR}/server/.pid`. With no `DATA_DIR`, Linux uses the
  existing `~/.omniroute/` directory, so the usual path is `~/.omniroute/server/.pid`.
- Because daemon stdout/stderr are discarded, startup console output is not a durable log.
  Application file logging is enabled by default at
  `${DATA_DIR}/logs/application/app.log` unless `APP_LOG_TO_FILE=false`; the location can be
  overridden with `APP_LOG_FILE_PATH`.
- `omniroute stop --port 20128` first stops the PID recorded in the data directory. If that PID
  is missing or stale, it falls back to stopping the process listening on the supplied port.
- `omniroute restart --port 20128` is the matching CLI shortcut: stop, wait, then start detached.
  The workflow performs those phases separately because the package must be installed between
  stop and start. It deliberately does not invoke CLI stop: that command can kill a foreign
  listener through its port fallback. Instead it checks the recorded daemon PID's Linux `/proc`
  working directory against this global package's `dist` or `app` directory and verifies its
  Node executable before sending SIGTERM. A live supervisor, unrecognized PID, shutdown timeout,
  or occupied port aborts installation without killing other services. Missing/stale PID files
  are safe when the port is free. A daemon without a valid PID file needs manual recovery.
- `omniroute status` reports package, data-directory, database, and tool information; it is not
  a daemon liveness check. The deployment therefore gates success on the HTTP health endpoint.

The CLI resolves the serve port from `--port`, then `PORT`, then `20128`. The workflow passes the
port explicitly so a remote shell environment cannot change it accidentally.

## Deployment and rollback files

The workflow stores packages below `~/.omniroute/deploy/`:

```text
incoming/omniroute-<full-commit-sha>.tgz
releases/omniroute-<full-commit-sha>.tgz
last-known-good.tgz
```

Before installation, the remote script verifies that `package/dist/BUILD_SHA` inside the
tarball matches the pushed commit. It then stops the old daemon, installs the tarball, starts a
new daemon, and polls for a healthy response. The 36 attempts are five seconds apart; a slow or
hung HTTP request can make the total health budget approach six minutes.

After a successful health check, the tarball becomes `last-known-good.tgz`, and only the five
newest commit-addressed release files are retained. If the new package fails to install, start,
or become healthy, the workflow reinstalls `last-known-good.tgz`, restarts the daemon, verifies
health again, and still marks the GitHub deployment as failed so the regression remains visible.

The first automated deployment has no last-known-good tarball yet. If that first deployment
fails, the workflow explicitly reports that rollback is unavailable; it does not claim to restore
a previous package. An operator must diagnose/retry the first install (or restore an existing
package manually). After one successful run, later runs have the
automatic rollback path.

## Operational checks

On the server, the deployment user can inspect the daemon without exposing secrets:

```bash
cat "${DATA_DIR:-$HOME/.omniroute}/server/.pid"
curl -fsS http://127.0.0.1:20128/api/monitoring/health
# Verify the daemon binds loopback only (should show 127.0.0.1:20128, NOT 0.0.0.0:20128):
ss -ltnp | grep 20128
tail -n 80 "${DATA_DIR:-$HOME/.omniroute}/logs/application/app.log"
omniroute --version
```

If `DATA_DIR` is configured, the same value must be present in non-interactive SSH sessions.
Otherwise deployment can look in a different PID directory from the daemon that is already
running. Keep the server's OmniRoute environment in `~/.omniroute/.env`, which the CLI loads on
startup, and export `DATA_DIR` through the deployment user's SSH environment when it points
somewhere else.

## Network exposure and persistent bind

The workflow exports `OMNIROUTE_SERVER_HOST="127.0.0.1"` before starting the daemon, so the
Next.js standalone server binds to the loopback interface only. Port 20128 is not reachable from
outside the server.

The workflow also writes or replaces `OMNIROUTE_SERVER_HOST=127.0.0.1` in
`${DATA_DIR:-$HOME/.omniroute}/.env` before starting the daemon. This ensures the loopback bind
survives restarts done outside the workflow (`omniroute restart`, `omniroute serve --daemon`,
autostart, or systemd), because the CLI loads that file on every boot and the key is read before
`resolveServerHost()` falls back to `0.0.0.0`.

The `.env` write is idempotent: it replaces the key when already present (including
`OMNIROUTE_SERVER_HOST=0.0.0.0`) and appends it when absent, without touching other keys or the
file mode of an existing file. Only if the file does not exist is it created with mode 600.

To override (for example, to bind a specific private interface), set `OMNIROUTE_SERVER_HOST` in
the deployment user's non-interactive SSH environment before the next deploy; the workflow
default `${OMNIROUTE_SERVER_HOST:-127.0.0.1}` yields to an existing process-env value, and the
`.env` write uses that resolved value.

> **Already-running daemon**: A daemon started before this change was deployed still binds its
> original address. The loopback restriction and persistent `.env` entry take effect only after
> the next successful deploy (which restarts the daemon). A firewall rule
> (`iptables -A INPUT ! -i lo -p tcp --dport 20128 -j DROP` or `ufw deny 20128`) provides
> defense in depth in the interim and is the operator's responsibility.

## Dashboard access

Because the daemon binds loopback, the dashboard and API are not directly reachable from a
browser on another machine. Use an SSH tunnel to forward the port:

```bash
ssh -N -L 20128:127.0.0.1:20128 <VPS_USER>@<VPS_HOST>
```

Then open `http://localhost:20128` in a local browser. The tunnel must remain open while you use
the dashboard. Alternatively, the operator can configure a TLS-terminated reverse proxy
(for example nginx or Caddy) that listens on a public port with authentication and forwards to
`127.0.0.1:20128`.

When using nginx with `proxy_pass http://localhost:20128`, note that `localhost` may resolve to
`::1` (IPv6 loopback) before `127.0.0.1` on some Linux systems. Since the daemon binds only
`127.0.0.1` (IPv4), nginx will fail on the `::1` attempt and, if configured with `resolver` or
multiple upstream addresses, try the next address. To avoid the extra round-trip or a connect
error, use `proxy_pass http://127.0.0.1:20128` explicitly.
