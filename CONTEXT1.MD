# LEMP Deploy Engine — Full Project Specification

> Living document — last updated: 2026-04-13  
> Repo: https://github.com/RobinMorajker/LempInstallerAdvanced

---

## 1. Project Overview

A self-hosted, one-click deploy engine for LEMP (Linux · Nginx · MariaDB · PHP) applications. Built with Node.js/Express, it runs on any machine and can deploy apps both **locally** (via Docker on the same host) and **remotely** (via SSH to any registered machine — e.g. a Raspberry Pi 5).

The app is accessed at `https://3000.connecthomenow.com/` (deploy engine on Windows dev machine, tunnelled). The primary remote target is a Raspberry Pi 5 at `192.168.0.252`.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (Express 4) |
| Local containers | Dockerode (Docker SDK) |
| Remote deploy | SSH2 v1.17.0 |
| Database | MariaDB 10.11 (via Docker) |
| PHP | Custom PHP-FPM image (Docker) |
| Proxy / SSL | Nginx Proxy Manager (NPM) |
| Web server | Nginx (Alpine) |
| Cache | Redis 7 |
| DB GUI | phpMyAdmin (port 8082) |
| Auth | GitHub OAuth 2.0 |
| Sessions | SQLite (connect-sqlite3), 8h TTL |
| HTTP client | Axios |
| Dev server | Nodemon |

---

## 3. File & Directory Structure

```
LempInstallerAdvanced/
├── src/
│   ├── server.js               # Express app + all API routes
│   ├── config.js               # Centralised env/config
│   ├── deployService.js        # Local deploy pipeline (Docker)
│   ├── remoteDeployService.js  # Remote deploy pipeline (SSH)
│   ├── deployStore.js          # In-memory deployment status Map
│   ├── machineService.js       # Machine registry (.machines.json)
│   ├── dockerService.js        # Dockerode helpers
│   ├── authService.js          # GitHub OAuth helpers + repo listing
│   └── routes/
│       └── auth.js             # /auth/github, /api/me, /api/repos
├── public/
│   └── index.html              # Single-page UI (vanilla JS + CSS)
├── php/
│   ├── Dockerfile              # Custom PHP-FPM image
│   └── php.ini
├── nginx/
│   └── default.conf            # Default vhost config
├── www/                        # Default nginx document root
├── docker-compose.yml          # Full LEMP stack definition
├── Dockerfile.deploy           # Deploy engine container image
├── package.json
├── .env                        # Secrets (gitignored)
├── .machines.json              # Registered machines (gitignored)
├── .gitignore
└── .claude/
    └── launch.json             # Dev server configurations
```

---

## 4. Environment Variables (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_CLIENT_ID` | — | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | — | GitHub OAuth app secret |
| `GITHUB_CALLBACK_URL` | `http://localhost:3000/auth/github/callback` | OAuth redirect URL |
| `SESSION_SECRET` | `change-me-in-production` | Express session signing key |
| `PORT` | `3000` | Deploy engine listen port |
| `APPS_DIR` | `<project>/apps` | Host path for cloned app repos (Linux paths ignored on Windows) |
| `DOCKER_NETWORK` | `lemp_default` | Docker network shared by all containers |
| `PHP_IMAGE` | `lemp-php-custom` | PHP-FPM image name |
| `DB_HOST` | `lemp_db` | MariaDB hostname |
| `DB_ROOT_PASSWORD` | `rootpassword` | MariaDB root password |
| `DB_APP_PASSWORD` | `apppassword` | Per-app DB user password |
| `NPM_URL` | `http://localhost:81/api` | NPM API base URL (local deploy) |
| `NPM_EMAIL` | `admin@example.com` | NPM admin email (local deploy) |
| `NPM_PASSWORD` | `changeme` | NPM admin password (local deploy) |
| `CONTAINER_MEMORY` | `536870912` (512 MB) | Per-app container memory limit |
| `CONTAINER_NANOCPUS` | `500000000` (0.5 CPU) | Per-app container CPU limit |

---

## 5. Docker Compose Services

All services share network `lemp_net`.

| Container | Image | Ports | Purpose |
|---|---|---|---|
| `lemp_nginx` | `nginx:alpine` | `8080:80` | Default nginx vhost (static files) |
| `lemp_php` | `lemp-php-custom` (built) | — | PHP-FPM for default vhost |
| `lemp_db` | `mariadb:10.11` | `3306:3306` | MariaDB database server |
| `lemp_redis` | `redis:7-alpine` | — | Redis cache / session store |
| `lemp_npm` | `jc21/nginx-proxy-manager` | `80:80`, `81:81`, `443:443` | Proxy + SSL GUI |
| `lemp_phpmyadmin` | `phpmyadmin:latest` | `8082:80` | MariaDB web GUI |
| `lemp_deploy` | Built from `Dockerfile.deploy` | `3000:3000` | Deploy Engine API |

**MariaDB healthcheck:** `healthcheck.sh --connect --innodb_initialized` (interval 10s, retries 5)  
**phpMyAdmin** depends on `db` service being healthy before starting.

---

## 6. API Routes

All routes except `/health`, `/auth/*`, and `/api/me` require an authenticated session (`requireAuth` middleware — checks `req.session.accessToken`).

### Authentication
| Method | Path | Description |
|---|---|---|
| `GET` | `/auth/github` | Redirect to GitHub OAuth consent |
| `GET` | `/auth/github/callback` | OAuth callback — stores token + user in session |
| `GET` | `/auth/logout` | Destroy session, redirect to `/` |
| `GET` | `/api/me` | Current user or `null` (never 401) |
| `GET` | `/api/repos` | List authenticated user's GitHub repos |

### Deployments
| Method | Path | Description |
|---|---|---|
| `POST` | `/deploy` | Start a new deployment (local or remote) |
| `GET` | `/deploy/:deployId` | Poll deployment status |
| `GET` | `/deployments` | List all tracked deployments |
| `DELETE` | `/deploy/:appName?domain=&machineId=` | Destroy app (containers + DB + proxy) |

**POST /deploy body:**
```json
{
  "repo":      "https://github.com/user/repo.git",
  "domain":    "myapp.example.com",
  "appName":   "myapp",
  "branch":    "main",
  "ssl":       true,
  "email":     "user@example.com",
  "webRoot":   "public",
  "machineId": "<uuid>"
}
```
- `appName` auto-generated from repo name if omitted (lowercase, stripped of non-alphanumeric)
- `machineId` omitted → local deploy; present → remote deploy via SSH
- Returns `202` with `{ deployId, appName, domain, status: "pending", ... }`

### Machines
| Method | Path | Description |
|---|---|---|
| `GET` | `/machines` | List machines (secrets stripped) |
| `POST` | `/machines` | Register a new machine |
| `PATCH` | `/machines/:id` | Update mutable fields (passphrase, passwords, port, etc.) |
| `DELETE` | `/machines/:id` | Remove machine |
| `POST` | `/machines/:id/bootstrap` | Fire-and-forget bootstrap stack install |
| `GET` | `/machines/:id/bootstrap-status` | Poll bootstrap log + status |
| `POST` | `/machines/:id/test` | Test SSH connectivity |

**PATCH /machines/:id** — whitelisted fields only:
`passphrase`, `name`, `user`, `port`, `appsDir`, `dockerNetwork`, `phpImage`, `dbRootPassword`, `dbAppPassword`, `npmEmail`, `npmPassword`  
Passing empty string for `passphrase` clears it.

### Containers & Health
| Method | Path | Description |
|---|---|---|
| `GET` | `/containers` | List all `deploy-engine=true` containers |
| `GET` | `/containers/:name` | Inspect single container |
| `GET` | `/health` | Liveness probe — returns `{ status, uptime }` |

---

## 7. Machine Registry (`machineService.js`)

Machines are persisted to `.machines.json` (gitignored). Each machine record:

```json
{
  "id":              "<uuid>",
  "name":            "RP5",
  "host":            "192.168.0.252",
  "port":            22,
  "user":            "robinmorajker",
  "privateKey":      "-----BEGIN OPENSSH PRIVATE KEY-----...",
  "passphrase":      "optional — for encrypted keys",
  "appsDir":         "/home/robinmorajker/apps",
  "dockerNetwork":   "lemp_net",
  "phpImage":        "lemp-php-custom",
  "dbRootPassword":  "changeme_root",
  "dbAppPassword":   "changeme_app",
  "npmEmail":        "admin@example.com",
  "npmPassword":     "changeme_npm",
  "createdAt":       "2026-04-13T00:00:00.000Z"
}
```

`listMachines()` strips `privateKey`, `passphrase`, `dbRootPassword`, `dbAppPassword`, `npmPassword` and adds `hasKey: boolean`.

**Default `appsDir`:** `/home/<user>/apps` (not `/var/www/apps` — avoids permission denied on Pi).

---

## 8. Deployment Store (`deployStore.js`)

In-memory `Map` — **cleared on server restart** (by design; no persistence needed for in-flight status).

```js
setStatus(deployId, patch)     // upsert
getStatus(deployId)            // single record
listDeployments()              // all, sorted newest-first
removeByApp(appName, domain)   // called after successful destroy
```

Each record shape:
```json
{
  "deployId":    "<uuid>",
  "status":      "pending|cloning|provisioning_db|starting_containers|configuring_proxy|live|failed",
  "appName":     "myapp",
  "domain":      "192.168.0.252",
  "repo":        "https://github.com/...",
  "machineId":   "<uuid>",
  "machineHost": "192.168.0.252",
  "machineName": "RP5",
  "updatedAt":   "2026-04-13T14:54:59.334Z",
  "error":       "optional error message"
}
```

---

## 9. Local Deploy Pipeline (`deployService.js`)

Runs on the machine hosting the deploy engine (requires Docker socket access).

1. **Clone / pull** repo into `<appsDir>/<appName>/`
2. **Provision DB** — `CREATE DATABASE` + `CREATE USER` via `mysql2` into `lemp_db`
3. **Create PHP-FPM container** (`createContainer`) — mounts app dir, connected to `lemp_net`
4. **Create Nginx sidecar** (`createNginxSidecar`) — serves static + proxies PHP; `webRoot` sets document root subdirectory
5. **Configure NPM proxy** — `POST /api/nginx/proxy-hosts` pointing to `nginx_<appName>:80`

**Destroy** reverses: removes NPM proxy host → removes containers → drops DB + user.

---

## 10. Remote Deploy Pipeline (`remoteDeployService.js`)

All remote operations use a single SSH connection per deploy run via the `withSSH(machine, fn)` helper (ssh2 v1.17.0).

### `withSSH(machine, fn)`
- Connects using `privateKey` + optional `passphrase`
- Provides `exec(cmd)` (throws on non-zero exit) and `execSafe(cmd)` (always resolves)
- Single connection reused for all steps; auto-closes on finish or error

### Deploy Pipeline (10 steps)

| Step | Action |
|---|---|
| 0 | **Preflight** — verify `lemp_db` container is running (`docker inspect`) |
| 1 | **Clone / pull** — `git clone --depth 1` or `git pull origin <branch>` |
| 2 | **Provision DB** — `docker exec lemp_db mysql` to create DB + user |
| 3 | **Write .env** — base64-encode, pipe through `printf '%s' | base64 -d` to avoid shell quoting issues |
| 4 | **Build PHP image** if not present |
| 5 | **Create PHP-FPM container** via `docker run` |
| 6 | **Create Nginx sidecar** via `docker run` with inline base64-encoded nginx config |
| 7 | **Configure NPM proxy** — HTTP call to `http://<host>:81/api` |
| — | Status updates written to `deployStore` at each step |

### `_getNpmToken(machine)` — 3-path self-healing auth

Retries up to 12× with 5s gaps. Each attempt tries all three paths:

1. **Machine credentials** — `POST /api/tokens` with `npmEmail` + `npmPassword`
2. **Default NPM credentials** (`admin@example.com` / `changeme`) — if successful, seeds machine credentials:
   - `PUT /users/{id}` — update email
   - `PUT /users/{id}/auth` — update password (`current: "changeme"`)
   - Re-login with new credentials
3. **First-run (no users yet)** — `POST /api/users` to create admin account (open endpoint on fresh NPM), then login

This handles: fresh NPM with no users, NPM with default creds, NPM already seeded.

### Bootstrap Stack (`bootstrapStack(machine)`)

Fire-and-forget async function. Progress stored in `_bootstrapStatus` Map, polled via `GET /machines/:id/bootstrap-status`.

| Step | Action |
|---|---|
| 1 | Check if already running (`docker inspect lemp_db`) |
| 1b | If stack up but `lemp_phpmyadmin` missing → `git pull` + `docker compose pull phpmyadmin` + `docker compose up -d phpmyadmin` |
| 2 | Verify Docker installed |
| 3 | Clone or pull `LempInstallerAdvanced` repo to `$HOME/LempInstallerAdvanced` |
| 4 | Write `.env` via base64 with machine credentials |
| 5 | Build PHP image if missing |
| 6 | `docker compose pull --ignore-buildable` (pulls nginx, mariadb, redis, npm, phpmyadmin) |
| 7 | `docker compose up -d --remove-orphans` |
| 8 | Wait MariaDB healthy (30× 5s = 150s max) |
| 9 | Wait NPM API HTTP 200 on `:81/api/schema` (12× 5s = 60s max) |
| 10 | Wait phpMyAdmin HTTP 200/302 on `:8082` (12× 5s = 60s max) |

---

## 11. Docker Service (`dockerService.js`)

Wraps Dockerode. Docker socket path: `//./pipe/docker_engine` (Windows) or `/var/run/docker.sock` (Linux).

| Function | Description |
|---|---|
| `createContainer(opts)` | Create + start PHP-FPM container with resource limits |
| `createNginxSidecar(appName, hostPath, webRoot)` | Nginx sidecar — base64-encodes nginx config, runs as startup command |
| `removeContainer(name)` | Stop + remove container; ignores 404 |
| `removeAppContainers(appName)` | Remove `nginx_<appName>` + `<appName>` |
| `listAppContainers()` | All containers with label `deploy-engine=true` |
| `inspectContainer(name)` | Full inspect data |
| `pullImageIfMissing(imageName)` | Pull if not present locally |
| `ensureNetwork()` | Create `lemp_net` Docker network if missing |

Per-app container labels: `deploy-engine=true`, `deploy-engine.app=<name>`  
Nginx sidecar label: `deploy-engine.role=nginx`

---

## 12. Authentication (`authService.js` + `routes/auth.js`)

GitHub OAuth 2.0 flow:
1. `GET /auth/github` → redirect to `https://github.com/login/oauth/authorize?...` with random `state` stored in session
2. GitHub → `GET /auth/github/callback?code=&state=` → CSRF check → exchange code for token → store token + user in session
3. `GET /api/repos` → calls GitHub API `GET /user/repos?per_page=100&sort=updated` using session token
4. `GET /auth/logout` → `session.destroy()` + redirect

Sessions backed by SQLite via `connect-sqlite3`. DB file at `.sessions/sessions.db`. TTL: 8 hours.

---

## 13. Frontend UI (`public/index.html`)

Single-file SPA — vanilla JS, no framework. Dark GitHub-style theme (`#0d1117` background).

### Layout
Two-column CSS grid: `360px` left column (deploy form), `1fr` right column (cards).

### Header
- Logo + animated green dot (pulsing)
- GitHub login button (SVG icon) or user pill (avatar + name + logout)

### Cards

#### `+ New Deployment`
- **Repo Picker** — search input + scrollable list of GitHub repos (loaded from `/api/repos`)
  - Click a repo → auto-fills URL, branch, appName; shows **selected repo chip** (📦 icon + repo name + × clear button); hides manual URL field
  - Implemented with `data-fullname`, `data-clone`, `data-branch` attributes + event delegation (avoids HTML attribute quoting bugs with JSON.stringify)
  - `selectRepo(el, fullName, cloneUrl, defaultBranch)` — fills fields, shows chip, highlights row
  - `clearSelectedRepo()` — clears fields, hides chip, shows URL input
- **Deploy form fields:** GitHub Repo URL, Domain, App Name, Branch, Web Root, Let's Encrypt Email, SSL toggle, Deploy Target dropdown
- **Deploy Target dropdown** — `💻 Local (this machine)` + one entry per registered machine (`💻 <name> (<host>)`)
  - Built with `new Option(text, value)` — emoji must be literal, not HTML entity

#### `🚀 Deployments`
- Table: App | Domain | Target | Status (badge) | Updated
- Status badge colours: `live`=green, `failed`=red, `pending/cloning/...`=yellow/blue
- **Destroy button** per row — calls `DELETE /deploy/:appName?domain=&machineId=`; removes from list on success
- Polls every 10 seconds

#### `💻 Machines`
- Table: Name | Host:Port | Key indicator | Action buttons
- **Add Machine** toggle → inline form with all fields including passphrase and advanced settings
- Per row: **Save** (passphrase), **Test** (SSH connectivity), **Stack** (bootstrap), **Remove**
- Passphrase: inline save via `PATCH /machines/:id`
- Bootstrap: calls `POST /machines/:id/bootstrap` then polls `GET /machines/:id/bootstrap-status` every 2s

#### `⚙ Stack Bootstrap`
- Hidden by default (`display:none`), shown when bootstrap starts
- Live scrolling log output from bootstrap status polling
- **Dismiss** button hides panel

#### `🔗 Quick Access`
- 2-column grid of link cards, built dynamically by `buildQuickLinks()`
- Links use `window.location.hostname` for first three, `window.location.origin` for Deploy Engine API

| Card | URL | Description |
|---|---|---|
| 🗄️ phpMyAdmin | `http://<hostname>:8082` | MariaDB GUI |
| 🔀 NPM Admin | `http://<hostname>:81` | Proxy + SSL management |
| 🌐 Default Site | `http://<hostname>:8080` | Default nginx vhost |
| ⚙️ Deploy Engine API | `<window.location.origin>/health` | REST API health check |

#### `⚙ Containers`
- Table: Name | Image | State | Ports
- Shows `Docker unavailable: <error>` in red when `/containers` returns non-200
- Polls every 10 seconds

### Key JS Functions

| Function | Purpose |
|---|---|
| `loadAuth()` | Fetch `/api/me`, render login/user pill |
| `loadMachines()` | Fetch `/machines`, render table + target dropdown |
| `loadDeployments()` | Fetch `/deployments`, render table |
| `loadContainers()` | Fetch `/containers`, render table |
| `buildQuickLinks()` | Render Quick Access card |
| `renderRepos(repos)` | Populate repo picker list with data-* attributes |
| `selectRepo(el, fullName, cloneUrl, branch)` | Fill form from repo click |
| `clearSelectedRepo()` | Reset repo selection |
| `updateTargetDropdown()` | Rebuild machine options in deploy form |
| `savePassphrase(id, name)` | PATCH machine passphrase |
| `bootstrapMachine(id, name)` | Start bootstrap + begin polling |
| `destroyApp(appName, domain, machineId)` | DELETE deploy |
| `showToast(msg, type)` | Transient notification (ok/err) |
| `esc(str)` | HTML-escape for safe innerHTML injection |
| `badge(state)` | Status badge HTML |

---

## 14. Launch Configurations (`.claude/launch.json`)

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "Dev (nodemon)", "runtimeExecutable": "npm", "runtimeArgs": ["run","dev"], "port": 3000 },
    { "name": "Start (node)",  "runtimeExecutable": "npm", "runtimeArgs": ["start"],     "port": 3000 }
  ]
}
```

`runtimeExecutable` is `npm` (not `nodemon` directly) because nodemon is a local devDependency, not globally installed.

---

## 15. Known Behaviours & Design Decisions

### SSH passphrase support
Encrypted OpenSSH private keys require a passphrase. Stored in `.machines.json` (gitignored). Passed to `ssh2.connect()` as `passphrase` option. Added via inline Save button per machine row (PATCH endpoint).

### `appsDir` default: `/home/<user>/apps`
Changed from `/var/www/apps` because the SSH user does not own `/var/www` on a standard Pi setup, causing `mkdir: cannot create directory '/var/www': Permission denied`.

### Base64 SSH command pattern
Multi-line content (SQL, `.env`, nginx configs) is passed over SSH using:
```bash
printf '%s' '<base64>' | base64 -d > /path/to/file
```
This avoids all shell quoting issues with newlines, quotes, special characters.

### NPM first-run / self-healing credentials
NPM (Nginx Proxy Manager) starts with no users on a fresh volume. `_getNpmToken` handles three states in a retry loop: already-seeded machine creds → default creds (seed machine creds) → completely fresh (create first user via open `POST /api/users`).

### In-memory deploy store
`deployStore` is an in-memory `Map`. Cleared on server restart. This is intentional — in-flight deploy status only needs to survive the deploy, not reboots.

### Deployment record cleanup
`removeByApp(appName, domain)` is called after successful destroy, removing all matching records from the Map so destroyed apps don't linger in the UI.

### HTML attribute quoting for repo selection
Inline `onclick="fn(JSON.stringify(obj))"` breaks because `JSON.stringify` produces double-quoted strings inside a double-quoted attribute. Fixed by storing data in `data-fullname`, `data-clone`, `data-branch` attributes and using event delegation (`list.onclick`).

### `new Option(text, value)` and emoji
`new Option(text, value)` treats `text` as plain text, not HTML. Emoji must be literal Unicode characters (e.g. `💻`), not HTML entities (`&#128187;`).

### Containers card on Windows dev machine
`/containers` returns 500 with `connect ENOENT //./pipe/docker_engine` when Docker Desktop is not running. The UI shows `Docker unavailable: <error>` in red instead of "No containers." This is expected on the Windows dev machine.

### webRoot for static deploys
When deploying a repo whose `index.html` is in a subdirectory (e.g. `public/`), the `webRoot` field must be set to that subdirectory. Without it, nginx serves from the repo root, which typically has no index file → 403 Forbidden.

### Bootstrap idempotency
- If `lemp_db` AND `lemp_phpmyadmin` are both running → immediate exit "nothing to do"
- If `lemp_db` is running but `lemp_phpmyadmin` is missing → only pull + start phpMyAdmin
- Otherwise → full install pipeline

---

## 16. Security Notes

- All API routes (except `/health`, `/auth/*`, `/api/me`) require `req.session.accessToken`
- Machine private keys and passwords are never returned by `GET /machines` (`_safe()` strips them)
- `privateKey` cannot be changed via PATCH (requires re-adding the machine)
- Sessions expire after 8 hours
- OAuth CSRF protection via random `state` parameter checked in callback
- `.machines.json` is gitignored

---

## 17. Port Map (Pi at 192.168.0.252)

| Port | Service |
|---|---|
| 80 | NPM — HTTP proxy for deployed apps |
| 81 | NPM Admin UI |
| 443 | NPM — HTTPS proxy |
| 3000 | Deploy Engine API |
| 3306 | MariaDB |
| 8080 | Default nginx vhost |
| 8082 | phpMyAdmin |

---

## 18. Git History (major commits)

| Commit | Description |
|---|---|
| `1e42138` | Initial commit: LEMP Deploy Engine with GitHub OAuth + one-click deploy |
| `c113040` | Fix Windows dev environment: session store, appsDir, nodemon, branch fallback |
| `d03ac10` | Add Nginx sidecar per app — fix 502 and PHP serving |
| `c32ba80` | Require authentication on all deploy/container API routes |
| `ca17564` | Add remote machine deploy support |
| `8f70abd` | Bootstrap remote LEMP stack + repo picker + passphrase support |
| `d7ef36e` | Fix NPM first-run (no users) + containers Docker unavailable UI |
| `ee2e5cd` | Remove deployment record from list after successful destroy |
| `7e5e9f6` | Add Quick Access panel + phpMyAdmin to docker-compose |
| `dc2ac75` | Auto-pull & start phpMyAdmin during bootstrap |
| `9d1de6e` | Fix Deploy Engine API quick-link uses window.location.origin |
