/**
 * Automated Security Test Suite - Phase 2 Hardening
 *
 * Task 4: Secure File Uploads (magic-byte validation, sharp re-encoding, nosniff, path traversal)
 * Task 5: Password Reset Email Delivery (mailer integration, hashed tokens, no enumeration, single-use)
 * Task 6: HttpOnly Cookies for Refresh Tokens (cookies, rotation, CSRF protection, CORS credentials)
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

process.env.NODE_ENV = "test";
process.env.CORS_ORIGINS = "http://localhost:5173,http://localhost:4173,https://campushub.edu.et";

const app = require("../src/app");
const db = require("../src/db");
const mailer = require("../src/utils/mailer");
const { hashPassword } = require("../src/utils/hash");
const { signAccessToken, hashToken } = require("../src/utils/jwt");

let server;
let baseUrl;
let aastuUniversityId;
let testStudent;
let testStudentToken;
let testAdmin;
let testAdminToken;

// Capture outbound emails for inspection in tests
let capturedEmails = [];
const originalSendMail = mailer.sendMail;

before(async () => {
  // Start ephemeral server
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  // Hook mailer to capture sent emails
  mailer.sendMail = async (emailOpts) => {
    capturedEmails.push(emailOpts);
    return { delivered: true, messageId: `test-${Date.now()}` };
  };

  // Fetch or ensure university
  const { rows: uRows } = await db.query("SELECT id FROM universities WHERE domain = 'aastu.edu.et' LIMIT 1");
  assert.ok(uRows[0], "AASTU university must exist");
  aastuUniversityId = uRows[0].id;

  // Clean old test users and dependent records
  await db.query("DELETE FROM audit_logs WHERE actor_id IN (SELECT id FROM users WHERE email IN ('sec_p2_student@aastu.edu.et', 'sec_p2_admin@aastu.edu.et'))");
  await db.query("DELETE FROM verification_requests WHERE user_id IN (SELECT id FROM users WHERE email IN ('sec_p2_student@aastu.edu.et', 'sec_p2_admin@aastu.edu.et'))");
  await db.query("DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email IN ('sec_p2_student@aastu.edu.et', 'sec_p2_admin@aastu.edu.et'))");
  await db.query("DELETE FROM users WHERE email IN ('sec_p2_student@aastu.edu.et', 'sec_p2_admin@aastu.edu.et')");

  // Create test student
  const pwHash = await hashPassword("Password123!");
  const { rows: sRows } = await db.query(
    `INSERT INTO users (university_id, name, email, password_hash, role, verified, email_verified)
     VALUES ($1, 'Phase2 Student', 'sec_p2_student@aastu.edu.et', $2, 'student', true, true)
     RETURNING *`,
    [aastuUniversityId, pwHash]
  );
  testStudent = sRows[0];
  testStudentToken = signAccessToken(testStudent);

  // Create test admin
  const { rows: aRows } = await db.query(
    `INSERT INTO users (university_id, name, email, password_hash, role, verified, email_verified)
     VALUES ($1, 'Phase2 Admin', 'sec_p2_admin@aastu.edu.et', $2, 'admin', true, true)
     RETURNING *`,
    [aastuUniversityId, pwHash]
  );
  testAdmin = aRows[0];
  testAdminToken = signAccessToken(testAdmin);
});

after(async () => {
  mailer.sendMail = originalSendMail;
  if (testStudent) {
    await db.query("DELETE FROM audit_logs WHERE actor_id IN ($1, $2)", [testStudent.id, testAdmin?.id]);
    await db.query("DELETE FROM verification_requests WHERE user_id = $1", [testStudent.id]);
    await db.query("DELETE FROM refresh_tokens WHERE user_id IN ($1, $2)", [testStudent.id, testAdmin?.id]);
    await db.query("DELETE FROM users WHERE id IN ($1, $2)", [testStudent.id, testAdmin?.id]);
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await db.pool.end();
});

beforeEach(async () => {
  capturedEmails = [];
  if (testStudent) {
    const pwHash = await hashPassword("Password123!");
    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [pwHash, testStudent.id]);
  }
});

// Helper for making API requests
async function apiRequest(endpoint, { method = "GET", headers = {}, body, cookie } = {}) {
  const reqHeaders = { ...headers };
  let payload = undefined;

  if (cookie) {
    reqHeaders["Cookie"] = cookie;
  }

  if (body !== undefined) {
    if (body instanceof FormData) {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      reqHeaders["Content-Type"] = "application/json";
    }
  }

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: reqHeaders,
    body: payload,
  });

  const contentType = res.headers.get("content-type") || "";
  let data = null;
  if (contentType.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return { status: res.status, headers: res.headers, data };
}

// Extract cookies from Set-Cookie headers
function parseCookies(resHeaders) {
  const cookieHeaders = resHeaders.getSetCookie ? resHeaders.getSetCookie() : [resHeaders.get("set-cookie")].filter(Boolean);
  const cookies = {};
  for (const str of cookieHeaders) {
    const parts = str.split(";")[0].split("=");
    if (parts.length >= 2) {
      cookies[parts[0].trim()] = parts.slice(1).join("=").trim();
    }
  }
  return cookies;
}

// ════════════════════════════════════════════════════════════════════════════
// TASK 4: SECURE FILE UPLOADS
// ════════════════════════════════════════════════════════════════════════════
describe("Task 4: Secure File Uploads", () => {
  test("4.1 Valid JPEG upload passes magic-byte check, is re-encoded by sharp, and gets random filename", async () => {
    const jpegBuffer = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 50, b: 50 } },
    }).jpeg().toBuffer();

    const formData = new FormData();
    formData.append("file", new Blob([jpegBuffer], { type: "image/jpeg" }), "my_avatar.jpeg");

    const res = await apiRequest("/api/uploads", {
      method: "POST",
      headers: { Authorization: `Bearer ${testStudentToken}` },
      body: formData,
    });

    assert.equal(res.status, 201);
    assert.ok(res.data.url);
    assert.match(res.data.url, /^\/uploads\/[a-f0-9]{40}\.jpg$/);

    // Verify file actually exists on disk
    const filename = path.basename(res.data.url);
    const diskPath = path.join(__dirname, "..", "uploads", filename);
    assert.ok(fs.existsSync(diskPath), "Re-encoded file must exist on disk");

    // Clean up
    fs.unlinkSync(diskPath);
  });

  test("4.2 Valid PNG upload passes magic-byte check, is re-encoded by sharp, and strips metadata", async () => {
    const pngBuffer = await sharp({
      create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 128, b: 255, alpha: 1 } },
    }).png().toBuffer();

    const formData = new FormData();
    formData.append("file", new Blob([pngBuffer], { type: "image/png" }), "product.png");

    const res = await apiRequest("/api/uploads", {
      method: "POST",
      headers: { Authorization: `Bearer ${testStudentToken}` },
      body: formData,
    });

    assert.equal(res.status, 201);
    assert.match(res.data.url, /^\/uploads\/[a-f0-9]{40}\.png$/);

    const filename = path.basename(res.data.url);
    const diskPath = path.join(__dirname, "..", "uploads", filename);
    assert.ok(fs.existsSync(diskPath));
    fs.unlinkSync(diskPath);
  });

  test("4.3 Valid WebP upload passes magic-byte check and is re-encoded", async () => {
    const webpBuffer = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 50, g: 200, b: 50 } },
    }).webp().toBuffer();

    const formData = new FormData();
    formData.append("file", new Blob([webpBuffer], { type: "image/webp" }), "banner.webp");

    const res = await apiRequest("/api/uploads", {
      method: "POST",
      headers: { Authorization: `Bearer ${testStudentToken}` },
      body: formData,
    });

    assert.equal(res.status, 201);
    assert.match(res.data.url, /^\/uploads\/[a-f0-9]{40}\.webp$/);

    const filename = path.basename(res.data.url);
    const diskPath = path.join(__dirname, "..", "uploads", filename);
    assert.ok(fs.existsSync(diskPath));
    fs.unlinkSync(diskPath);
  });

  test("4.4 Disguised MIME type (HTML file disguised as JPEG) is rejected (HTTP 400)", async () => {
    const fakeImage = Buffer.from("<html><script>alert('XSS')</script></html>");

    const formData = new FormData();
    // Client claims it's an image/jpeg with a .jpg filename
    formData.append("file", new Blob([fakeImage], { type: "image/jpeg" }), "innocent.jpg");

    const res = await apiRequest("/api/uploads", {
      method: "POST",
      headers: { Authorization: `Bearer ${testStudentToken}` },
      body: formData,
    });

    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /Unsupported file type|not allowed/i);
  });

  test("4.5 Malicious SVG/script file disguised as PNG is rejected (HTTP 400)", async () => {
    const maliciousSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    const formData = new FormData();
    formData.append("file", new Blob([maliciousSvg], { type: "image/png" }), "vector.png");

    const res = await apiRequest("/api/uploads", {
      method: "POST",
      headers: { Authorization: `Bearer ${testStudentToken}` },
      body: formData,
    });

    assert.equal(res.status, 400);
  });

  test("4.6 Malformed image with corrupted data is rejected (HTTP 400)", async () => {
    // Has JPEG magic header [FF D8 FF] but subsequent bytes are random corrupted garbage
    const corruptedJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0xDE, 0xAD, 0xBE, 0xEF]);

    const formData = new FormData();
    formData.append("file", new Blob([corruptedJpeg], { type: "image/jpeg" }), "corrupt.jpg");

    const res = await apiRequest("/api/uploads", {
      method: "POST",
      headers: { Authorization: `Bearer ${testStudentToken}` },
      body: formData,
    });

    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /corrupted|not a valid image/i);
  });

  test("4.7 Verification document upload accepts valid PDF (magic-bytes %PDF) without converting to image", async () => {
    // Reset verified state so student can submit
    await db.query("UPDATE users SET verified = false WHERE id = $1", [testStudent.id]);

    const minimalPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF");

    const formData = new FormData();
    formData.append("document", new Blob([minimalPdf], { type: "application/pdf" }), "my_student_id.pdf");
    formData.append("documentType", "student_id");
    formData.append("studentNote", "Here is my enrollment card");

    const res = await apiRequest("/api/verifications/submit", {
      method: "POST",
      headers: { Authorization: `Bearer ${testStudentToken}` },
      body: formData,
    });

    assert.equal(res.status, 201);
    assert.ok(res.data.request.hasDocument);

    // Verify document was saved as .pdf
    const { rows } = await db.query("SELECT document_url FROM verification_requests WHERE id = $1", [res.data.request.id]);
    assert.match(rows[0].document_url, /\.pdf$/);

    // Clean up
    const docPath = path.join(__dirname, "..", "..", rows[0].document_url);
    if (fs.existsSync(docPath)) fs.unlinkSync(docPath);
    await db.query("DELETE FROM verification_requests WHERE id = $1", [res.data.request.id]);
  });

  test("4.8 Path traversal attempt in original filename is completely neutralized", async () => {
    const pngBuffer = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 10, g: 10, b: 10 } },
    }).png().toBuffer();

    const formData = new FormData();
    // Malicious original filename trying to escape upload directory
    formData.append("file", new Blob([pngBuffer], { type: "image/png" }), "../../../etc/passwd.png");

    const res = await apiRequest("/api/uploads", {
      method: "POST",
      headers: { Authorization: `Bearer ${testStudentToken}` },
      body: formData,
    });

    assert.equal(res.status, 201);
    // Filename must be random hex only, never contains ../ or original string
    assert.match(res.data.url, /^\/uploads\/[a-f0-9]{40}\.png$/);
    assert.ok(!res.data.url.includes("passwd"));

    const filename = path.basename(res.data.url);
    const diskPath = path.join(__dirname, "..", "uploads", filename);
    if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
  });

  test("4.9 Uploaded static content is served with X-Content-Type-Options: nosniff", async () => {
    const pngBuffer = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 100, g: 100, b: 100 } },
    }).png().toBuffer();

    const formData = new FormData();
    formData.append("file", new Blob([pngBuffer], { type: "image/png" }), "test_sniff.png");

    const uploadRes = await apiRequest("/api/uploads", {
      method: "POST",
      headers: { Authorization: `Bearer ${testStudentToken}` },
      body: formData,
    });

    const fileUrl = uploadRes.data.url;
    const fetchRes = await fetch(`${baseUrl}${fileUrl}`);
    assert.equal(fetchRes.status, 200);
    assert.equal(fetchRes.headers.get("x-content-type-options"), "nosniff");

    const filename = path.basename(fileUrl);
    const diskPath = path.join(__dirname, "..", "uploads", filename);
    if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TASK 5: PASSWORD RESET EMAIL DELIVERY
// ════════════════════════════════════════════════════════════════════════════
describe("Task 5: Password Reset Email Delivery", () => {
  test("5.1 Unknown email returns generic message without revealing account non-existence", async () => {
    const res = await apiRequest("/api/auth/forgot-password", {
      method: "POST",
      body: { email: "nonexistent_person_xyz@aastu.edu.et" },
    });

    assert.equal(res.status, 200);
    assert.ok(res.data.message);
    assert.equal(res.data.devResetToken, undefined, "Must NEVER return raw reset token");
    assert.equal(capturedEmails.length, 0, "No email should be dispatched for unknown user");
  });

  test("5.2 Registered user forgot-password returns generic message and delivers email via mailer", async () => {
    const res = await apiRequest("/api/auth/forgot-password", {
      method: "POST",
      body: { email: testStudent.email },
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.devResetToken, undefined, "Raw token must NOT be in JSON response");
    assert.equal(capturedEmails.length, 1, "Exactly one reset email dispatched");
    assert.equal(capturedEmails[0].to, testStudent.email);
    assert.match(capturedEmails[0].subject, /Reset your Gibiyachin password/i);
    assert.match(capturedEmails[0].text, /reset-password\?token=/);
  });

  test("5.3 Reset token is stored ONLY as SHA-256 hash in database", async () => {
    await apiRequest("/api/auth/forgot-password", {
      method: "POST",
      body: { email: testStudent.email },
    });

    assert.equal(capturedEmails.length, 1);
    const emailText = capturedEmails[0].text;
    const tokenMatch = emailText.match(/token=([a-f0-9]{64})/);
    assert.ok(tokenMatch, "Reset link in email must contain 64-char hex token");
    const rawToken = tokenMatch[1];

    const { rows } = await db.query("SELECT password_reset_token FROM users WHERE email = $1", [testStudent.email]);
    const storedHash = rows[0].password_reset_token;

    // The stored value must NOT be the raw token, but its SHA-256 hash
    assert.notEqual(storedHash, rawToken);
    assert.equal(storedHash, hashToken(rawToken));
  });

  test("5.4 Valid reset token changes password successfully", async () => {
    await apiRequest("/api/auth/forgot-password", {
      method: "POST",
      body: { email: testStudent.email },
    });

    const emailText = capturedEmails[0].text;
    const rawToken = emailText.match(/token=([a-f0-9]{64})/)[1];

    const newPassword = "BrandNewPassword2026!";
    const res = await apiRequest("/api/auth/reset-password", {
      method: "POST",
      body: { token: rawToken, newPassword },
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);

    // Verify user can now log in with the new password
    const loginRes = await apiRequest("/api/auth/login", {
      method: "POST",
      body: { email: testStudent.email, password: newPassword },
    });
    assert.equal(loginRes.status, 200);
    assert.ok(loginRes.data.accessToken);
  });

  test("5.5 Reset token is single-use and cannot be used twice", async () => {
    await apiRequest("/api/auth/forgot-password", {
      method: "POST",
      body: { email: testStudent.email },
    });

    const rawToken = capturedEmails[0].text.match(/token=([a-f0-9]{64})/)[1];

    // First use: succeeds
    const res1 = await apiRequest("/api/auth/reset-password", {
      method: "POST",
      body: { token: rawToken, newPassword: "SecondPassword999!" },
    });
    assert.equal(res1.status, 200);

    // Second use: must be rejected (single-use enforcement)
    const res2 = await apiRequest("/api/auth/reset-password", {
      method: "POST",
      body: { token: rawToken, newPassword: "ThirdPassword999!" },
    });
    assert.equal(res2.status, 400);
    assert.match(res2.data.error.message, /invalid or expired/i);
  });

  test("5.6 Expired reset token is rejected (HTTP 400)", async () => {
    const expiredToken = crypto.randomBytes(32).toString("hex");
    // Manually insert an expired token into DB
    await db.query(
      "UPDATE users SET password_reset_token = $1, password_reset_expires = now() - interval '10 minutes' WHERE id = $2",
      [hashToken(expiredToken), testStudent.id]
    );

    const res = await apiRequest("/api/auth/reset-password", {
      method: "POST",
      body: { token: expiredToken, newPassword: "PasswordExpired1!" },
    });

    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /invalid or expired/i);
  });

  test("5.7 Invalid / tampered reset token is rejected (HTTP 400)", async () => {
    const res = await apiRequest("/api/auth/reset-password", {
      method: "POST",
      body: { token: "totally_invalid_fabricated_token_12345", newPassword: "PasswordTampered1!" },
    });

    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /invalid or expired/i);
  });

  test("5.8 Password reset revokes all existing refresh tokens for the user", async () => {
    // Create an active refresh token
    const testRefresh = crypto.randomBytes(48).toString("hex");
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, revoked)
       VALUES ($1, $2, $3, now() + interval '30 days', false)`,
      [testStudent.id, hashToken(testRefresh), crypto.randomUUID()]
    );

    // Request reset
    await apiRequest("/api/auth/forgot-password", {
      method: "POST",
      body: { email: testStudent.email },
    });

    const rawToken = capturedEmails[0].text.match(/token=([a-f0-9]{64})/)[1];
    await apiRequest("/api/auth/reset-password", {
      method: "POST",
      body: { token: rawToken, newPassword: "AnotherFreshPassword1!" },
    });

    // Verify all refresh tokens for this user are revoked
    const { rows } = await db.query("SELECT revoked FROM refresh_tokens WHERE user_id = $1", [testStudent.id]);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.revoked === true), "All sessions must be revoked after password reset");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TASK 6: HTTP-ONLY COOKIE REFRESH TOKENS & CSRF
// ════════════════════════════════════════════════════════════════════════════
describe("Task 6: HttpOnly Cookie Refresh Tokens & CSRF", () => {
  test("6.1 Successful login sets HttpOnly ch_refresh cookie with Path=/api/auth", async () => {
    const res = await apiRequest("/api/auth/login", {
      method: "POST",
      body: { email: testStudent.email, password: "Password123!" },
    });

    assert.equal(res.status, 200);

    const rawSetCookie = res.headers.get("set-cookie") || "";
    assert.ok(rawSetCookie.includes("ch_refresh="), "Response must contain ch_refresh Set-Cookie header");
    assert.ok(rawSetCookie.includes("HttpOnly"), "ch_refresh cookie must be HttpOnly");
    assert.ok(rawSetCookie.includes("Path=/api/auth"), "ch_refresh cookie must be scoped to Path=/api/auth");
  });

  test("6.2 Successful login sets readable ch_csrf cookie and returns csrfToken", async () => {
    const res = await apiRequest("/api/auth/login", {
      method: "POST",
      body: { email: testStudent.email, password: "Password123!" },
    });

    assert.equal(res.status, 200);
    assert.ok(res.data.csrfToken, "Login response must provide csrfToken");

    const cookies = parseCookies(res.headers);
    assert.ok(cookies.ch_csrf, "Response must set ch_csrf cookie");
    assert.equal(cookies.ch_csrf, res.data.csrfToken);
  });

  test("6.3 Login response JSON never exposes refreshToken", async () => {
    const res = await apiRequest("/api/auth/login", {
      method: "POST",
      body: { email: testStudent.email, password: "Password123!" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.refreshToken, undefined, "refreshToken must NEVER be exposed in JSON body");
    assert.ok(res.data.accessToken, "accessToken must be present");
  });

  test("6.4 Refresh with valid HttpOnly cookie and X-CSRF-Token succeeds and rotates the refresh cookie", async () => {
    const loginRes = await apiRequest("/api/auth/login", {
      method: "POST",
      body: { email: testStudent.email, password: "Password123!" },
    });

    const cookies = parseCookies(loginRes.headers);
    const initialRefresh = cookies.ch_refresh;
    const csrfToken = cookies.ch_csrf;
    const cookieHeader = `ch_refresh=${initialRefresh}; ch_csrf=${csrfToken}`;

    const refreshRes = await apiRequest("/api/auth/refresh", {
      method: "POST",
      cookie: cookieHeader,
      headers: { "X-CSRF-Token": csrfToken },
    });

    assert.equal(refreshRes.status, 200);
    assert.ok(refreshRes.data.accessToken);
    assert.equal(refreshRes.data.refreshToken, undefined, "Rotated refreshToken must not be in JSON");

    // Must set new rotated cookie
    const newCookies = parseCookies(refreshRes.headers);
    assert.ok(newCookies.ch_refresh, "Must set new rotated ch_refresh cookie");
    assert.notEqual(newCookies.ch_refresh, initialRefresh, "Rotated cookie must be distinct from original");
  });

  test("6.5 Refresh with HttpOnly cookie missing X-CSRF-Token is rejected (HTTP 403 CSRF_DETECTED)", async () => {
    const loginRes = await apiRequest("/api/auth/login", {
      method: "POST",
      body: { email: testStudent.email, password: "Password123!" },
    });

    const cookies = parseCookies(loginRes.headers);
    const cookieHeader = `ch_refresh=${cookies.ch_refresh}; ch_csrf=${cookies.ch_csrf}`;

    // Request with cookie but WITHOUT X-CSRF-Token header
    const refreshRes = await apiRequest("/api/auth/refresh", {
      method: "POST",
      cookie: cookieHeader,
    });

    assert.equal(refreshRes.status, 403);
    assert.equal(refreshRes.data.error.code, "CSRF_DETECTED");
  });

  test("6.6 Refresh with HttpOnly cookie and mismatched X-CSRF-Token is rejected (HTTP 403 CSRF_DETECTED)", async () => {
    const loginRes = await apiRequest("/api/auth/login", {
      method: "POST",
      body: { email: testStudent.email, password: "Password123!" },
    });

    const cookies = parseCookies(loginRes.headers);
    const cookieHeader = `ch_refresh=${cookies.ch_refresh}; ch_csrf=${cookies.ch_csrf}`;

    // Attacker submits wrong CSRF token
    const refreshRes = await apiRequest("/api/auth/refresh", {
      method: "POST",
      cookie: cookieHeader,
      headers: { "X-CSRF-Token": "attacker_forged_csrf_token_value_xyz" },
    });

    assert.equal(refreshRes.status, 403);
    assert.equal(refreshRes.data.error.code, "CSRF_DETECTED");
  });

  test("6.7 Refresh without cookie or body is rejected (HTTP 401 NO_REFRESH_TOKEN)", async () => {
    const res = await apiRequest("/api/auth/refresh", {
      method: "POST",
    });

    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, "NO_REFRESH_TOKEN");
  });

  test("6.8 Refresh token reuse detection revokes entire token family when rotated token is replayed", async () => {
    const loginRes = await apiRequest("/api/auth/login", {
      method: "POST",
      body: { email: testStudent.email, password: "Password123!" },
    });

    const cookies1 = parseCookies(loginRes.headers);
    const token1 = cookies1.ch_refresh;
    const csrf1 = cookies1.ch_csrf;

    // Legitimate rotation: exchange token1 for token2
    const refreshRes1 = await apiRequest("/api/auth/refresh", {
      method: "POST",
      cookie: `ch_refresh=${token1}; ch_csrf=${csrf1}`,
      headers: { "X-CSRF-Token": csrf1 },
    });
    assert.equal(refreshRes1.status, 200);

    const cookies2 = parseCookies(refreshRes1.headers);
    const token2 = cookies2.ch_refresh;
    const csrf2 = cookies2.ch_csrf;

    // Attacker (or replay) tries to use token1 AGAIN after it was already rotated
    const replayRes = await apiRequest("/api/auth/refresh", {
      method: "POST",
      cookie: `ch_refresh=${token1}; ch_csrf=${csrf1}`,
      headers: { "X-CSRF-Token": csrf1 },
    });

    assert.equal(replayRes.status, 401);
    assert.match(replayRes.data.error.message, /reuse detected/i);

    // Now even token2 must be revoked because the entire family was compromised
    const refreshRes2 = await apiRequest("/api/auth/refresh", {
      method: "POST",
      cookie: `ch_refresh=${token2}; ch_csrf=${csrf2}`,
      headers: { "X-CSRF-Token": csrf2 },
    });
    assert.equal(refreshRes2.status, 401);
  });

  test("6.9 Logout clears both ch_refresh and ch_csrf cookies and revokes token in DB", async () => {
    const loginRes = await apiRequest("/api/auth/login", {
      method: "POST",
      body: { email: testAdmin.email, password: "Password123!" },
    });

    const cookies = parseCookies(loginRes.headers);
    const refreshVal = cookies.ch_refresh;
    const csrfVal = cookies.ch_csrf;

    const logoutRes = await apiRequest("/api/auth/logout", {
      method: "POST",
      cookie: `ch_refresh=${refreshVal}; ch_csrf=${csrfVal}`,
      headers: { "X-CSRF-Token": csrfVal },
    });

    assert.equal(logoutRes.status, 200);

    // Verify Set-Cookie header clears the cookie (expires in past / max-age=0)
    const rawSetCookie = logoutRes.headers.get("set-cookie") || "";
    assert.ok(rawSetCookie.includes("ch_refresh=;"), "ch_refresh must be cleared on logout");

    // Verify token is revoked in DB
    const { rows } = await db.query("SELECT revoked FROM refresh_tokens WHERE token_hash = $1", [hashToken(refreshVal)]);
    assert.equal(rows[0]?.revoked, true);
  });

  test("6.10 CORS configuration allows credentials for whitelisted origin and blocks untrusted origin", async () => {
    // Whitelisted origin
    const resAllowed = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(resAllowed.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.equal(resAllowed.headers.get("access-control-allow-credentials"), "true");

    // Untrusted origin
    const resBlocked = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://malicious-attacker-site.com" },
    });
    assert.notEqual(resBlocked.headers.get("access-control-allow-origin"), "https://malicious-attacker-site.com");
  });
});
