const { Router } = require("express");
const { buildAuthUrl, exchangeCode, getUser, listRepos } = require("../authService");

const router = Router();

// ── Middleware: require authenticated session ─────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

// ── GET /auth/github ──────────────────────────────────────────────────────────
// Redirect the browser to GitHub's OAuth consent screen.
router.get("/auth/github", (_req, res) => {
  const { url, state } = buildAuthUrl();
  _req.session.oauthState = state;
  res.redirect(url);
});

// ── GET /auth/github/callback ─────────────────────────────────────────────────
// GitHub redirects here after the user grants access.
router.get("/auth/github/callback", async (req, res) => {
  const { code, state } = req.query;

  // CSRF check
  if (!state || state !== req.session.oauthState) {
    return res.status(400).send("Invalid OAuth state. Please try again.");
  }
  delete req.session.oauthState;

  try {
    const token = await exchangeCode(code);
    const user  = await getUser(token);

    req.session.accessToken = token;
    req.session.user        = user;

    res.redirect("/");
  } catch (err) {
    console.error("[auth] callback error:", err.message);
    res.redirect("/?auth_error=1");
  }
});

// ── GET /auth/logout ──────────────────────────────────────────────────────────
router.get("/auth/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ── GET /api/me ───────────────────────────────────────────────────────────────
// Returns current user or null (never 401 — used for UI state checks).
router.get("/api/me", (req, res) => {
  res.json(req.session.user || null);
});

// ── GET /api/repos ────────────────────────────────────────────────────────────
// List repositories for the logged-in user.
router.get("/api/repos", requireAuth, async (req, res) => {
  try {
    const repos = await listRepos(req.session.accessToken);
    res.json(repos);
  } catch (err) {
    // Token may have expired
    if (err.response?.status === 401) {
      req.session.destroy(() =>
        res.status(401).json({ error: "Session expired. Please log in again." })
      );
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

module.exports = router;
