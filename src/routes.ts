import { Hono } from "hono";
import {
  createBank,
  createApiKey,
  createInvite,
  getInvite,
  markInviteUsed,
  getBankById,
  getBankByName,
  hasAnyBank,
  listBanks,
} from "./db.js";
import {
  generateToken,
  hashToken,
  authMiddleware,
  getAuthCtx,
} from "./auth.js";
import {
  validatePath,
  writeFileAtomic,
  deleteFile,
  readFileContent,
  listFiles,
  ensureBankDir,
  FileNotFoundError,
  FileTooLargeError,
} from "./storage.js";
import { broadcast, addClient, removeClient } from "./sse.js";
import * as qmd from "./qmd.js";

export function createApp(storageRoot: string): Hono {
  const app = new Hono();

  // --- Health (no auth) ---

  app.get("/health", (c) => {
    return c.json({ status: "ok" });
  });

  // --- Signup (no auth) ---

  app.post("/v1/signup", async (c) => {
    const body = await c.req.json<{ name?: string; invite?: string }>();

    if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
      return c.json({ error: "name is required" }, 400);
    }

    const name = body.name.trim();
    const isFirstUser = !hasAnyBank();

    // Validate invite (required unless first user)
    if (!isFirstUser) {
      if (!body.invite) {
        return c.json({ error: "Invite code is required" }, 400);
      }
      const invite = getInvite(body.invite);
      if (!invite) {
        return c.json({ error: "Invalid invite code" }, 400);
      }
      if (invite.used_at) {
        return c.json({ error: "Invite code has already been used" }, 400);
      }
    }

    // Check name uniqueness
    if (getBankByName(name)) {
      return c.json({ error: "A bank with that name already exists" }, 409);
    }

    // Create bank
    const bank = createBank(name, isFirstUser);
    await ensureBankDir(storageRoot, bank.id);

    // Register as QMD collection
    qmd.addCollection(storageRoot, bank).catch((e) =>
      console.error("Failed to register QMD collection:", e)
    );

    // Create token
    const rawToken = generateToken();
    createApiKey(hashToken(rawToken), `${name}-default`, bank.id);

    // Mark invite as used
    if (!isFirstUser && body.invite) {
      markInviteUsed(body.invite, bank.id);
    }

    return c.json(
      {
        bank: {
          id: bank.id,
          name: bank.name,
          createdAt: bank.created_at,
        },
        token: rawToken,
      },
      201
    );
  });

  // --- All routes below require auth ---

  const authed = new Hono();
  authed.use("*", authMiddleware);

  // --- Invites ---

  authed.post("/v1/invites", (c) => {
    const { bank } = getAuthCtx(c);

    if (!bank.is_operator) {
      return c.json({ error: "Only the operator can generate invite codes" }, 403);
    }

    const invite = createInvite(bank.id);
    return c.json(
      {
        invite: invite.id,
        createdAt: invite.created_at,
      },
      201
    );
  });

  // --- Banks ---

  authed.get("/v1/banks", (c) => {
    const banks = listBanks();
    return c.json({
      banks: banks.map((b) => ({
        id: b.id,
        name: b.name,
        createdAt: b.created_at,
      })),
    });
  });

  // --- File Write ---

  authed.put("/v1/banks/:bankId/files/*", async (c) => {
    const { bank } = getAuthCtx(c);
    const bankId = c.req.param("bankId");

    if (bank.id !== bankId) {
      return c.json({ error: "You can only write to your own bank" }, 403);
    }

    // Verify bank exists
    if (!getBankById(bankId)) {
      return c.json({ error: "Bank not found" }, 404);
    }

    const filePath = c.req.path.replace(`/v1/banks/${bankId}/files/`, "");
    const pathError = validatePath(filePath);
    if (pathError) {
      return c.json({ error: pathError }, 400);
    }

    const content = await c.req.text();

    try {
      const result = await writeFileAtomic(storageRoot, bankId, filePath, content);

      broadcast("file_updated", {
        bank: bankId,
        path: result.path,
        size: result.size,
        modifiedAt: result.modifiedAt,
      });

      // Trigger QMD re-index (async, doesn't block response)
      qmd.triggerUpdate();

      return c.json(result);
    } catch (e) {
      if (e instanceof FileTooLargeError) {
        return c.json({ error: e.message }, 413);
      }
      throw e;
    }
  });

  // --- File Delete ---

  authed.delete("/v1/banks/:bankId/files/*", async (c) => {
    const { bank } = getAuthCtx(c);
    const bankId = c.req.param("bankId");

    if (bank.id !== bankId) {
      return c.json({ error: "You can only delete from your own bank" }, 403);
    }

    const filePath = c.req.path.replace(`/v1/banks/${bankId}/files/`, "");
    const pathError = validatePath(filePath);
    if (pathError) {
      return c.json({ error: pathError }, 400);
    }

    try {
      await deleteFile(storageRoot, bankId, filePath);

      broadcast("file_deleted", {
        bank: bankId,
        path: filePath,
      });

      // Trigger QMD re-index (async, doesn't block response)
      qmd.triggerUpdate();

      return c.body(null, 204);
    } catch (e) {
      if (e instanceof FileNotFoundError) {
        return c.json({ error: "File not found" }, 404);
      }
      throw e;
    }
  });

  // --- File List ---

  authed.get("/v1/banks/:bankId/files", async (c) => {
    const bankId = c.req.param("bankId");

    if (!getBankById(bankId)) {
      return c.json({ error: "Bank not found" }, 404);
    }

    const prefix = c.req.query("prefix") || undefined;
    const files = await listFiles(storageRoot, bankId, prefix);
    return c.json({ files });
  });

  // --- File Read ---

  authed.get("/v1/banks/:bankId/files/*", async (c) => {
    const bankId = c.req.param("bankId");

    if (!getBankById(bankId)) {
      return c.json({ error: "Bank not found" }, 404);
    }

    const filePath = c.req.path.replace(`/v1/banks/${bankId}/files/`, "");
    const pathError = validatePath(filePath);
    if (pathError) {
      return c.json({ error: pathError }, 400);
    }

    try {
      const content = await readFileContent(storageRoot, bankId, filePath);
      return c.text(content, 200, {
        "Content-Type": "text/markdown",
      });
    } catch (e) {
      if (e instanceof FileNotFoundError) {
        return c.json({ error: "File not found" }, 404);
      }
      throw e;
    }
  });

  // --- SSE Events ---

  authed.get("/v1/events", (c) => {
    const stream = new ReadableStream({
      start(controller) {
        addClient(controller);

        // Send initial connected event
        const msg = `event: connected\ndata: {}\n\n`;
        controller.enqueue(new TextEncoder().encode(msg));
      },
      cancel(controller) {
        removeClient(controller);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  // --- Search (proxy to QMD) ---

  authed.get("/v1/search", async (c) => {
    const q = c.req.query("q");
    if (!q) {
      return c.json({ error: "q parameter is required" }, 400);
    }

    const collection = c.req.query("bank") || undefined;
    const limit = parseInt(c.req.query("limit") || "10", 10);

    const results = await qmd.search(q, { collection, limit });
    return c.json({ results });
  });

  // Mount authed routes
  app.route("/", authed);

  return app;
}
