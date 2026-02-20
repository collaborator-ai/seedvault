/**
 * Integration tests for authentication, access control,
 * admin operations, invite system, and input validation.
 *
 * Runs the server in-process (Bun.serve + createApp), then exercises
 * the API via raw fetch and the typed client.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { initDb } from "../server/src/db.js";
import { createApp } from "../server/src/routes.js";
import {
  createClient,
  type SeedvaultClient,
  ApiError,
} from "../sdk/src/index.js";

let server: ReturnType<typeof Bun.serve>;
let serverDataDir: string;
let baseUrl: string;
let adminClient: SeedvaultClient;
let adminUsername: string;
let adminToken: string;

beforeAll(async () => {
  serverDataDir = mkdtempSync(join(tmpdir(), "sv-auth-test-"));
  initDb(join(serverDataDir, "test.db"));
  const app = createApp();
  server = Bun.serve({ port: 0, fetch: app.fetch });
  baseUrl = `http://localhost:${server.port}`;

  // First signup becomes admin
  const res = await fetch(`${baseUrl}/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "admin-user" }),
  });
  const data = (await res.json()) as {
    contributor: { username: string };
    token: string;
  };
  adminUsername = data.contributor.username;
  adminToken = data.token;
  adminClient = createClient(baseUrl, data.token);
});

afterAll(async () => {
  if (server) server.stop(true);
  await rm(serverDataDir, { recursive: true, force: true }).catch(() => {});
});

/**
 * Helper: create a second user via the invite flow.
 * Returns the client, username, and raw token.
 */
async function createInvitedUser(
  name: string,
): Promise<{ client: SeedvaultClient; username: string; token: string }> {
  const { invite } = await adminClient.createInvite();
  const res = await fetch(`${baseUrl}/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, invite }),
  });
  const data = (await res.json()) as {
    contributor: { username: string };
    token: string;
  };
  return {
    client: createClient(baseUrl, data.token),
    username: data.contributor.username,
    token: data.token,
  };
}

// -------------------------------------------------------------------------
// 1. Authentication — 401 errors
// -------------------------------------------------------------------------

describe("authentication", () => {
  test("no auth header returns 401 on GET /v1/me", async () => {
    const res = await fetch(`${baseUrl}/v1/me`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Missing or invalid Authorization header");
  });

  test("invalid token returns 401 on GET /v1/me", async () => {
    const res = await fetch(`${baseUrl}/v1/me`, {
      headers: { Authorization: "Bearer sv_0000000000000000000000000000dead" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid token");
  });

  test("malformed Authorization header (no Bearer prefix) returns 401", async () => {
    const res = await fetch(`${baseUrl}/v1/me`, {
      headers: { Authorization: adminToken },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Missing or invalid Authorization header");
  });
});

// -------------------------------------------------------------------------
// 2. Access control — file ownership (403 errors)
// -------------------------------------------------------------------------

describe("access control — file ownership", () => {
  let userB: { client: SeedvaultClient; username: string; token: string };

  beforeAll(async () => {
    userB = await createInvitedUser("user-b");
    // Seed a file under user B so we can test cross-user reads
    await userB.client.putFile(userB.username, "shared/note.md", "# Public\n");
  });

  test("user B cannot PUT a file to user A's path", async () => {
    const res = await fetch(
      `${baseUrl}/v1/files/${adminUsername}/stolen.md`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${userB.token}`,
          "Content-Type": "text/markdown",
        },
        body: "# Hacked\n",
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("You can only write to your own contributor");
  });

  test("user B cannot DELETE a file from user A's path", async () => {
    // First create a file under admin so there's something to try deleting
    await adminClient.putFile(adminUsername, "protected.md", "# Keep\n");

    const res = await fetch(
      `${baseUrl}/v1/files/${adminUsername}/protected.md`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${userB.token}` },
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("You can only delete from your own contributor");
  });

  test("user A can read user B's files", async () => {
    const content = await adminClient.getFile(
      userB.username,
      "shared/note.md",
    );
    expect(content).toBe("# Public\n");
  });
});

// -------------------------------------------------------------------------
// 3. Admin operations
// -------------------------------------------------------------------------

describe("admin operations", () => {
  let regularUser: {
    client: SeedvaultClient;
    username: string;
    token: string;
  };

  beforeAll(async () => {
    regularUser = await createInvitedUser("regular-admin-test");
  });

  test("non-admin cannot create invites", async () => {
    const res = await fetch(`${baseUrl}/v1/invites`, {
      method: "POST",
      headers: { Authorization: `Bearer ${regularUser.token}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Only the admin can generate invite codes");
  });

  test("non-admin cannot delete a contributor", async () => {
    const res = await fetch(
      `${baseUrl}/v1/contributors/${adminUsername}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${regularUser.token}` },
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Only the admin can delete contributors");
  });

  test("admin cannot delete self", async () => {
    const err = await adminClient
      .deleteContributor(adminUsername)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("Cannot delete yourself");
  });

  test("admin deletes another contributor", async () => {
    const victim = await createInvitedUser("to-be-deleted");
    // Verify the user exists first
    const { contributors } = await adminClient.listContributors();
    expect(
      contributors.some((c) => c.username === victim.username),
    ).toBe(true);

    await adminClient.deleteContributor(victim.username);

    const after = await adminClient.listContributors();
    expect(
      after.contributors.some((c) => c.username === victim.username),
    ).toBe(false);
  });

  test("admin deletes nonexistent contributor returns 404", async () => {
    const err = await adminClient
      .deleteContributor("ghost-user")
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("Contributor not found");
  });
});

// -------------------------------------------------------------------------
// 4. Invite system
// -------------------------------------------------------------------------

describe("invite system", () => {
  test("first user (admin) doesn't need invite", () => {
    // The admin was created in beforeAll without an invite code.
    // If it had failed we wouldn't have gotten this far.
    expect(adminUsername).toBe("admin-user");
  });

  test("second user without invite returns 400", async () => {
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-invite-user" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invite code is required");
  });

  test("second user with invalid invite code returns 400", async () => {
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bad-invite-user", invite: "bogus123" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid invite code");
  });

  test("admin creates invite, second user signs up with it", async () => {
    const { invite } = await adminClient.createInvite();
    expect(invite).toBeDefined();
    expect(typeof invite).toBe("string");

    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "invited-user", invite }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      contributor: { username: string };
      token: string;
    };
    expect(data.contributor.username).toBe("invited-user");
    expect(data.token).toBeDefined();
  });

  test("reusing an invite code returns 400", async () => {
    const { invite } = await adminClient.createInvite();

    // First use succeeds
    const res1 = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "first-use", invite }),
    });
    expect(res1.status).toBe(201);

    // Second use fails
    const res2 = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "second-use", invite }),
    });
    expect(res2.status).toBe(400);
    const body = (await res2.json()) as { error: string };
    expect(body.error).toBe("Invite code has already been used");
  });

  test("duplicate username returns 409", async () => {
    const { invite } = await adminClient.createInvite();
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: adminUsername, invite }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      "A contributor with that username already exists",
    );
  });
});

// -------------------------------------------------------------------------
// 5. Signup validation
// -------------------------------------------------------------------------

describe("signup validation", () => {
  test("empty name returns 400", async () => {
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("name is required");
  });

  test("invalid username format (UPPERCASE) returns 400", async () => {
    const { invite } = await adminClient.createInvite();
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "UPPERCASE", invite }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("lowercase alphanumeric");
  });

  test("valid username returns 201 with token", async () => {
    const { invite } = await adminClient.createInvite();
    const res = await fetch(`${baseUrl}/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "valid-user-99", invite }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      contributor: { username: string };
      token: string;
    };
    expect(data.token).toBeDefined();
    expect(data.token.startsWith("sv_")).toBe(true);
  });
});

// -------------------------------------------------------------------------
// 6. Path validation via API
// -------------------------------------------------------------------------

describe("path validation via API", () => {
  test("path not ending in .md returns 400", async () => {
    const res = await fetch(
      `${baseUrl}/v1/files/${adminUsername}/notes/file.txt`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "text/markdown",
        },
        body: "# Not markdown ext\n",
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Path must end in .md");
  });

  test("path containing backslash returns 400", async () => {
    const res = await fetch(
      `${baseUrl}/v1/files/${adminUsername}/notes%5Cfile.md`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "text/markdown",
        },
        body: "# Backslash\n",
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Path cannot contain backslashes");
  });

  test("path containing // returns 400", async () => {
    const res = await fetch(
      `${baseUrl}/v1/files/${adminUsername}/notes//file.md`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "text/markdown",
        },
        body: "# Double slash\n",
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("double slashes");
  });

  test("path containing .. is rejected by validatePath", async () => {
    // HTTP clients normalize ".." segments per the URL spec, so we
    // cannot send a literal ".." via fetch. Test the validation
    // function directly to verify the server-side guard.
    const { validatePath } = await import("../server/src/db.js");
    const err = validatePath("notes/../secret.md");
    expect(err).toBe("Path cannot contain . or .. segments");
  });

  test("path starting with / returns 400", async () => {
    // URL-encode the leading slash in the file path portion
    const res = await fetch(
      `${baseUrl}/v1/files/${adminUsername}/%2Ffile.md`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "text/markdown",
        },
        body: "# Leading slash\n",
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Path cannot start with /");
  });
});

// -------------------------------------------------------------------------
// 7. File size limit
// -------------------------------------------------------------------------

describe("file size limit", () => {
  test("content over 10MB returns 413", async () => {
    const oversized = "x".repeat(10 * 1024 * 1024 + 1);
    const err = await adminClient
      .putFile(adminUsername, "huge.md", oversized)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(413);
  });
});

// -------------------------------------------------------------------------
// 8. Search and listing validation
// -------------------------------------------------------------------------

describe("search and listing validation", () => {
  test("GET /v1/search without q param returns 400", async () => {
    const res = await fetch(`${baseUrl}/v1/search`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("q parameter is required");
  });

  test("GET /v1/files without prefix param returns 400", async () => {
    const res = await fetch(`${baseUrl}/v1/files`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("prefix query parameter is required");
  });

  test("GET /v1/search with nonexistent contributor returns 404", async () => {
    const res = await fetch(
      `${baseUrl}/v1/search?q=hello&contributor=nonexistent-person`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Contributor not found");
  });

  test("GET /v1/files with nonexistent contributor prefix returns 404", async () => {
    const res = await fetch(
      `${baseUrl}/v1/files?prefix=${encodeURIComponent("nonexistent-person/")}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Contributor not found");
  });
});
