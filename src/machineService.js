/**
 * Machine registry — stores SSH-accessible remote machines in .machines.json.
 * Private keys and passwords are never returned by listMachines(); only
 * getMachine(id) returns the full record (for internal use only).
 */
const fs   = require("fs");
const path = require("path");
const { v4: uuid } = require("uuid");

const FILE = path.join(__dirname, "..", ".machines.json");

function _load() {
  if (!fs.existsSync(FILE)) return [];
  try   { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch { return []; }
}

function _save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), "utf8");
}

/** Strip secrets before sending to the browser */
function _safe(m) {
  // eslint-disable-next-line no-unused-vars
  const { privateKey, passphrase, dbRootPassword, dbAppPassword, npmPassword, ...rest } = m;
  return { ...rest, hasKey: !!(privateKey && privateKey.trim().length > 20) };
}

/**
 * Add a new machine.  All fields except name/host/user/privateKey have
 * sensible defaults for a standard LempInstallerAdvanced Pi setup.
 */
function addMachine({
  name, host,
  port           = 22,
  user           = "pi",
  privateKey,
  passphrase,
  appsDir,
  dockerNetwork  = "lemp_net",
  phpImage       = "lemp-php-custom",
  dbRootPassword = "changeme_root",
  dbAppPassword  = "changeme_app",
  npmEmail       = "admin@example.com",
  npmPassword    = "changeme_npm"
}) {
  if (!name || !host || !user || !privateKey) {
    throw new Error("name, host, user, and privateKey are required");
  }
  const resolvedAppsDir = appsDir || `/home/${user}/apps`;
  const list = _load();
  const m = {
    id: uuid(),
    name, host,
    port: Number(port),
    user, privateKey,
    ...(passphrase ? { passphrase } : {}),
    appsDir: resolvedAppsDir, dockerNetwork, phpImage,
    dbRootPassword, dbAppPassword,
    npmEmail, npmPassword,
    createdAt: new Date().toISOString()
  };
  list.push(m);
  _save(list);
  return _safe(m);
}

/** Returns all machines WITHOUT secret fields */
function listMachines() {
  return _load().map(_safe);
}

/** Returns the full record including private key — for internal use only */
function getMachine(id) {
  return _load().find(m => m.id === id) || null;
}

function removeMachine(id) {
  _save(_load().filter(m => m.id !== id));
}

/**
 * Patch mutable fields on an existing machine.
 * Only whitelisted keys are accepted; secrets like privateKey cannot be
 * changed this way (would require re-adding the machine).
 */
function patchMachine(id, patch) {
  const allowed = ["passphrase", "name", "user", "port", "appsDir",
                   "dockerNetwork", "phpImage", "dbRootPassword",
                   "dbAppPassword", "npmEmail", "npmPassword"];
  const list = _load();
  const idx  = list.findIndex(m => m.id === id);
  if (idx === -1) throw new Error("Machine not found");
  const safe = Object.fromEntries(
    Object.entries(patch).filter(([k]) => allowed.includes(k))
  );
  // Allow clearing passphrase by passing empty string
  if ("passphrase" in safe && !safe.passphrase) delete list[idx].passphrase;
  else Object.assign(list[idx], safe);
  _save(list);
  return _safe(list[idx]);
}

module.exports = { addMachine, patchMachine, listMachines, getMachine, removeMachine };
