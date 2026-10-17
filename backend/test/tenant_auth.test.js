/**
 * Automated Security Test Suite - Phase 3 Stage 2
 * Authentication & Tenant Middleware Hardening
 *
 * Scenarios:
 * 1. Active, suspended, and archived university enforcement on requireAuth, login, and refresh.
 * 2. Role-specific behavior: student, merchant, organizer, university admin, and superadmin.
 * 3. Forged tenant IDs, headers (X-University-Id, X-University-Slug), and request parameters.
 * 4. Permitted-domains registration, domain aliases, conflict rejection, and manual pending.
 * 5. Protected profile fields tampering (camelCase and snake_case).
 * 6. University admin authorization scoping across tenants.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const crypto = require("crypto");

process.env.NODE_ENV = "test";

const app = require("../src/app");
const db = require("../src/db");
const { hashPassword } = require("../src/utils/hash");
const { signAccessToken, generateRefreshToken, hashToken } = require("../src/utils/jwt");

let server;
let baseUrl;

// Reusable test university IDs
let activeUniId;
let suspendedUniId;
let archivedUniId;

// Created test user IDs for cleanup
const createdUserIds = [];
const createdUniIds = [];

async function apiRequest(path, { method = "GET", headers = {}, body } = {}) {
  const url = `${baseUrl}${path}`;
  const reqHeaders = { ...headers };

  let reqBody = undefined;
  if (body !== undefined) {
    reqHeaders["Content-Type"] = "application/json";
    reqBody = typeof body === "string" ? body : JSON.stringify(body);
  }

  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: reqBody,
  });

  let data = null;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return { status: res.status, data, headers: res.headers };
}

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  // 1. Create a dedicated test active university with multiple permitted domains
  const activeRes = await db.query(
    `INSERT INTO universities (name, slug, domain, permitted_domains, status)
     VALUES ($1, $2, $3, $4, 'active')
     RETURNING id`,
    [
      "Stage 2 Active University",
      `stage2-active-${Date.now()}`,
      `stage2-active-${Date.now()}.edu.et`,
      [`stage2-active-${Date.now()}.edu.et`, `staff.stage2-active-${Date.now()}.edu.et`],
    ]
  );
  activeUniId = activeRes.rows[0].id;
  createdUniIds.push(activeUniId);

  // 2. Create a test suspended university
  const suspendedRes = await db.query(
    `INSERT INTO universities (name, slug, domain, permitted_domains, status)
     VALUES ($1, $2, $3, $4, 'suspended')
     RETURNING id`,
    [
      "Stage 2 Suspended University",
      `stage2-suspended-${Date.now()}`,
      `stage2-suspended-${Date.now()}.edu.et`,
      [`stage2-suspended-${Date.now()}.edu.et`],
    ]
  );
  suspendedUniId = suspendedRes.rows[0].id;
  createdUniIds.push(suspendedUniId);

  // 3. Create a test archived university
  const archivedRes = await db.query(
    `INSERT INTO universities (name, slug, domain, permitted_domains, status)
     VALUES ($1, $2, $3, $4, 'archived')
     RETURNING id`,
    [
      "Stage 2 Archived University",
      `stage2-archived-${Date.now()}`,
      `stage2-archived-${Date.now()}.edu.et`,
      [`stage2-archived-${Date.now()}.edu.et`],
    ]
  );
  archivedUniId = archivedRes.rows[0].id;
  createdUniIds.push(archivedUniId);
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  // Cleanup created test records
  if (createdUserIds.length > 0) {
    await db.query("DELETE FROM audit_logs WHERE actor_id = ANY($1) OR (target_type = 'user' AND target_id = ANY($1))", [createdUserIds]);
    await db.query("DELETE FROM refresh_tokens WHERE user_id = ANY($1)", [createdUserIds]);
    await db.query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds]);
  }
  if (createdUniIds.length > 0) {
    await db.query("DELETE FROM audit_logs WHERE university_id = ANY($1)", [createdUniIds]);
    await db.query("DELETE FROM universities WHERE id = ANY($1)", [createdUniIds]);
  }

  await db.pool.end();
});

// Helper to create test user in DB directly
async function createTestUser({ universityId, role = "student", suspended = false, emailVerified = true, email, password = "Password123!" }) {
  const hash = await hashPassword(password);
  const userEmail = email || `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@campus.edu.et`;
  const { rows } = await db.query(
    `INSERT INTO users (university_id, name, email, password_hash, role, verified, email_verified, suspended)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7)
     RETURNING *`,
    [universityId, "Test User", userEmail.toLowerCase(), hash, role, emailVerified, suspended]
  );
  createdUserIds.push(rows[0].id);
  return rows[0];
}

describe("Stage 2: Suspended and Archived University Enforcement", () => {
  test("1.1 requireAuth rejects user belonging to suspended university (HTTP 403 TENANT_SUSPENDED)", async () => {
    const user = await createTestUser({ universityId: suspendedUniId, role: "student" });
    const token = signAccessToken(user);

    const res = await apiRequest("/api/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, "TENANT_SUSPENDED");
  });

  test("1.2 requireAuth rejects user belonging to archived university (HTTP 403 TENANT_ARCHIVED)", async () => {
    const user = await createTestUser({ universityId: archivedUniId, role: "student" });
    const token = signAccessToken(user);

    const res = await apiRequest("/api/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, "TENANT_ARCHIVED");
  });

  test("1.3 requireAuth rejects merchant, organizer, and university admin on suspended university", async () => {
    for (const role of ["merchant", "organizer", "admin"]) {
      const user = await createTestUser({ universityId: suspendedUniId, role });
      const token = signAccessToken(user);

      const res = await apiRequest("/api/users/me", {
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(res.status, 403, `Expected role ${role} to be rejected on suspended university`);
      assert.equal(res.data.error.code, "TENANT_SUSPENDED");
    }
  });

  test("1.4 requireAuth permits platform super_admin even if university is suspended or null", async () => {
    const superAdminWithUni = await createTestUser({ universityId: suspendedUniId, role: "super_admin" });
    const token1 = signAccessToken(superAdminWithUni);

    const res1 = await apiRequest("/api/users/me", {
      headers: { Authorization: `Bearer ${token1}` },
    });
    assert.equal(res1.status, 200, "Super admin with suspended university should not be blocked");
    assert.equal(res1.data.user.id, superAdminWithUni.id);

    // Super admin with null university
    const superAdminNull = await createTestUser({ universityId: null, role: "super_admin" });
    const token2 = signAccessToken(superAdminNull);

    const res2 = await apiRequest("/api/users/me", {
      headers: { Authorization: `Bearer ${token2}` },
    });
    assert.equal(res2.status, 200, "Super admin without university should not be blocked");
    assert.equal(res2.data.user.id, superAdminNull.id);
  });

  test("1.5 POST /api/auth/login rejects login for users of suspended university", async () => {
    const user = await createTestUser({ universityId: suspendedUniId, role: "student" });

    const res = await apiRequest("/api/auth/login", {
      method: "POST",
      body: { email: user.email, password: "Password123!" },
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, "TENANT_SUSPENDED");
  });

  test("1.6 POST /api/auth/refresh rejects token refresh for users of suspended university", async () => {
    const user = await createTestUser({ universityId: suspendedUniId, role: "student" });
    const refreshToken = generateRefreshToken();
    const familyId = crypto.randomUUID();

    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '30 days')`,
      [user.id, hashToken(refreshToken), familyId]
    );

    const res = await apiRequest("/api/auth/refresh", {
      method: "POST",
      body: { refreshToken },
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, "TENANT_SUSPENDED");
  });

  test("1.7 Missing university association is rejected at both DB and middleware levels", async () => {
    // 1. Database-level check: DB constraint prevents creating non-superadmin without university_id
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO users (university_id, name, email, password_hash, role)
           VALUES (NULL, 'No Uni Student', 'nouni@test.edu.et', 'hash', 'student')`
        );
      },
      (err) => {
        assert.equal(err.code, "23514"); // check_violation
        assert.ok(err.message.includes("users_tenant_required_chk"));
        return true;
      }
    );

    // 2. Middleware-level check: requireAuth middleware rejects non-superadmin without university association
    const { requireAuth } = require("../src/middleware/auth");
    const middleware = requireAuth();

    // Mock request with non-superadmin user lacking university association
    const mockUserToken = signAccessToken({ id: crypto.randomUUID(), role: "student" });
    const mockReq = {
      headers: { authorization: `Bearer ${mockUserToken}` },
      query: {},
    };
    // Test the logic directly by simulating the requireAuth execution with user without university
    const originalQuery = db.query;
    try {
      db.query = async (sql, params) => {
        if (typeof sql === "string" && sql.includes("FROM users u")) {
          return {
            rows: [
              {
                id: crypto.randomUUID(),
                role: "student",
                suspended: false,
                email_verified: true,
                university_id: null,
                uni_id: null,
              },
            ],
          };
        }
        return originalQuery.call(db, sql, params);
      };

      const mockRes = {};
      let caughtError = null;
      await middleware(mockReq, mockRes, (err) => {
        caughtError = err;
      });

      assert.ok(caughtError, "Expected requireAuth to throw an error");
      assert.equal(caughtError.status, 403);
      assert.equal(caughtError.code, "TENANT_INVALID");
    } finally {
      db.query = originalQuery;
    }
  });
});

describe("Stage 2: Trusted Tenant Context & Header Spoofing", () => {
  test("2.1 Client sending spoofed X-University-Id header for different university is rejected (HTTP 403 TENANT_MISMATCH)", async () => {
    const user = await createTestUser({ universityId: activeUniId, role: "student" });
    const token = signAccessToken(user);

    // User is in activeUniId, but attempts to claim suspendedUniId in header
    const res = await apiRequest("/api/users/me", {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-University-Id": suspendedUniId,
      },
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, "TENANT_MISMATCH");
  });

  test("2.2 Client sending spoofed X-University-Slug header is rejected (HTTP 403 TENANT_MISMATCH)", async () => {
    const user = await createTestUser({ universityId: activeUniId, role: "student" });
    const token = signAccessToken(user);

    const res = await apiRequest("/api/users/me", {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-University-Slug": "different-campus-slug",
      },
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, "TENANT_MISMATCH");
  });

  test("2.3 Authenticated request without header derives tenant strictly from authenticated user record", async () => {
    const user = await createTestUser({ universityId: activeUniId, role: "student" });
    const token = signAccessToken(user);

    const res = await apiRequest("/api/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.user.university_id, activeUniId);
  });
});

describe("Stage 2: Registration & Domain Verification", () => {
  test("3.1 Registration with email matching primary university domain auto-assigns and verifies", async () => {
    const uniRes = await db.query("SELECT domain FROM universities WHERE id = $1", [activeUniId]);
    const domain = uniRes.rows[0].domain;
    const email = `student_${Date.now()}@${domain}`;

    const res = await apiRequest("/api/auth/register", {
      method: "POST",
      body: {
        name: "Auto Domain Student",
        email,
        password: "Password123!",
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.data.user.university_id, activeUniId);
    assert.equal(res.data.user.verified, true);
    createdUserIds.push(res.data.user.id);
  });

  test("3.2 Registration with email matching alias in permitted_domains auto-assigns and verifies", async () => {
    const uniRes = await db.query("SELECT permitted_domains FROM universities WHERE id = $1", [activeUniId]);
    const aliasDomain = uniRes.rows[0].permitted_domains[1]; // e.g. staff.stage2-active...
    assert.ok(aliasDomain, "Expected secondary permitted domain");
    const email = `staff_${Date.now()}@${aliasDomain}`;

    const res = await apiRequest("/api/auth/register", {
      method: "POST",
      body: {
        name: "Staff Domain Student",
        email,
        password: "Password123!",
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.data.user.university_id, activeUniId);
    assert.equal(res.data.user.verified, true);
    createdUserIds.push(res.data.user.id);
  });

  test("3.3 Registration with campus domain but conflicting universityId is rejected (HTTP 400 UNIVERSITY_MISMATCH)", async () => {
    const uniRes = await db.query("SELECT domain FROM universities WHERE id = $1", [activeUniId]);
    const domain = uniRes.rows[0].domain;
    const email = `mismatch_${Date.now()}@${domain}`;

    const res = await apiRequest("/api/auth/register", {
      method: "POST",
      body: {
        name: "Mismatch Student",
        email,
        password: "Password123!",
        universityId: suspendedUniId, // Mismatched university ID!
      },
    });

    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, "UNIVERSITY_MISMATCH");
  });

  test("3.4 Registration under a suspended university domain is rejected (HTTP 403 TENANT_SUSPENDED)", async () => {
    const uniRes = await db.query("SELECT domain FROM universities WHERE id = $1", [suspendedUniId]);
    const domain = uniRes.rows[0].domain;
    const email = `suspended_user_${Date.now()}@${domain}`;

    const res = await apiRequest("/api/auth/register", {
      method: "POST",
      body: {
        name: "Suspended Uni Student",
        email,
        password: "Password123!",
      },
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, "TENANT_SUSPENDED");
  });

  test("3.5 Generic email registration without universityId is rejected (HTTP 400 UNIVERSITY_REQUIRED)", async () => {
    const res = await apiRequest("/api/auth/register", {
      method: "POST",
      body: {
        name: "Generic Email Student",
        email: `generic_${Date.now()}@gmail.com`,
        password: "Password123!",
      },
    });

    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, "UNIVERSITY_REQUIRED");
  });

  test("3.6 Generic email registration with active universityId creates unverified account with manual_pending", async () => {
    const res = await apiRequest("/api/auth/register", {
      method: "POST",
      body: {
        name: "Generic Email Student",
        email: `generic_valid_${Date.now()}@gmail.com`,
        password: "Password123!",
        universityId: activeUniId,
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.data.user.university_id, activeUniId);
    assert.equal(res.data.user.verified, false);
    createdUserIds.push(res.data.user.id);
  });

  test("3.7 Generic email registration targeting suspended universityId is rejected (HTTP 403 TENANT_SUSPENDED)", async () => {
    const res = await apiRequest("/api/auth/register", {
      method: "POST",
      body: {
        name: "Generic Email Student",
        email: `generic_susp_${Date.now()}@gmail.com`,
        password: "Password123!",
        universityId: suspendedUniId,
      },
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, "TENANT_SUSPENDED");
  });
});

describe("Stage 2: Profile Update Tampering Protection", () => {
  test("4.1 User attempting to modify role via PATCH /api/users/me is rejected (HTTP 403 PROTECTED_FIELD)", async () => {
    const user = await createTestUser({ universityId: activeUniId, role: "student" });
    const token = signAccessToken(user);

    const res = await apiRequest("/api/users/me", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: { role: "admin" },
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, "PROTECTED_FIELD");
  });

  test("4.2 User attempting to modify university affiliation (camelCase and snake_case) is rejected", async () => {
    const user = await createTestUser({ universityId: activeUniId, role: "student" });
    const token = signAccessToken(user);

    // camelCase
    const res1 = await apiRequest("/api/users/me", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: { universityId: suspendedUniId },
    });
    assert.equal(res1.status, 403);
    assert.equal(res1.data.error.code, "PROTECTED_FIELD");

    // snake_case
    const res2 = await apiRequest("/api/users/me", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: { university_id: suspendedUniId },
    });
    assert.equal(res2.status, 403);
    assert.equal(res2.data.error.code, "PROTECTED_FIELD");
  });

  test("4.3 User attempting to modify verification status or method is rejected", async () => {
    const user = await createTestUser({ universityId: activeUniId, role: "student" });
    const token = signAccessToken(user);

    for (const body of [
      { verified: true },
      { verificationMethod: "domain" },
      { verification_method: "domain" },
      { emailVerified: true },
      { email_verified: true },
    ]) {
      const res = await apiRequest("/api/users/me", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
        body,
      });
      assert.equal(res.status, 403, `Failed to reject protected field in ${JSON.stringify(body)}`);
      assert.equal(res.data.error.code, "PROTECTED_FIELD");
    }
  });

  test("4.4 User attempting to modify account id or suspension status is rejected", async () => {
    const user = await createTestUser({ universityId: activeUniId, role: "student" });
    const token = signAccessToken(user);

    for (const body of [{ id: crypto.randomUUID() }, { suspended: false }]) {
      const res = await apiRequest("/api/users/me", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
        body,
      });
      assert.equal(res.status, 403, `Failed to reject protected field in ${JSON.stringify(body)}`);
      assert.equal(res.data.error.code, "PROTECTED_FIELD");
    }
  });

  test("4.5 Legitimate profile updates to non-protected fields succeed", async () => {
    const user = await createTestUser({ universityId: activeUniId, role: "student" });
    const token = signAccessToken(user);

    const res = await apiRequest("/api/users/me", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: {
        name: "Updated Full Name",
        bio: "Updated student bio",
        department: "Computer Science",
      },
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.user.name, "Updated Full Name");
    assert.equal(res.data.user.bio, "Updated student bio");
    assert.equal(res.data.user.department, "Computer Science");
  });
});

describe("Stage 2: University Admin Scoping and Authorization", () => {
  test("5.1 University admin from University A cannot access or update user from University B", async () => {
    // Admin for activeUniId
    const adminA = await createTestUser({ universityId: activeUniId, role: "admin" });
    const tokenA = signAccessToken(adminA);

    // Create a 2nd active university and a user in it
    const uniBRes = await db.query(
      `INSERT INTO universities (name, slug, domain, permitted_domains, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING id`,
      [
        "Stage 2 University B",
        `stage2-b-${Date.now()}`,
        `stage2-b-${Date.now()}.edu.et`,
        [`stage2-b-${Date.now()}.edu.et`],
      ]
    );
    const uniBId = uniBRes.rows[0].id;
    createdUniIds.push(uniBId);

    const userB = await createTestUser({ universityId: uniBId, role: "student" });

    // Admin A tries to fetch User B
    const getRes = await apiRequest(`/api/admin/users/${userB.id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(getRes.status, 404, "Admin A must not be able to fetch User B");

    // Admin A tries to suspend User B
    const patchRes = await apiRequest(`/api/admin/users/${userB.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${tokenA}` },
      body: { suspended: true },
    });
    assert.equal(patchRes.status, 404, "Admin A must not be able to modify User B");
  });

  test("5.2 University admin cannot self-promote to admin via PATCH /api/admin/users/:id", async () => {
    const admin = await createTestUser({ universityId: activeUniId, role: "admin" });
    const token = signAccessToken(admin);

    const res = await apiRequest(`/api/admin/users/${admin.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: { role: "admin" },
    });

    assert.equal(res.status, 400);
  });
});
