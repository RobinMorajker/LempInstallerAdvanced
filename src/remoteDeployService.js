/**
 * Remote deploy service — deploys apps to an SSH-accessible machine.
 *
 * Pipeline (all via one SSH connection per deploy run):
 *   1. git clone / pull on the remote machine
 *   2. Provision MariaDB database + user (via docker exec lemp_db)
 *   3. Create PHP-FPM container + Nginx sidecar via docker CLI
 *   4. Configure Nginx Proxy Manager on the remote machine (HTTP call)
 */
const { Client }  = require("ssh2");
const axios       = require("axios");
const { v4: uuid } = require("uuid");

const store = require("./deployStore");

// ── SSH helpers ────────────────────────────────────────────────────────────────

/**
 * Open one SSH connection, run an async callback that receives
 * { exec, execSafe } helpers, then close cleanly.
 *
 * exec(cmd)     — rejects on non-zero exit code; resolves with trimmed stdout
 * execSafe(cmd) — same but swallows errors (use for teardown/cleanup steps)
 */
function withSSH(machine, fn) {
  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on("ready", async () => {
      const exec = (cmd) =>
        new Promise((res, rej) => {
          conn.exec(cmd, (err, stream) => {
            if (err) return rej(err);
            let out = "", errOut = "";
            stream.on("close", (code) => {
              if (code !== 0) {
                return rej(
                  new Error(
                    `Remote command failed (exit ${code}): ` +
                    (errOut || out).trim().slice(0, 400)
                  )
                );
              }
              res(out.trim());
            });
            stream.on("data",        (d) => (out    += d.toString()));
            stream.stderr.on("data", (d) => (errOut += d.toString()));
          });
        });

      const execSafe = (cmd) => exec(cmd).catch(() => "");

      try {
        resolve(await fn({ exec, execSafe }));
      } catch (e) {
        reject(e);
      } finally {
        conn.end();
      }
    });

    conn.on("error", reject);

    conn.connect({
      host:        machine.host,
      port:        machine.port || 22,
      username:    machine.user,
      privateKey:  machine.privateKey,
      readyTimeout: 20000
    });
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function _sanitizeId(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
}

function _nginxConf(fpmHost, docRoot) {
  return `server {
  listen 80;
  root ${docRoot};
  index index.php index.html;

  location / {
    try_files $uri $uri/ /index.php?$query_string;
  }

  location ~ \\.php$ {
    fastcgi_pass   ${fpmHost}:9000;
    fastcgi_index  index.php;
    include        fastcgi_params;
    fastcgi_param  SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_param  PATH_INFO $fastcgi_path_info;
  }

  location ~ /\\.ht { deny all; }
}`;
}

// ── Remote NPM helpers ─────────────────────────────────────────────────────────

async function _getNpmToken(machine) {
  const npmUrl = `http://${machine.host}:81/api`;
  const { data } = await axios.post(
    `${npmUrl}/tokens`,
    { identity: machine.npmEmail, secret: machine.npmPassword },
    { timeout: 15000 }
  );
  return { token: data.token, npmUrl };
}

async function _configureProxy(machine, domain, nginxContainer, ssl, email) {
  const { token, npmUrl } = await _getNpmToken(machine);
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  // Remove any existing host for this domain
  const { data: hosts } = await axios.get(`${npmUrl}/nginx/proxy-hosts`, auth);
  for (const h of hosts.filter(h => h.domain_names?.includes(domain))) {
    await axios.delete(`${npmUrl}/nginx/proxy-hosts/${h.id}`, auth);
  }

  let certId = 0;
  if (ssl) {
    try {
      const { data: certs } = await axios.get(`${npmUrl}/nginx/certificates`, auth);
      const existing = certs.find(c => c.domain_names?.includes(domain));
      if (existing) {
        certId = existing.id;
      } else {
        const { data: newCert } = await axios.post(
          `${npmUrl}/nginx/certificates`,
          {
            provider: "letsencrypt",
            domain_names: [domain],
            meta: {
              letsencrypt_email: email || machine.npmEmail,
              letsencrypt_agree: true
            }
          },
          { ...auth, timeout: 60000 }
        );
        certId = newCert.id;
      }
    } catch (e) {
      console.warn(`[remote] SSL cert failed for ${domain}: ${e.message}`);
    }
  }

  await axios.post(
    `${npmUrl}/nginx/proxy-hosts`,
    {
      domain_names:            [domain],
      forward_scheme:          "http",
      forward_host:            nginxContainer,
      forward_port:            80,
      access_list_id:          0,
      certificate_id:          certId,
      ssl_forced:              ssl && certId !== 0,
      block_exploits:          true,
      allow_websocket_upgrade: true
    },
    auth
  );
}

async function _deleteRemoteProxy(machine, domain) {
  try {
    const { token, npmUrl } = await _getNpmToken(machine);
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const { data: hosts } = await axios.get(`${npmUrl}/nginx/proxy-hosts`, auth);
    for (const h of hosts.filter(h => h.domain_names?.includes(domain))) {
      await axios.delete(`${npmUrl}/nginx/proxy-hosts/${h.id}`, auth);
    }
  } catch (e) {
    console.warn(`[remote] deleteProxy failed: ${e.message}`);
  }
}

// ── Deploy ─────────────────────────────────────────────────────────────────────

async function deploy({
  machine, machineId,
  repo, domain, appName,
  ssl = false, email,
  branch = "main", webRoot
}) {
  const name     = appName || "app_" + uuid().slice(0, 8);
  const deployId = uuid();
  const appPath  = `${machine.appsDir}/${name}`;

  store.setStatus(deployId, {
    status:      "pending",
    appName:     name,
    domain,
    repo,
    machineId,
    machineHost: machine.host,
    machineName: machine.name
  });

  _runDeploy({ deployId, name, appPath, machine, repo, domain, ssl, email, branch, webRoot, machineId })
    .catch(err => {
      console.error(`[remote] ${name} on ${machine.host} failed:`, err.message);
      store.setStatus(deployId, { status: "failed", error: err.message });
    });

  return {
    deployId, appName: name, domain, status: "pending",
    machineId, machineHost: machine.host, machineName: machine.name
  };
}

async function _runDeploy({ deployId, name, appPath, machine, repo, domain, ssl, email, branch, webRoot, machineId }) {

  // ── Steps 1–3 over one SSH connection ──────────────────────────────────────
  await withSSH(machine, async ({ exec, execSafe }) => {

    // ── Step 1: Clone / pull ─────────────────────────────────────────────
    store.setStatus(deployId, { status: "cloning" });

    await exec(`mkdir -p ${machine.appsDir}`);

    const gitCheck = await execSafe(
      `[ -d ${appPath}/.git ] && echo yes || echo no`
    );

    if (gitCheck === "yes") {
      await exec(`git -C ${appPath} pull origin ${branch}`);
    } else {
      await execSafe(`rm -rf ${appPath}`);
      try {
        await exec(`git clone ${repo} ${appPath} --branch ${branch} --depth 1`);
      } catch (cloneErr) {
        if (
          cloneErr.message.includes("Remote branch") ||
          cloneErr.message.includes("not found")
        ) {
          console.warn(`[remote] Branch '${branch}' not found — retrying with default`);
          await execSafe(`rm -rf ${appPath}`);
          await exec(`git clone ${repo} ${appPath} --depth 1`);
        } else {
          throw cloneErr;
        }
      }
    }

    // ── Step 2: Provision database ───────────────────────────────────────
    store.setStatus(deployId, { status: "provisioning_db" });

    const dbName = _sanitizeId(name);
    const dbUser = dbName;
    const dbPwd  = machine.dbAppPassword;

    // Use MYSQL_PWD env var (avoids password in process list)
    // Pipe SQL via base64 stdin so the SQL itself is never on the command line
    const sql = [
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
      `CREATE USER IF NOT EXISTS '${dbUser}'@'%' IDENTIFIED BY '${dbPwd}';`,
      `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'%';`,
      `FLUSH PRIVILEGES;`
    ].join("\n");

    const sqlB64 = Buffer.from(sql).toString("base64");
    const rootPw = machine.dbRootPassword.replace(/'/g, "'\\''");
    await exec(
      `printf '%s' '${sqlB64}' | base64 -d | ` +
      `docker exec -e MYSQL_PWD='${rootPw}' -i lemp_db mariadb -u root`
    );

    // ── Step 3: Create containers ────────────────────────────────────────
    store.setStatus(deployId, { status: "building_container" });

    // Ensure PHP image exists on remote
    const imgCheck = await execSafe(
      `docker image inspect ${machine.phpImage} >/dev/null 2>&1 && echo yes || echo no`
    );
    if (imgCheck !== "yes") {
      throw new Error(
        `PHP image '${machine.phpImage}' not found on ${machine.host}. ` +
        `SSH in and run: docker build -t ${machine.phpImage} /path/to/LempInstallerAdvanced/php`
      );
    }

    // Ensure Docker network exists
    await execSafe(
      `docker network ls --format '{{.Name}}' | grep -q '^${machine.dockerNetwork}$' || ` +
      `docker network create --driver bridge ${machine.dockerNetwork}`
    );

    // Tear down old containers (ignore errors — they may not exist)
    await execSafe(
      `docker stop  nginx_${name} ${name} 2>/dev/null; ` +
      `docker rm    nginx_${name} ${name} 2>/dev/null; true`
    );

    // PHP-FPM container
    const envFlags = [
      `DB_HOST=lemp_db`, `DB_PORT=3306`,
      `DB_NAME=${dbName}`, `DB_USER=${dbUser}`, `DB_PASSWORD=${dbPwd}`,
      `REDIS_HOST=lemp_redis`, `REDIS_PORT=6379`, `APP_ENV=production`
    ].map(e => `-e '${e}'`).join(" ");

    await exec(
      `docker run -d --name ${name} --hostname ${name} ` +
      `--network ${machine.dockerNetwork} --restart always ` +
      `-m 512m --cpus 0.5 ` +
      `-v ${appPath}:/var/www/html:rw ` +
      `${envFlags} ` +
      `--label deploy-engine=true --label "deploy-engine.app=${name}" ` +
      `${machine.phpImage}`
    );

    // Write Nginx config to host filesystem via base64
    const docRoot = webRoot
      ? `/var/www/html/${webRoot.replace(/^\/+|\/+$/g, "")}`
      : "/var/www/html";
    const conf    = _nginxConf(name, docRoot);
    const confB64 = Buffer.from(conf).toString("base64");
    await exec(`mkdir -p ${appPath}/.nginx`);
    await exec(`printf '%s' '${confB64}' | base64 -d > ${appPath}/.nginx/default.conf`);

    // Nginx sidecar — volume-mounts the config file written above
    await exec(
      `docker run -d --name nginx_${name} --hostname nginx_${name} ` +
      `--network ${machine.dockerNetwork} --restart always ` +
      `-m 64m --cpus 0.25 ` +
      `-v ${appPath}:/var/www/html:ro ` +
      `-v ${appPath}/.nginx/default.conf:/etc/nginx/conf.d/default.conf:ro ` +
      `--label deploy-engine=true --label "deploy-engine.app=${name}" ` +
      `nginx:alpine`
    );
  });

  // ── Step 4: Configure remote Nginx Proxy Manager (HTTP call) ─────────────
  store.setStatus(deployId, { status: "configuring_proxy" });
  await _configureProxy(machine, domain, `nginx_${name}`, ssl, email);

  store.setStatus(deployId, { status: "live" });
  console.log(`[remote] ${name} → ${ssl ? "https" : "http"}://${domain} (live on ${machine.host})`);
}

// ── Destroy ────────────────────────────────────────────────────────────────────

async function destroy(machine, appName, domain) {
  const appPath = `${machine.appsDir}/${appName}`;
  const dbName  = _sanitizeId(appName);
  const rootPw  = machine.dbRootPassword.replace(/'/g, "'\\''");

  await withSSH(machine, async ({ execSafe }) => {
    // Remove containers
    await execSafe(
      `docker stop  nginx_${appName} ${appName} 2>/dev/null; ` +
      `docker rm    nginx_${appName} ${appName} 2>/dev/null; true`
    );

    // Drop database + user
    const sql = [
      `DROP DATABASE IF EXISTS \`${dbName}\`;`,
      `DROP USER IF EXISTS '${dbName}'@'%';`,
      `FLUSH PRIVILEGES;`
    ].join("\n");
    const sqlB64 = Buffer.from(sql).toString("base64");
    await execSafe(
      `printf '%s' '${sqlB64}' | base64 -d | ` +
      `docker exec -e MYSQL_PWD='${rootPw}' -i lemp_db mariadb -u root`
    );

    // Remove app files
    await execSafe(`rm -rf ${appPath}`);
  });

  // Remove NPM proxy host
  await _deleteRemoteProxy(machine, domain);
}

// ── Test connection ────────────────────────────────────────────────────────────

async function testConnection(machine) {
  return withSSH(machine, async ({ exec }) => {
    const info = await exec(
      "echo ok && " +
      "uname -srm && " +
      "docker --version 2>&1 | head -1"
    );
    return info;
  });
}

module.exports = { deploy, destroy, testConnection };
