/**
 * copilot-auto for Pi 0.84.x: GitHub Copilot "Auto" model selection.
 *
 * Does what VS Code Copilot Chat does for its "Auto" model:
 *   1. POST {copilot base}/models/session  {"auto_mode":{"model_hints":["auto"]}}
 *      -> { selected_model, available_models: string[], session_token, expires_at }
 *   2. Uses selected_model (what Copilot CLI uses too), and sends every Copilot request
 *      with the "Copilot-Session-Token" header so GitHub treats it as Auto.
 *
 * Debug log: ~/.pi/agent/copilot-auto.log (no tokens are written to it).
 *
 * Install: ~/.pi/agent/extensions/copilot-auto.ts, restart Pi.
 * Use:     /login (GitHub Copilot) once, then either pick "GitHub Copilot Auto → Auto"
 *          in /model, or run /copilot-auto (on/off). Picking another model turns Auto off.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROVIDER = "github-copilot";
const DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";
// Same client identity Pi's built-in Copilot provider already uses.
const COPILOT_HEADERS: Record<string, string> = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
	"X-GitHub-Api-Version": "2026-08-01",
};
// API version current VS Code Copilot Chat sends on Auto session and chat requests.
// Pi 0.84.4 sends no version on chat requests at all.
const AUTO_API_VERSION = "2026-08-01";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const STATUS_KEY = "copilot-auto";
const MENU_PROVIDER = "copilot-auto"; // placeholder provider that holds the "Auto" entry in /model
const LOG_FILE = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "copilot-auto.log");

function log(line: string) {
	try {
		appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// logging must never break Pi
	}
}

interface AutoSession {
	token: string;
	selected?: string;
	models: string[];
	expiresAt: number; // ms epoch
}

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let autoSession: AutoSession | undefined;
	let pending: Promise<AutoSession> | undefined;
	let switching = false; // true while this extension itself changes the model

	async function fetchAutoSession(ctx: any): Promise<AutoSession> {
		const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER);
		const apiKey: string | undefined = auth?.auth?.apiKey;
		if (!apiKey) throw new Error("Not logged in to GitHub Copilot. Run /login first.");
		const baseUrl: string = (auth.auth.baseUrl as string | undefined) ?? DEFAULT_BASE_URL;

		const res = await fetch(`${baseUrl}/models/session`, {
			method: "POST",
			headers: {
				...COPILOT_HEADERS,
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ auto_mode: { model_hints: ["auto"] } }),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Auto session request failed (${res.status})${text ? `: ${text.slice(0, 300)}` : ""}`);
		}
		const data = (await res.json()) as Record<string, unknown>;
		const { session_token: _token, ...loggable } = data;
		log(`session ${baseUrl}: ${JSON.stringify(loggable)} token_length=${typeof _token === "string" ? _token.length : "missing"}`);
		if (typeof data.session_token !== "string" || !Array.isArray(data.available_models)) {
			throw new Error("Unexpected auto session response from GitHub (see copilot-auto.log)");
		}
		return {
			token: data.session_token,
			selected: typeof data.selected_model === "string" ? data.selected_model : undefined,
			models: data.available_models.filter((m): m is string => typeof m === "string"),
			expiresAt: typeof data.expires_at === "number" ? data.expires_at * 1000 : Date.now() + 30 * 60 * 1000,
		};
	}

	async function getAutoSession(ctx: any): Promise<AutoSession> {
		if (autoSession && autoSession.expiresAt - Date.now() > REFRESH_MARGIN_MS) return autoSession;
		pending ??= fetchAutoSession(ctx).finally(() => {
			pending = undefined;
		});
		autoSession = await pending;
		return autoSession;
	}

	/** Make sure the active model is the one GitHub picked for Auto; switch if not. */
	async function ensureAutoModel(ctx: any): Promise<string> {
		const session = await getAutoSession(ctx);
		const current = ctx.model;
		const candidates = session.selected ? [session.selected] : session.models;
		if (current?.provider === PROVIDER && candidates.includes(current.id)) return current.id;

		for (const id of candidates) {
			const model = ctx.modelRegistry.find(PROVIDER, id);
			if (!model) continue;
			switching = true;
			try {
				if (await pi.setModel(model)) return id;
			} finally {
				switching = false;
			}
		}
		throw new Error(
			`GitHub picked ${candidates.join(", ") || "(nothing)"}, which this Pi version doesn't know. See copilot-auto.log`,
		);
	}

	function showStatus(ctx: any, modelId?: string) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, enabled ? `copilot auto${modelId ? ` → ${modelId}` : ""}` : undefined);
	}

	async function enableAuto(ctx: any) {
		try {
			autoSession = undefined; // fresh session on enable
			const modelId = await ensureAutoModel(ctx);
			enabled = true;
			showStatus(ctx, modelId);
			if (ctx.hasUI) ctx.ui.notify(`Copilot Auto on, GitHub picked ${modelId}`, "info");
		} catch (err) {
			enabled = false;
			showStatus(ctx);
			const message = err instanceof Error ? err.message : String(err);
			log(`enable failed: ${message}`);
			if (ctx.hasUI) ctx.ui.notify(`Copilot Auto: ${message}`, "error");
		}
	}

	// Menu entry so Auto shows up in /model. It is never called: selecting it switches
	// to the model GitHub picks. The key is a placeholder that only makes the entry selectable.
	pi.registerProvider(MENU_PROVIDER, {
		name: "GitHub Copilot Auto",
		baseUrl: DEFAULT_BASE_URL,
		apiKey: "copilot-auto-placeholder",
		api: "openai-completions",
		models: [
			{
				id: "auto",
				name: "Auto (GitHub picks the model)",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16000,
			},
		],
	});

	pi.registerCommand("copilot-auto", {
		description: "Toggle GitHub Copilot Auto model selection (on/off)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const turnOn = arg === "on" ? true : arg === "off" ? false : !enabled;
			if (turnOn) return enableAuto(ctx);
			enabled = false;
			showStatus(ctx);
			ctx.ui.notify("Copilot Auto off", "info");
		},
	});

	// Before each prompt: refresh the Auto session if needed and keep the model valid.
	pi.on("before_agent_start", async (_event, ctx) => {
		if (ctx.model?.provider === MENU_PROVIDER && !enabled) {
			// Auto picked in /model (or restored from a previous session) but not switched yet.
			await enableAuto(ctx);
			return;
		}
		if (!enabled) return;
		try {
			showStatus(ctx, await ensureAutoModel(ctx));
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`Copilot Auto: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	});

	// Attach the Auto session token to Copilot requests while Auto is on.
	pi.on("before_provider_headers", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER) return;
		const attach = enabled && !!autoSession;
		if (attach) {
			event.headers["Copilot-Session-Token"] = autoSession!.token;
			event.headers["X-GitHub-Api-Version"] = AUTO_API_VERSION;
		}
		log(
			`request model=${ctx.model.id} api=${ctx.model.api} auto=${enabled} session_header=${attach} ` +
				`header_names=${Object.keys(event.headers).sort().join(",")}`,
		);
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.provider === PROVIDER) log(`response status=${event.status} model=${ctx.model.id}`);
	});

	// Picking "GitHub Copilot Auto → Auto" in /model turns Auto on; picking any other model turns it off.
	pi.on("model_select", (event, ctx) => {
		if (switching) return;
		if (event.model?.provider === MENU_PROVIDER) {
			// Switch after Pi has finished applying this selection.
			setTimeout(() => void enableAuto(ctx), 0);
			return;
		}
		if (!enabled) return;
		enabled = false;
		showStatus(ctx);
		if (ctx.hasUI) ctx.ui.notify("Copilot Auto off (model chosen manually)", "info");
	});
}
