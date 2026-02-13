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
	validatePath,
	hasAnyContributor,
	listContributors,
	upsertItem,
	getItem,
	listItems,
	deleteItem,
	searchItems,
	ItemTooLargeError,
} from "./db.js";
import {
	generateToken,
	hashToken,
	authMiddleware,
	getAuthCtx,
} from "./auth.js";
import { broadcast, addClient, removeClient } from "./sse.js";

const uiPath = resolve(import.meta.dirname, "index.html");
const isDev = process.env.NODE_ENV !== "production";
const uiHtmlCached = readFileSync(uiPath, "utf-8");

/**
 * Extract username and file path from a /v1/files/* request path.
 * "/v1/files/yiliu/notes/seedvault.md" → { username: "yiliu", filePath: "notes/seedvault.md" }
 */
function extractFileInfo(
	reqPath: string
): { username: string; filePath: string } | null {
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

export function createApp(): Hono {
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

		if (
			!body.name ||
			typeof body.name !== "string" ||
			body.name.trim().length === 0
		) {
			return c.json({ error: "name is required" }, 400);
		}

		const username = body.name.trim();

		const usernameError = validateUsername(username);
		if (usernameError) {
			return c.json({ error: usernameError }, 400);
		}

		const isFirstUser = !hasAnyContributor();

		if (!isFirstUser) {
			if (!body.invite) {
				return c.json({ error: "Invite code is required" }, 400);
			}
			const invite = getInvite(body.invite);
			if (!invite) {
				return c.json({ error: "Invalid invite code" }, 400);
			}
			if (invite.used_at) {
				return c.json(
					{ error: "Invite code has already been used" },
					400
				);
			}
		}

		if (getContributor(username)) {
			return c.json(
				{ error: "A contributor with that username already exists" },
				409
			);
		}

		const contributor = createContributor(username, isFirstUser);

		const rawToken = generateToken();
		createApiKey(
			hashToken(rawToken),
			`${username}-default`,
			contributor.username
		);

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

		if (!contributor.is_admin) {
			return c.json(
				{ error: "Only the admin can generate invite codes" },
				403
			);
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

	authed.put("/v1/files/*", async (c) => {
		const { contributor } = getAuthCtx(c);
		const parsed = extractFileInfo(c.req.path);

		if (!parsed) {
			return c.json({ error: "Invalid file path" }, 400);
		}

		if (contributor.username !== parsed.username) {
			return c.json(
				{ error: "You can only write to your own contributor" },
				403
			);
		}

		if (!getContributor(parsed.username)) {
			return c.json({ error: "Contributor not found" }, 404);
		}

		const pathError = validatePath(parsed.filePath);
		if (pathError) {
			return c.json({ error: pathError }, 400);
		}

		const content = await c.req.text();

		const now = new Date().toISOString();
		const originCtime = c.req.header("X-Origin-Ctime") || now;
		const originMtime = c.req.header("X-Origin-Mtime") || now;

		try {
			const item = upsertItem(
				parsed.username,
				parsed.filePath,
				content,
				originCtime,
				originMtime
			);

			broadcast("file_updated", {
				contributor: parsed.username,
				path: item.path,
				size: Buffer.byteLength(item.content),
				modifiedAt: item.modified_at,
			});

			return c.json({
				path: item.path,
				size: Buffer.byteLength(item.content),
				createdAt: item.created_at,
				modifiedAt: item.modified_at,
			});
		} catch (e) {
			if (e instanceof ItemTooLargeError) {
				return c.json({ error: e.message }, 413);
			}
			throw e;
		}
	});

	// --- File Delete ---

	authed.delete("/v1/files/*", (c) => {
		const { contributor } = getAuthCtx(c);
		const parsed = extractFileInfo(c.req.path);

		if (!parsed) {
			return c.json({ error: "Invalid file path" }, 400);
		}

		if (contributor.username !== parsed.username) {
			return c.json(
				{ error: "You can only delete from your own contributor" },
				403
			);
		}

		const pathError = validatePath(parsed.filePath);
		if (pathError) {
			return c.json({ error: pathError }, 400);
		}

		const found = deleteItem(parsed.username, parsed.filePath);
		if (!found) {
			return c.json({ error: "File not found" }, 404);
		}

		broadcast("file_deleted", {
			contributor: parsed.username,
			path: parsed.filePath,
		});

		return c.body(null, 204);
	});

	// --- File Listing ---

	authed.get("/v1/files", (c) => {
		const prefix = c.req.query("prefix") || "";
		if (!prefix) {
			return c.json(
				{ error: "prefix query parameter is required" },
				400
			);
		}

		const slashIdx = prefix.indexOf("/");
		const username =
			slashIdx === -1 ? prefix : prefix.slice(0, slashIdx);
		const subPrefix =
			slashIdx === -1
				? undefined
				: prefix.slice(slashIdx + 1) || undefined;

		if (!getContributor(username)) {
			return c.json({ error: "Contributor not found" }, 404);
		}

		const items = listItems(username, subPrefix);
		return c.json({
			files: items.map((f) => ({
				path: `${username}/${f.path}`,
				size: f.size,
				createdAt: f.created_at,
				modifiedAt: f.modified_at,
			})),
		});
	});

	// --- File Read ---

	authed.get("/v1/files/*", (c) => {
		const parsed = extractFileInfo(c.req.path);

		if (!parsed) {
			return c.json({ error: "Invalid file path" }, 400);
		}

		const item = getItem(parsed.username, parsed.filePath);
		if (!item) {
			return c.json({ error: "File not found" }, 404);
		}

		return new Response(item.content, {
			status: 200,
			headers: {
				"Content-Type": "text/markdown; charset=utf-8",
				"X-Created-At": item.created_at,
				"X-Modified-At": item.modified_at,
				"X-Size": String(Buffer.byteLength(item.content)),
			},
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

				const msg = `event: connected\ndata: {}\n\n`;
				controller.enqueue(new TextEncoder().encode(msg));

				heartbeat = setInterval(() => {
					try {
						controller.enqueue(
							new TextEncoder().encode(":keepalive\n\n")
						);
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

	// --- Search (FTS5) ---

	authed.get("/v1/search", (c) => {
		const q = c.req.query("q");
		if (!q) {
			return c.json({ error: "q parameter is required" }, 400);
		}

		const contributorParam = c.req.query("contributor") || undefined;
		const limit = parseInt(c.req.query("limit") || "10", 10);

		if (contributorParam && !getContributor(contributorParam)) {
			return c.json({ error: "Contributor not found" }, 404);
		}

		const results = searchItems(q, contributorParam, limit);
		return c.json({ results });
	});

	// Mount authed routes
	app.route("/", authed);

	return app;
}
