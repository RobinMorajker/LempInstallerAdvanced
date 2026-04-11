const mysql = require("mysql2/promise");
const config = require("./config");

/**
 * Open a short-lived root connection to MariaDB.
 * Always call conn.end() in a finally block.
 */
async function getRootConnection() {
  return mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: "root",
    password: config.db.rootPassword
  });
}

/**
 * Provision a database and a dedicated user for an app.
 * Idempotent: safe to call again on re-deploy.
 *
 * @param {string} appName - Used as both the DB name and DB username
 * @returns {{ dbName: string, dbUser: string, dbPassword: string }}
 */
async function createDatabase(appName) {
  const dbName = sanitizeIdentifier(appName);
  const dbUser = sanitizeIdentifier(appName);
  const dbPassword = config.db.appPassword;

  const conn = await getRootConnection();
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );

    // CREATE USER is not idempotent in older MariaDB — use IF NOT EXISTS
    await conn.query(
      `CREATE USER IF NOT EXISTS '${dbUser}'@'%' IDENTIFIED BY ?`,
      [dbPassword]
    );

    await conn.query(
      `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'%'`
    );

    await conn.query("FLUSH PRIVILEGES");
  } finally {
    await conn.end();
  }

  return { dbName, dbUser, dbPassword };
}

/**
 * Drop the database and user for an app.
 * Safe to call even if they do not exist.
 *
 * @param {string} appName
 */
async function dropDatabase(appName) {
  const dbName = sanitizeIdentifier(appName);
  const dbUser = sanitizeIdentifier(appName);

  const conn = await getRootConnection();
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await conn.query(`DROP USER IF EXISTS '${dbUser}'@'%'`);
    await conn.query("FLUSH PRIVILEGES");
  } finally {
    await conn.end();
  }
}

/**
 * Strip everything except alphanumerics and underscores.
 * Prevents SQL injection via identifier names.
 */
function sanitizeIdentifier(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
}

module.exports = { createDatabase, dropDatabase };
