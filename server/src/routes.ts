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
	readFileContent,
	listFiles,
	ensureContributorDir,
	FileNotFoundError,
	FileTooLargeError,
} from "./storage.js";
import { broadcast, addClient, removeClient } from "./sse.js";
import * as qmd from "./qmd.js";

const uiPath = resolve(import.meta.dirname, "index.html");
const isDev = process.env.NODE_ENV !== "production";
const uiHtmlCached = readFileSync(uiPath, "utf-8");

/** Extract and decode the file path from a wildcard route */
function extractFilePath(reqPath: string, username: string): string | null {
	const raw = reqPath.replace(`/v1/contributors/${username}/files/`, "");
	try {
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
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

	// --- File Write ---

	authed.put("/v1/contributors/:username/files/*", async (c) => {
		const { contributor } = getAuthCtx(c);
		const username = c.req.param("username");

		if (contributor.username !== username) {
			return c.json({ error: "You can only write to your own contributor" }, 403);
		}

		// Verify contributor exists
		if (!getContributor(username)) {
			return c.json({ error: "Contributor not found" }, 404);
		}

		const filePath = extractFilePath(c.req.path, username);
		if (filePath === null) {
			return c.json({ error: "Invalid URL encoding in path" }, 400);
		}
		const pathError = validatePath(filePath);
		if (pathError) {
			return c.json({ error: pathError }, 400);
		}

		const content = await c.req.text();

		try {
			const result = await writeFileAtomic(storageRoot, username, filePath, content);

			broadcast("file_updated", {
				contributor: username,
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

	authed.delete("/v1/contributors/:username/files/*", async (c) => {
		const { contributor } = getAuthCtx(c);
		const username = c.req.param("username");

		if (contributor.username !== username) {
			return c.json({ error: "You can only delete from your own contributor" }, 403);
		}

		const filePath = extractFilePath(c.req.path, username);
		if (filePath === null) {
			return c.json({ error: "Invalid URL encoding in path" }, 400);
		}
		const pathError = validatePath(filePath);
		if (pathError) {
			return c.json({ error: pathError }, 400);
		}

		try {
			await deleteFile(storageRoot, username, filePath);

			broadcast("file_deleted", {
				contributor: username,
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

	authed.get("/v1/contributors/:username/files", async (c) => {
		const username = c.req.param("username");

		if (!getContributor(username)) {
			return c.json({ error: "Contributor not found" }, 404);
		}

		const prefix = c.req.query("prefix") || undefined;
		const files = await listFiles(storageRoot, username, prefix);
		return c.json({ files });
	});

	// --- File Read ---

	authed.get("/v1/contributors/:username/files/*", async (c) => {
		const username = c.req.param("username");

		if (!getContributor(username)) {
			return c.json({ error: "Contributor not found" }, 404);
		}

		const filePath = extractFilePath(c.req.path, username);
		if (filePath === null) {
			return c.json({ error: "Invalid URL encoding in path" }, 400);
		}
		const pathError = validatePath(filePath);
		if (pathError) {
			return c.json({ error: pathError }, 400);
		}

		try {
			const content = await readFileContent(storageRoot, username, filePath);
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
		let ctrl: ReadableStreamDefaultController;
		const stream = new ReadableStream({
			start(controller) {
				ctrl = controller;
				addClient(controller);

				// Send initial connected event
				const msg = `event: connected\ndata: {}\n\n`;
				controller.enqueue(new TextEncoder().encode(msg));
			},
			cancel() {
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
