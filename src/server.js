const path = require("path");
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const localDeploy   = require("./deployService");
const remoteDeploy  = require("./remoteDeployService");
const { getStatus, listDeployments } = require("./deployStore");
const { listAppContainers, inspectContainer } = require("./dockerService");
const machines      = require("./machineService");
const authRouter    = require("./routes/auth");
const config        = require("./config");

const app = express();

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.accessToken) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

// SQLite-backed sessions — cross-platform, survives restarts, no Windows rename issues
app.use(session({
  store: new SQLiteStore({
    db:  "sessions.db",
    dir: path.join(__dirname, "..", ".sessions"),
    ttl: 8 * 60 * 60   // 8 hours in seconds
  }),
  secret:            config.sessionSecret,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    maxAge:   8 * 60 * 60 * 1000   // 8 hours in ms
  }
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(authRouter);

// ── Input validation helpers ──────────────────────────────────────────────────

function isValidGitUrl(url) {
  return /^(https?:\/\/|git@)\S+\.git$/.test(url);
}

function isValidDomain(domain) {
  return /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(domain);
}

function isValidAppName(name) {
  return /^[a-zA-Z0-9_-]{1,48}$/.test(name);
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /deploy
 * Start a new deployment.
 *
 * Body:
 *   repo     {string}  required  - Git HTTPS URL ending in .git
 *   domain   {string}  required  - Public domain (e.g. myapp.example.com)
 *   appName  {string}  optional  - Custom name; auto-generated if omitted
 *   ssl      {boolean} optional  - Default true
 *   email    {string}  optional  - Let's Encrypt contact email
 *   branch    {string}  optional  - Default "main"
 *   webRoot   {string}  optional  - Subdirectory used as document root (e.g. "public")
 *   machineId {string}  optional  - ID of a registered remote machine; omit for local deploy
 */
app.post("/deploy", requireAuth, async (req, res) => {
  const { repo, domain, appName, ssl, email, branch, webRoot, machineId } = req.body;

  if (!repo || !isValidGitUrl(repo)) {
    return res.status(400).json({ error: "Invalid or missing repo URL (must end in .git)" });
  }
  if (!domain || !isValidDomain(domain)) {
    return res.status(400).json({ error: "Invalid or missing domain" });
  }
  if (appName && !isValidAppName(appName)) {
    return res.status(400).json({ error: "appName must be alphanumeric/dash/underscore, max 48 chars" });
  }

  try {
    let result;
    if (machineId) {
      const machine = machines.getMachine(machineId);
      if (!machine) return res.status(404).json({ error: "Machine not found" });
      result = await remoteDeploy.deploy({ machine, machineId, repo, domain, appName, ssl, email, branch, webRoot });
    } else {
      result = await localDeploy.deploy({ repo, domain, appName, ssl, email, branch, webRoot });
    }
    res.status(202).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /deploy/:deployId
 * Poll deployment status.
 */
app.get("/deploy/:deployId", requireAuth, (req, res) => {
  const status = getStatus(req.params.deployId);
  if (!status) return res.status(404).json({ error: "Deployment not found" });
  res.json(status);
});

/**
 * GET /deployments
 * List all tracked deployments.
 */
app.get("/deployments", requireAuth, (_req, res) => {
  res.json(listDeployments());
});

/**
 * DELETE /deploy/:appName
 * Destroy an app completely (container + DB + proxy host).
 *
 * Query params:
 *   domain    {string} required
 *   machineId {string} optional — remote machine; omit for local
 */
app.delete("/deploy/:appName", requireAuth, async (req, res) => {
  const { appName } = req.params;
  const { domain, machineId } = req.query;

  if (!isValidAppName(appName)) {
    return res.status(400).json({ error: "Invalid appName" });
  }
  if (!domain || !isValidDomain(domain)) {
    return res.status(400).json({ error: "Invalid or missing domain query param" });
  }

  try {
    if (machineId) {
      const machine = machines.getMachine(machineId);
      if (!machine) return res.status(404).json({ error: "Machine not found" });
      await remoteDeploy.destroy(machine, appName, domain);
    } else {
      await localDeploy.destroy(appName, domain);
    }
    res.json({ success: true, appName, domain });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Machine registry ──────────────────────────────────────────────────────────

/**
 * GET /machines
 * List registered remote machines (secrets stripped).
 */
app.get("/machines", requireAuth, (_req, res) => {
  res.json(machines.listMachines());
});

/**
 * POST /machines
 * Register a new remote machine.
 *
 * Body: { name, host, port?, user?, privateKey, appsDir?, dockerNetwork?,
 *         phpImage?, dbRootPassword?, dbAppPassword?, npmEmail?, npmPassword? }
 */
app.post("/machines", requireAuth, (req, res) => {
  try {
    const m = machines.addMachine(req.body);
    res.status(201).json(m);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PATCH /machines/:id
 * Update mutable fields (passphrase, passwords, port, etc.).
 */
app.patch("/machines/:id", requireAuth, (req, res) => {
  try {
    const m = machines.patchMachine(req.params.id, req.body);
    res.json(m);
  } catch (err) {
    res.status(err.message === "Machine not found" ? 404 : 400).json({ error: err.message });
  }
});

/**
 * DELETE /machines/:id
 * Remove a registered machine.
 */
app.delete("/machines/:id", requireAuth, (req, res) => {
  machines.removeMachine(req.params.id);
  res.json({ success: true });
});

/**
 * POST /machines/:id/bootstrap
 * Clone repo + build PHP image + start docker compose on the remote machine.
 * Fires in the background — poll GET /machines/:id/bootstrap-status for progress.
 */
app.post("/machines/:id/bootstrap", requireAuth, (req, res) => {
  const machine = machines.getMachine(req.params.id);
  if (!machine) return res.status(404).json({ error: "Machine not found" });
  remoteDeploy.bootstrapStack(machine); // fire-and-forget
  res.json({ status: "started" });
});

/**
 * GET /machines/:id/bootstrap-status
 * Returns current bootstrap log and status for a machine.
 */
app.get("/machines/:id/bootstrap-status", requireAuth, (req, res) => {
  const status = remoteDeploy.getBootstrapStatus(req.params.id);
  if (!status) return res.status(404).json({ error: "No bootstrap job found" });
  res.json(status);
});

/**
 * POST /machines/:id/test
 * Test SSH connectivity to a machine.
 */
app.post("/machines/:id/test", requireAuth, async (req, res) => {
  const machine = machines.getMachine(req.params.id);
  if (!machine) return res.status(404).json({ error: "Machine not found" });
  try {
    const output = await remoteDeploy.testConnection(machine);
    res.json({ success: true, output });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /containers
 * List all running app containers.
 */
app.get("/containers", requireAuth, async (_req, res) => {
  try {
    const containers = await listAppContainers();
    res.json(containers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /containers/:name
 * Inspect a single app container.
 */
app.get("/containers/:name", requireAuth, async (req, res) => {
  try {
    const info = await inspectContainer(req.params.name);
    res.json(info);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: "Container not found" });
    res.status(500).json({ error: err.message });
  }
});


/**
 * GET /health
 * Liveness probe.
 */
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`Deploy Engine running on port ${config.port}`);
});
