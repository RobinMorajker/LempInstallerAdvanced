const axios = require("axios");
const crypto = require("crypto");
const config = require("./config");

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL     = "https://github.com/login/oauth/access_token";
const GITHUB_API           = "https://api.github.com";

// ── OAuth helpers ─────────────────────────────────────────────────────────────

/**
 * Build the GitHub OAuth authorization URL.
 * Returns { url, state } — state must be saved in the session for CSRF protection.
 */
function buildAuthUrl() {
  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id:    config.github.clientId,
    redirect_uri: config.github.callbackUrl,
    scope:        "read:user repo",
    state
  });
  return { url: `${GITHUB_AUTHORIZE_URL}?${params}`, state };
}

/**
 * Exchange a GitHub OAuth code for an access token.
 */
async function exchangeCode(code) {
  const res = await axios.post(
    GITHUB_TOKEN_URL,
    {
      client_id:     config.github.clientId,
      client_secret: config.github.clientSecret,
      code
    },
    { headers: { Accept: "application/json" } }
  );

  if (res.data.error) {
    throw new Error(res.data.error_description || res.data.error);
  }

  return res.data.access_token;
}

// ── GitHub API calls ──────────────────────────────────────────────────────────

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept:        "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

/**
 * Fetch the authenticated user's profile.
 */
async function getUser(token) {
  const { data } = await axios.get(`${GITHUB_API}/user`, {
    headers: ghHeaders(token)
  });
  return {
    login:     data.login,
    name:      data.name || data.login,
    avatarUrl: data.avatar_url
  };
}

/**
 * List all repos accessible to the authenticated user.
 * Returns repos sorted by last push descending.
 */
async function listRepos(token) {
  const repos = [];
  let page = 1;

  // GitHub paginates at 100 per page
  while (true) {
    const { data } = await axios.get(`${GITHUB_API}/user/repos`, {
      headers: ghHeaders(token),
      params:  { per_page: 100, page, sort: "pushed", affiliation: "owner,collaborator" }
    });

    if (!data.length) break;
    repos.push(...data.map(r => ({
      fullName:    r.full_name,
      name:        r.name,
      private:     r.private,
      description: r.description || "",
      cloneUrl:    r.clone_url,
      defaultBranch: r.default_branch
    })));

    if (data.length < 100) break;
    page++;
  }

  return repos;
}

module.exports = { buildAuthUrl, exchangeCode, getUser, listRepos };
