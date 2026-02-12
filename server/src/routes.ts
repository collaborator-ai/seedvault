import { Hono } from "hono";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
	createContributor,
	createApiKey,
	createInvite,
	getInvite,
	markInviteUsed,
	getContributor,
	validateUsername,
	hasAnyContributor,
	listContributors,
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
	listFiles,
	ensureContributorDir,
	FileNotFoundError,
	FileTooLargeError,
} from "./storage.js";
import { broadcast, addClient, removeClient } from "./sse.js";
import * as qmd from "./qmd.js";
import { executeCommand, ShellValidationError } from "./shell.js";

const uiPath = resolve(import.meta.dirname, "index.html");
const isDev = process.env.NODE_ENV !== "production";
const uiHtmlCached = readFileSync(uiPath, "utf-8");

/**
 * Extract username and file path from a /v1/files/* request path.
 * "/v1/files/yiliu/notes/seedvault.md" → { username: "yiliu", filePath: "notes/seedvault.md" }
 */
function extractFileInfo(reqPath: string): { username: string; filePath: string } | null {
	const raw = reqPath.replace("/v1/files/", "");
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return null;
	}
	const slashIdx = decoded.indexOf("/");
	if (slashIdx === -1) return null;
	return {
		username: decoded.slice(0, slashIdx),
		filePath: decoded.slice(slashIdx + 1),
	};
}

export function createApp(storageRoot: string): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		return c.html(isDev ? readFileSync(uiPath, "utf-8") : uiHtmlCached);
	});

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

		const username = body.name.trim();

		const usernameError = validateUsername(username);
		if (usernameError) {
			return c.json({ error: usernameError }, 400);
		}

		const isFirstUser = !hasAnyContributor();

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

		// Check username uniqueness
		if (getContributor(username)) {
			return c.json({ error: "A contributor with that username already exists" }, 409);
		}

		// Create contributor
		const contributor = createContributor(username, isFirstUser);
		await ensureContributorDir(storageRoot, contributor.username);

		// Register as QMD collection
		qmd.addCollection(storageRoot, contributor).catch((e) =>
			console.error("Failed to register QMD collection:", e)
		);

		// Create token
		const rawToken = generateToken();
		createApiKey(hashToken(rawToken), `${username}-default`, contributor.username);

		// Mark invite as used
		if (!isFirstUser && body.invite) {
			markInviteUsed(body.invite, contributor.username);
		}

		return c.json(
			{
				contributor: {
					username: contributor.username,
					createdAt: contributor.created_at,
				},
				token: rawToken,
			},
			201
		);
	});

	// --- All routes below require auth ---

	const authed = new Hono();
	authed.use("*", authMiddleware);

	// --- Me (token → username lookup) ---

	authed.get("/v1/me", (c) => {
		const { contributor } = getAuthCtx(c);
		return c.json({
			username: contributor.username,
			createdAt: contributor.created_at,
		});
	});

	// --- Invites ---

	authed.post("/v1/invites", (c) => {
		const { contributor } = getAuthCtx(c);

		if (!contributor.is_operator) {
			return c.json({ error: "Only the operator can generate invite codes" }, 403);
		}

		const invite = createInvite(contributor.username);
		return c.json(
			{
				invite: invite.id,
				createdAt: invite.created_at,
			},
			201
		);
	});

	// --- Contributors ---

	authed.get("/v1/contributors", (c) => {
		const contributors = listContributors();
		return c.json({
			contributors: contributors.map((b) => ({
				username: b.username,
				createdAt: b.created_at,
			})),
		});
	});

	// --- Shell passthrough ---

	authed.post("/v1/sh", async (c) => {
		const body = await c.req.json<{ cmd?: string }>();
		if (!body.cmd || typeof body.cmd !== "string") {
			return c.json({ error: "cmd is required" }, 400);
		}

		try {
			const result = await executeCommand(body.cmd, storageRoot);
			return new Response(result.stdout, {
				status: 200,
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					"X-Exit-Code": String(result.exitCode),
					"X-Stderr": encodeURIComponent(result.stderr),
				},
			});
		} catch (e) {
			if (e instanceof ShellValidationError) {
				return c.json({ error: e.message }, 400);
			}
			throw e;
		}
	});

	// --- File Write (new path) ---

	authed.put("/v1/files/*", async (c) => {
		const { contributor } = getAuthCtx(c);
		const parsed = extractFileInfo(c.req.path);

		if (!parsed) {
			return c.json({ error: "Invalid file path" }, 400);
		}

		if (contributor.username !== parsed.username) {
			return c.json({ error: "You can only write to your own contributor" }, 403);
		}

		if (!getContributor(parsed.username)) {
			return c.json({ error: "Contributor not found" }, 404);
		}

		const pathError = validatePath(parsed.filePath);
		if (pathError) {
			return c.json({ error: pathError }, 400);
		}

		const content = await c.req.text();

		try {
			const result = await writeFileAtomic(storageRoot, parsed.username, parsed.filePath, content);

			broadcast("file_updated", {
				contributor: parsed.username,
				path: result.path,
				size: result.size,
				modifiedAt: result.modifiedAt,
			});

			qmd.triggerUpdate();

			return c.json(result);
		} catch (e) {
			if (e instanceof FileTooLargeError) {
				return c.json({ error: e.message }, 413);
			}
			throw e;
		}
	});

	// --- File Delete (new path) ---

	authed.delete("/v1/files/*", async (c) => {
		const { contributor } = getAuthCtx(c);
		const parsed = extractFileInfo(c.req.path);

		if (!parsed) {
			return c.json({ error: "Invalid file path" }, 400);
		}

		if (contributor.username !== parsed.username) {
			return c.json({ error: "You can only delete from your own contributor" }, 403);
		}

		const pathError = validatePath(parsed.filePath);
		if (pathError) {
			return c.json({ error: pathError }, 400);
		}

		try {
			await deleteFile(storageRoot, parsed.username, parsed.filePath);

			broadcast("file_deleted", {
				contributor: parsed.username,
				path: parsed.filePath,
			});

			qmd.triggerUpdate();

			return c.body(null, 204);
		} catch (e) {
			if (e instanceof FileNotFoundError) {
				return c.json({ error: "File not found" }, 404);
			}
			throw e;
		}
	});

	// --- Structured File Listing (for syncer) ---

	authed.get("/v1/files", async (c) => {
		const prefix = c.req.query("prefix") || "";
		if (!prefix) {
			return c.json({ error: "prefix query parameter is required" }, 400);
		}

		// Extract username from prefix (first path segment)
		const slashIdx = prefix.indexOf("/");
		const username = slashIdx === -1 ? prefix : prefix.slice(0, slashIdx);
		const subPrefix = slashIdx === -1 ? undefined : prefix.slice(slashIdx + 1) || undefined;

		if (!getContributor(username)) {
			return c.json({ error: "Contributor not found" }, 404);
		}

		const files = await listFiles(storageRoot, username, subPrefix);
		// Return full paths (username-prefixed)
		return c.json({
			files: files.map((f) => ({
				...f,
				path: `${username}/${f.path}`,
			})),
		});
	});

	// --- SSE Events ---

	authed.get("/v1/events", (c) => {
		let ctrl: ReadableStreamDefaultController;
		let heartbeat: ReturnType<typeof setInterval>;
		const stream = new ReadableStream({
			start(controller) {
				ctrl = controller;
				addClient(controller);

				// Send initial connected event
				const msg = `event: connected\ndata: {}\n\n`;
				controller.enqueue(new TextEncoder().encode(msg));

				// Send keepalive comment every 30s to prevent proxy timeouts
				heartbeat = setInterval(() => {
					try {
						controller.enqueue(new TextEncoder().encode(":keepalive\n\n"));
					} catch {
						clearInterval(heartbeat);
					}
				}, 30_000);
			},
			cancel() {
				clearInterval(heartbeat);
				removeClient(ctrl);
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

		const contributorParam = c.req.query("contributor") || undefined;
		const limit = parseInt(c.req.query("limit") || "10", 10);

		// Resolve contributor param to QMD collection name
		let collectionName: string | undefined;
		if (contributorParam) {
			const contributor = getContributor(contributorParam);
			if (!contributor) {
				return c.json({ error: "Contributor not found" }, 404);
			}
			collectionName = contributor.username;
		}

		const results = await qmd.search(q, { collection: collectionName, limit });
		return c.json({ results });
	});

	// Mount authed routes
	app.route("/", authed);

	return app;
}
