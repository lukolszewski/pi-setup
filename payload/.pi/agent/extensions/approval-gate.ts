/**
 * Approval Gate Extension
 *
 * Requires interactive confirmation before Pi may WRITE files, EDIT files, or
 * run BASH commands. Read-only tools (read, grep, find, ls) are never gated.
 *
 * For each gated call you get three choices:
 *   - Allow once                -> run this one call
 *   - Allow <tool> this session -> stop prompting for that tool until Pi exits
 *   - Deny                      -> block the call (the model is told it was denied)
 *
 * Fails CLOSED: in non-interactive mode (-p / json / rpc, no UI) gated calls are
 * blocked, since there is no way to ask for approval.
 *
 * Placement: ~/.pi/agent/extensions/approval-gate.ts  (global, all projects)
 * Toggle at runtime by excluding nothing here -- instead disable via `pi config`
 * or move this file out of the extensions dir and `/reload`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Tools that require approval before they run.
// NOTE: "bash" is intentionally handled by the pi-bash-confirm package instead,
// to avoid double-prompting. Keep it out of this set.
const GATED_TOOLS = new Set(["write", "edit"]);

export default function (pi: ExtensionAPI) {
	// Tools the user chose to auto-allow for the rest of this process.
	const allowedForSession = new Set<string>();

	pi.on("tool_call", async (event, ctx) => {
		const tool = event.toolName;
		if (!GATED_TOOLS.has(tool)) return undefined; // read-only tools pass through
		if (allowedForSession.has(tool)) return undefined; // already blessed this session

		// Build a human-readable preview of what the tool is about to do.
		const input = event.input as Record<string, unknown>;
		let preview: string;
		if (tool === "bash") {
			preview = String(input.command ?? "");
		} else {
			// write / edit both target a path
			const path = String(input.path ?? input.file ?? "(unknown path)");
			const bytes = typeof input.content === "string" ? ` (${input.content.length} bytes)` : "";
			preview = `${path}${bytes}`;
		}
		if (preview.length > 2000) preview = preview.slice(0, 2000) + "\n…(truncated)";

		// No UI to ask on -> fail closed.
		if (!ctx.hasUI) {
			return { block: true, reason: `'${tool}' requires approval but no UI is available (non-interactive mode)` };
		}

		const choice = await ctx.ui.select(
			`🔒 Approve ${tool.toUpperCase()}?\n\n  ${preview}\n`,
			["Allow once", `Allow ${tool} this session`, "Deny"],
		);

		if (choice === "Deny" || choice == null) {
			return { block: true, reason: "Blocked by user" };
		}
		if (choice.startsWith("Allow") && choice.includes("this session")) {
			allowedForSession.add(tool);
		}
		return undefined; // allow
	});
}
