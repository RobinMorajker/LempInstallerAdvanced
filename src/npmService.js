const axios = require("axios");
const config = require("./config");

let _token = null;
let _tokenExpiry = 0;

/**
 * Authenticate with Nginx Proxy Manager and cache the token.
 * Tokens are valid for 1 hour; we refresh 60 seconds early.
 */
async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const res = await axios.post(`${config.npm.url}/tokens`, {
    identity: config.npm.email,
    secret: config.npm.password
  });

  _token = res.data.token;
  // NPM tokens expire after 1 hour
  _tokenExpiry = Date.now() + 3540 * 1000;
  return _token;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Get or create a Let's Encrypt SSL certificate for a domain.
 * Returns the certificate ID.
 *
 * @param {string} domain
 * @param {string} email - Used for Let's Encrypt registration
 */
async function getOrCreateCertificate(domain, email) {
  const token = await getToken();

  // Check for an existing certificate
  const { data: certs } = await axios.get(
    `${config.npm.url}/nginx/certificates`,
    { headers: authHeaders(token) }
  );

  const existing = certs.find(
    (c) => c.domain_names && c.domain_names.includes(domain)
  );
  if (existing) return existing.id;

  // Request new Let's Encrypt certificate
  const { data: newCert } = await axios.post(
    `${config.npm.url}/nginx/certificates`,
    {
      provider: "letsencrypt",
      domain_names: [domain],
      meta: {
        letsencrypt_email: email || config.npm.email,
        letsencrypt_agree: true
      }
    },
    { headers: authHeaders(token) }
  );

  return newCert.id;
}

/**
 * Create a proxy host in Nginx Proxy Manager.
 * Points a domain at an app container (by container name) on port 80.
 * Idempotent: deletes any existing host for the domain before creating.
 *
 * @param {object} opts
 * @param {string}  opts.domain      - Public domain name
 * @param {string}  opts.appName     - Docker container name / hostname
 * @param {boolean} [opts.ssl=true]  - Whether to enable SSL
 * @param {string}  [opts.email]     - Let's Encrypt contact email
 */
async function createProxyHost({ domain, appName, ssl = true, email }) {
  const token = await getToken();

  // Remove stale host for this domain if it exists
  await deleteProxyHostByDomain(domain, token);

  let certificateId = 0;
  if (ssl) {
    try {
      certificateId = await getOrCreateCertificate(domain, email);
    } catch (err) {
      // SSL provisioning can fail in local/LAN setups — log and continue without SSL
      console.warn(`[npmService] SSL certificate failed for ${domain}: ${err.message}`);
      certificateId = 0;
    }
  }

  const { data } = await axios.post(
    `${config.npm.url}/nginx/proxy-hosts`,
    {
      domain_names: [domain],
      forward_scheme: "http",
      forward_host: appName,
      forward_port: 80,
      access_list_id: 0,
      certificate_id: certificateId,
      ssl_forced: ssl && certificateId !== 0,
      block_exploits: true,
      allow_websocket_upgrade: true
    },
    { headers: authHeaders(token) }
  );

  return data;
}

/**
 * Delete the proxy host(s) for a domain.
 */
async function deleteProxyHostByDomain(domain, token) {
  const t = token || (await getToken());

  const { data: hosts } = await axios.get(
    `${config.npm.url}/nginx/proxy-hosts`,
    { headers: authHeaders(t) }
  );

  const matches = hosts.filter(
    (h) => h.domain_names && h.domain_names.includes(domain)
  );

  for (const host of matches) {
    await axios.delete(`${config.npm.url}/nginx/proxy-hosts/${host.id}`, {
      headers: authHeaders(t)
    });
  }
}

module.exports = { createProxyHost, deleteProxyHostByDomain };
