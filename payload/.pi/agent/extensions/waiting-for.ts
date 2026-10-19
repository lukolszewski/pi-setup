/**
 * pi-waiting-for — GENERATED BUNDLE, do not edit.
 *
 * Built by scripts/bundle.mjs from src/ (state.ts, render.ts, limits.ts, smooth.ts, paths.ts, config.ts, turnlog.ts, extension.ts).
 * Edit the modules in src/, then run `npm run build`.
 *
 * Single file on purpose: pi resolves an extension's imports relative to the
 * path it was handed, so a symlinked multi-file extension cannot find its
 * siblings. One file works from ~/.pi/agent/extensions, `pi -e`, and installs.
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	ToolExecutionStartEvent,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------- src/state.ts

/**
 * Pure activity state machine for pi-waiting-for.
 *
 * No pi imports, no timers, no rendering. Every transition is driven by an
 * explicit event plus the injected clock, so it is fully unit-testable.
 *
 * The point of this module: pi's built-in "Working" spinner is a blind frame
 * cycler (pi-tui Loader uses setInterval and knows nothing about data arrival).
 * Here we track *when bytes last arrived* so the caller can decide whether the
 * glyph should animate at all, and *what* we are currently blocked on.
 */

export type Phase =
	| "idle"
	| "settling"
	| "modelAwait"
	| "modelStream"
	| "modelStall"
	| "toolRun"
	| "prompt";

/** What kind of assistant delta we last saw. */
export type StreamKind = "text" | "thinking" | "toolcall";

export interface Thresholds {
	/** No bytes for this long => animation stops (model considered silent). */
	staleMs: number;
	/** Running tool produced no output for this long => "no output". */
	quietMs: number;
	/** Phase lasted this long => escalate to the warning glyph/color. */
	warnMs: number;
	/**
	 * How long a just-ended assistant message keeps its stream label.
	 *
	 * Reasoning-heavy answers arrive as several assistant messages in a row
	 * (thinking block, then answer). Without this grace window the row strobes
	 * `thinking` -> `finishing turn` -> `thinking`, which reads as a hang.
	 */
	settlingGraceMs: number;
}

export function defaultThresholds(): Thresholds {
	return { staleMs: 400, quietMs: 1500, warnMs: 15000, settlingGraceMs: 400 };
}

export interface ToolActivity {
	id: string;
	name: string;
	/** Compact one-line descriptor: command, path, pattern, query... */
	target?: string;
	startedAt: number;
	/** Last time this tool produced output (or start time if never). */
	lastOutputAt: number;
	/** Accumulated output size in characters (pi sends accumulated partials). */
	outputChars: number;
	outputLines: number;
	/** bash/powershell `timeout` argument in ms, when the model set one. */
	timeoutMs?: number;
	/** Short progress hint derived from `partialResult.details` (extension tools). */
	progress?: string;
}

export interface ToolStartOptions {
	timeoutMs?: number;
}

export interface Snapshot {
	now: number;
	phase: Phase;
	/** Sub-kind of the current assistant stream (modelStream only). */
	streamKind?: StreamKind;
	/** True once provider response headers arrived (TTFB split). */
	modelConnected: boolean;
	/** Longest running tool (the most likely blocker). */
	tool?: ToolActivity;
	/** Number of tools still running. */
	toolCount: number;
	/** toolCount - 1, for "bash + 2 more". */
	otherTools: number;
	/** Title of the blocking UI prompt (prompt only). */
	promptTitle?: string;
	/** Issued tool calls that have not started executing yet. */
	queuedTools: number;
	/** Milliseconds since the current phase started. */
	elapsedMs: number;
	/** Milliseconds since the relevant activity last produced bytes. */
	silentMs: number;
	/** True while an HTTP request to the provider is outstanding. */
	requestInFlight: boolean;
	/** Non-2xx status seen on the outstanding request (429, 5xx...). */
	providerStatus?: number;
	/** True when a running tool is within 20% of its own timeout budget. */
	nearTimeout: boolean;
	/** True once the current turn has produced any assistant output. */
	turnHadResponse: boolean;
	/** True while bytes are arriving often enough to justify animation. */
	fresh: boolean;
	/** True while a running tool has produced no output for quietMs. */
	quiet: boolean;
	/** True when elapsedMs > warnMs. */
	warned: boolean;
	/** Assistant characters streamed for the current message. */
	streamChars: number;
	/** Rough output-token estimate from streamed characters (only for display). */
	estimatedTokens?: number;
}

/** Characters per token heuristic used for the (opt-in) token counter. */
export const CHARS_PER_TOKEN = 4;

/**
 * One completed provider-request wait.
 *
 * `answered` is true when we saw response headers or a message start. It is
 * false when another request went out (or the run ended) without either - which
 * is what a provider-level retry backoff sleep or a dead socket looks like from
 * the outside, because pi-ai retries inside one `before_provider_request`.
 */
export interface RequestWait {
	/** Milliseconds from request to resolution. */
	ms: number;
	answered: boolean;
}

/** Provider-request statistics for one agent run. */
export interface RunStats {
	requests: number;
	answered: number;
	waits: RequestWait[];
}

export function emptyRunStats(): RunStats {
	return { requests: 0, answered: 0, waits: [] };
}

export class WaitingState {
	private thresholds: Thresholds;
	private readonly clock: () => number;

	private phase: Phase = "idle";
	private phaseStartedAt = 0;

	private streamKind: StreamKind | undefined;
	/** Last stream kind seen in this turn, surviving `message_end`. */
	private lastStreamKind: StreamKind | undefined;
	private messageStartedAt = 0;
	/**
	 * Until when a just-ended message keeps its stream label. Set on message_end
	 * and cancelled by anything that means "we moved on" (a tool starting or being
	 * queued, a new request), so it only ever covers a message-to-message gap.
	 */
	private streamGraceUntil = 0;
	private lastByteAt = 0;
	private streamChars = 0;
	private modelConnected = false;

	private readonly tools = new Map<string, ToolActivity>();

	private promptTitle: string | undefined;
	private promptStartedAt = 0;
	/** True while the agent run is live (between agent_start and agent_end). */
	private running = false;
	private requestInFlight = false;
	private providerStatus: number | undefined;
	private turnHadResponse = false;
	/** Issued tool calls that have not started executing (id -> tool name). */
	private readonly queued = new Map<string, string>();

	/** Provider-request wait accounting for the current run. */
	private stats: RunStats = emptyRunStats();
	/** Completed stats for the previous run, kept for `/waiting-for`. */
	private lastStats: RunStats = emptyRunStats();
	/** When the outstanding request went out; 0 when none is outstanding. */
	private awaitStartedAt = 0;
	/** True once the outstanding request produced headers or a message. */
	private awaitResolved = true;

	constructor(thresholds: Thresholds = defaultThresholds(), clock: () => number = () => Date.now()) {
		this.thresholds = { ...thresholds };
		this.clock = clock;
	}

	setThresholds(thresholds: Thresholds): void {
		this.thresholds = { ...thresholds };
	}

	getThresholds(): Thresholds {
		return { ...this.thresholds };
	}

	// ---------------------------------------------------------------- events

	/** A user prompt was submitted / the agent loop started. */
	onAgentStart(): void {
		this.running = true;
		this.turnHadResponse = false;
		// Nothing has been sent yet. Clearing the in-flight flag here matters: a
		// stale `true` would make context assembly read as a model wait.
		this.requestInFlight = false;
		this.providerStatus = undefined;
		this.beginAwait();
		this.stats = emptyRunStats();
		this.enter("settling");
		this.resetStream();
	}

	/** A turn started: pi also (re)creates its working row here. */
	onTurnStart(): void {
		this.running = true;
		this.turnHadResponse = false;
		// No request has gone out yet: context assembly and extension handlers run
		// first, so claiming "waiting for model" here would be a lie.
		this.requestInFlight = false;
		this.providerStatus = undefined;
		this.enter("settling");
		this.resetStream();
	}

	/** Start accounting for a request that has not gone out yet. */
	private beginAwait(): void {
		this.awaitStartedAt = 0;
		this.awaitResolved = true;
	}

	/** We just sent a request to the provider. */
	onProviderRequest(): void {
		const now = this.clock();
		// A previous request still unanswered means we never got headers back.
		this.settleAwait(now);
		this.stats.requests += 1;
		this.awaitStartedAt = now;
		this.awaitResolved = false;

		this.modelConnected = false;
		this.providerStatus = undefined;
		this.requestInFlight = true;
		this.streamGraceUntil = 0;
		if (this.phase === "toolRun" || this.phase === "prompt") return;
		this.enter("modelAwait");
		this.resetStream();
	}

	/** Provider response headers arrived; still no tokens necessarily. */
	onProviderResponse(status: number): void {
		this.resolveAwait(this.clock());
		this.modelConnected = true;
		if (status >= 400) this.providerStatus = status;
	}

	/** An assistant message started. */
	onMessageStart(): void {
		// Some providers surface no onResponse hook, so a message start also resolves
		// the outstanding wait; otherwise every such request looks unanswered.
		this.resolveAwait(this.clock());
		this.modelConnected = true;
		this.resetStream();
		if (this.phase === "toolRun" || this.phase === "prompt") return;
		this.enter("modelStream");
	}

	/** Close the outstanding wait as answered. */
	private resolveAwait(now: number): void {
		if (this.awaitResolved || this.awaitStartedAt === 0) return;
		this.stats.answered += 1;
		this.pushWait({ ms: Math.max(0, now - this.awaitStartedAt), answered: true });
		this.awaitResolved = true;
	}

	/** Close the outstanding wait as never answered (retry backoff, dead socket). */
	private settleAwait(now: number): void {
		if (this.awaitResolved || this.awaitStartedAt === 0) return;
		this.pushWait({ ms: Math.max(0, now - this.awaitStartedAt), answered: false });
		this.awaitResolved = true;
	}

	private pushWait(wait: RequestWait): void {
		this.stats.waits.push(wait);
		// Bounded: a long session must not accumulate waits forever.
		if (this.stats.waits.length > 64) this.stats.waits.shift();
	}

	/** Wait statistics for the run in progress. */
	getStats(): RunStats {
		return { ...this.stats, waits: [...this.stats.waits] };
	}

	/** Wait statistics for the previous completed run. */
	getLastStats(): RunStats {
		return { ...this.lastStats, waits: [...this.lastStats.waits] };
	}

	/** A streamed assistant delta arrived (text, thinking or tool-call args). */
	onStream(kind: StreamKind, deltaChars: number): void {
		const now = this.clock();
		this.lastByteAt = now;
		this.streamChars += Math.max(0, deltaChars);
		if (this.phase === "toolRun" || this.phase === "prompt") return;
		if (this.phase !== "modelStream") this.enter("modelStream");
		this.streamKind = kind;
		// Sticky so a message boundary can keep saying "thinking" instead of
		// flashing an idle-ish label (see settlingGraceMs).
		this.lastStreamKind = kind;
		this.turnHadResponse = true;
	}

	/** An assistant message finished. */
	onMessageEnd(): void {
		this.streamGraceUntil = this.clock() + this.thresholds.settlingGraceMs;
		this.streamKind = undefined;
		this.requestInFlight = false;
		if (this.phase === "toolRun" || this.phase === "prompt") return;
		// Tool-call hooks are awaited before execution starts, so a slow
		// third-party handler surfaces here rather than as a fake "model silent".
		this.enter("settling");
	}

	/** End of a turn: the loop may still queue another turn or run handlers. */
	onTurnEnd(): void {
		this.requestInFlight = false;
		if (this.phase === "prompt" || this.tools.size > 0) return;
		this.enter("settling");
	}

	/** A tool call was issued (its hook fired) but has not started executing. */
	onToolQueued(id: string, name: string): void {
		this.streamGraceUntil = 0;
		this.queued.set(id, name);
	}

	/** A tool started executing (arguments are complete at this point). */
	onToolStart(id: string, name: string, target?: string, options: ToolStartOptions = {}): void {
		this.streamGraceUntil = 0;
		const now = this.clock();
		this.queued.delete(id);
		this.tools.set(id, {
			id,
			name,
			target,
			startedAt: now,
			lastOutputAt: now,
			outputChars: 0,
			outputLines: 0,
			timeoutMs: options.timeoutMs,
		});
		if (this.phase !== "prompt") this.enter("toolRun");
	}

	/** A running tool produced output. `outputChars`/`outputLines` are totals. */
	onToolOutput(id: string, outputChars: number, outputLines: number, progress?: string): void {
		const tool = this.tools.get(id);
		if (!tool) return;
		// pi sends accumulated partial results, so assign rather than add.
		tool.outputChars = outputChars;
		tool.outputLines = outputLines;
		if (progress) tool.progress = progress;
		if (outputChars > 0 || outputLines > 0) tool.lastOutputAt = this.clock();
	}

	/** A tool finished (successfully or not). */
	onToolEnd(id: string): void {
		this.queued.delete(id);
		if (!this.tools.delete(id)) return;
		if (this.tools.size > 0) return;
		if (this.phase === "prompt") return;
		// Nothing is running and no request is in flight: results are being handled.
		this.enter("settling");
		this.resetStream();
	}

	/** pi is blocked on a blocking extension UI prompt (select/confirm/input). */
	onPromptStart(title?: string): void {
		this.promptTitle = title;
		this.promptStartedAt = this.clock();
		if (this.phase !== "prompt") this.enter("prompt");
	}

	onPromptEnd(): void {
		if (this.phase !== "prompt") {
			this.promptTitle = undefined;
			return;
		}
		this.promptTitle = undefined;
		this.enter(this.tools.size > 0 ? "toolRun" : this.running ? "settling" : "idle");
	}

	/** The agent run is over. */
	onAgentEnd(): void {
		// An outstanding, unanswered request is still worth recording: it is the
		// abort-on-a-dead-socket case.
		this.settleAwait(this.clock());
		this.lastStats = this.stats;
		this.stats = emptyRunStats();
		this.beginAwait();

		this.running = false;
		this.tools.clear();
		this.queued.clear();
		this.promptTitle = undefined;
		this.streamKind = undefined;
		this.streamChars = 0;
		this.requestInFlight = false;
		this.providerStatus = undefined;
		this.turnHadResponse = false;
		this.enter("idle");
	}

	/** Drop all state (session switch, /reload, new/resume/fork). */
	reset(): void {
		this.onAgentEnd();
	}

	// ------------------------------------------------------------- snapshot

	snapshot(): Snapshot {
		const now = this.clock();
		const base: Snapshot = {
			now,
			phase: this.phase,
			modelConnected: this.modelConnected,
			toolCount: this.tools.size,
			otherTools: Math.max(0, this.tools.size - 1),
			queuedTools: this.queued.size,
			elapsedMs: Math.max(0, now - this.phaseStartedAt),
			silentMs: 0,
			requestInFlight: this.requestInFlight,
			providerStatus: this.providerStatus,
			nearTimeout: false,
			turnHadResponse: this.turnHadResponse,
			fresh: false,
			quiet: false,
			warned: false,
			streamChars: this.streamChars,
		};

		switch (this.phase) {
			case "idle":
				return base;

			case "prompt":
				return {
					...base,
					promptTitle: this.promptTitle,
					elapsedMs: Math.max(0, now - this.promptStartedAt),
					fresh: false,
					warned: now - this.promptStartedAt >= this.thresholds.warnMs,
				};

			case "settling": {
				// A message that ended a moment ago is still "the model's answer":
				// reasoning streams close the thinking message before opening the
				// answer, and relabelling that gap reads as a hang. Anything really
				// blocking (tool, prompt, outstanding request) still wins.
				const inGrace =
					this.streamGraceUntil > 0 && now <= this.streamGraceUntil && this.lastStreamKind !== undefined;
				if (inGrace && this.tools.size === 0 && this.promptTitle === undefined && !this.requestInFlight) {
					return {
						...base,
						phase: "modelStream",
						streamKind: this.lastStreamKind,
						elapsedMs: Math.max(0, now - (this.messageStartedAt || this.phaseStartedAt)),
						silentMs: this.lastByteAt === 0 ? base.elapsedMs : Math.max(0, now - this.lastByteAt),
						fresh: false,
						warned: base.elapsedMs >= this.thresholds.warnMs,
					};
				}
				return {
					...base,
					// No request remap here: `requestInFlight` is cleared at run and turn
					// boundaries, and a stale flag must never relabel local work as a
					// model wait (that was how `waiting for model` lied).
					silentMs: base.elapsedMs,
					fresh: false,
					warned: base.elapsedMs >= this.thresholds.warnMs,
				};
			}

			case "toolRun": {
				const tools = this.runningTools();
				const blocker = tools[0];
				if (!blocker) {
					// Defensive: map emptied between events.
					return { ...base, phase: "settling", tool: undefined, toolCount: 0, otherTools: 0 };
				}
				const lastOutputAt = Math.max(...tools.map((tool) => tool.lastOutputAt));
				const silentMs = Math.max(0, now - lastOutputAt);
				const quiet = silentMs >= this.thresholds.quietMs;
				const elapsedMs = Math.max(0, now - blocker.startedAt);
				const nearTimeout =
					blocker.timeoutMs !== undefined && blocker.timeoutMs > 0 && elapsedMs >= blocker.timeoutMs * 0.8;
				return {
					...base,
					tool: blocker,
					toolCount: tools.length,
					otherTools: Math.max(0, tools.length - 1),
					queuedTools: this.queued.size,
					elapsedMs,
					silentMs,
					// Animate only while output is actually arriving. `!quiet` would
					// keep the glyph spinning for the whole quiet window, i.e. a busy
					// spinner on a command producing nothing - the exact dishonesty
					// this extension exists to remove.
					fresh: silentMs < this.thresholds.staleMs,
					quiet,
					nearTimeout,
					warned: nearTimeout || elapsedMs >= this.thresholds.warnMs,
				};
			}

			case "modelStream": {
				const elapsedMs = this.messageStartedAt > 0 ? Math.max(0, now - this.messageStartedAt) : base.elapsedMs;
				const silentMs = this.lastByteAt > 0 ? Math.max(0, now - this.lastByteAt) : elapsedMs;
				// Nothing recorded for this message yet: we are awaiting the first
				// observable token, not stalled. Reporting "model silent" here was a
				// lie - providers commonly open a message and then sit on the body.
				if (this.streamChars === 0) {
					return {
						...base,
						phase: "modelAwait",
						modelConnected: true,
						silentMs,
						elapsedMs,
						fresh: false,
						warned: elapsedMs >= this.thresholds.warnMs,
					};
				}
				// Tool-call arguments are streamed in a few large chunks (and SDKs
				// buffer them), so an event gap says nothing about progress: a model
				// writing a big file/edit argument must never be called silent.
				const stallable = this.streamKind !== "toolcall";
				if (stallable && silentMs >= this.thresholds.staleMs) {
					return {
						...base,
						phase: "modelStall",
						silentMs,
						elapsedMs: silentMs,
						fresh: false,
						warned: silentMs >= this.thresholds.warnMs,
					};
				}
				return {
					...base,
					streamKind: this.streamKind,
					elapsedMs,
					silentMs,
					fresh: silentMs < this.thresholds.staleMs,
					warned: !stallable && elapsedMs >= this.thresholds.warnMs,
					estimatedTokens: Math.round(this.streamChars / CHARS_PER_TOKEN),
				};
			}

			case "modelStall": {
				const silentMs = this.lastByteAt > 0 ? Math.max(0, now - this.lastByteAt) : base.elapsedMs;
				if (silentMs < this.thresholds.staleMs) {
					// Bytes resumed: caller should animate again.
					return {
						...base,
						phase: "modelStream",
						streamKind: this.streamKind,
						silentMs,
						elapsedMs: this.messageStartedAt > 0 ? Math.max(0, now - this.messageStartedAt) : base.elapsedMs,
						fresh: true,
						estimatedTokens: Math.round(this.streamChars / CHARS_PER_TOKEN),
					};
				}
				return {
					...base,
					silentMs,
					elapsedMs: silentMs,
					fresh: false,
					warned: silentMs >= this.thresholds.warnMs,
				};
			}

			case "modelAwait":
			default:
				if (!this.requestInFlight && this.tools.size === 0) {
					// No outstanding request means this is between-work, not a model wait.
					return {
						...base,
						phase: "settling",
						silentMs: base.elapsedMs,
						fresh: false,
						warned: base.elapsedMs >= this.thresholds.warnMs,
					};
				}
				return {
					...base,
					silentMs: base.elapsedMs,
					fresh: false,
					warned: base.elapsedMs >= this.thresholds.warnMs,
				};
		}
	}

	/** Whether the caller should keep a tick timer alive. */
	isActive(): boolean {
		return this.phase !== "idle";
	}

	/**
	 * True between agent_start and agent_end. This is what licenses *not* handing
	 * the row back: while the run is live, an empty row is rendered by core as its
	 * own "Working..." default (interactive-mode.js: workingMessage ?? default),
	 * so clearing mid-run is what makes the row strobe.
	 */
	isRunLive(): boolean {
		return this.running;
	}

	// -------------------------------------------------------------- internal

	private runningTools(): ToolActivity[] {
		// Longest running first: it is the most likely blocker.
		return [...this.tools.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	private enter(phase: Phase): void {
		if (this.phase === phase) return;
		this.phase = phase;
		this.phaseStartedAt = this.clock();
	}

	private resetStream(): void {
		this.streamKind = undefined;
		this.streamChars = 0;
		this.lastByteAt = 0;
		this.messageStartedAt = 0;
		this.modelConnected = false;
	}
}

/** Classify a pi AssistantMessageEvent type into a StreamKind. */
export function streamKindFromEvent(eventType: string | undefined): StreamKind | undefined {
	if (!eventType) return undefined;
	if (eventType.startsWith("toolcall_")) return "toolcall";
	if (eventType.startsWith("thinking_")) return "thinking";
	if (eventType.startsWith("text_")) return "text";
	return undefined;
}

// (inlined) 1 internal import statement(s) from src/render.ts

// ---------------------------------------------------------------- src/render.ts

/**
 * Pure line composition for pi-waiting-for.
 *
 * Takes a Snapshot plus a frame index and returns the glyph + text segments to
 * show. No pi imports, no colors: the caller colorizes using ctx.ui.theme so
 * the extension follows the active pi theme.
 */


export type SegmentRole = "glyph" | "label" | "meta" | "warn";

export interface Segment {
	text: string;
	role: SegmentRole;
}

export interface RenderedLine {
	/** The glyph to show (animation frame, static dot, or warning glyph). */
	glyph: string;
	/** True when the glyph is an animation frame (bytes are arriving). */
	animate: boolean;
	/** True when the phase has been going on for warnMs. */
	warned: boolean;
	/** Full line as segments, glyph excluded. */
	segments: Segment[];
	/** Plain, uncolored line — used for render dedupe and tests. */
	plain: string;
}

export interface RenderOptions {
	/** Animation frames, e.g. the braille spinner. */
	frames: string[];
	/** Glyph shown when nothing is arriving. */
	staticGlyph: string;
	/** Glyph shown when a phase has been going on for warnMs. */
	warnGlyph: string;
	/** Show the rough output-token estimate while streaming. */
	showTokens: boolean;
	/** Show elapsed seconds. */
	showElapsed: boolean;
	/** Show a running command's own timeout budget (`6s of 120s`). */
	showTimeout: boolean;
	/** Show tool calls issued but not yet executing (`+2 queued`). */
	showQueued: boolean;
	/** Show progress hints derived from extension-tool `details`. */
	showProgress: boolean;
	/** Max characters for a tool target (command/path/pattern). */
	maxTargetLength: number;
	/** Hard cap for the whole line; 0 disables truncation. */
	maxWidth: number;
	/** Joiner between label and meta pieces. ` · ` normally, ` - ` for ASCII. */
	separator: string;
	/** Appended when text is cut. `…` normally, `...` for ASCII. */
	ellipsis: string;
	/** Show pi's own provider ceilings on a request with no response at all. */
	showLimits: boolean;
	/**
	 * True when the resolved glyph set is ASCII. Derived by
	 * `resolveRenderOptions`, never persisted: it keeps derived text such as the
	 * ceilings hint free of non-ASCII characters too.
	 */
	ascii: boolean;
	/** pi's retry/idle ceilings, used for the "how long can this take" hint. */
	limits?: ProviderLimits;
}

/**
 * pi's own provider ceilings, mirroring settings-manager defaults. Shown so a
 * long "no response" wait carries its own upper bound instead of looking
 * endless: retries happen inside one `before_provider_request`, so the row
 * cannot count them.
 */
export interface ProviderLimits {
	/** Retries pi-ai may perform for a single request. */
	retries?: number;
	/** Longest per-attempt backoff sleep pi will accept. */
	maxRetryDelayMs?: number;
	/** pi's HTTP idle timeout: a silent socket dies here. */
	idleMs?: number;
}

export type RenderMode = "auto" | "unicode" | "ascii";
export type GlyphSet = "unicode" | "ascii";

/**
 * Terminals that cannot render braille even when the locale is UTF-8: the Linux
 * console uses a 512-glyph PSF font with no U+2800 block, and the old VT
 * emulators have no such glyphs at all.
 */
const NO_BRAILLE_TERMS = ["dumb", "linux", "vt100", "vt220"];

export function defaultRenderOptions(): RenderOptions {
	return {
		frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
		staticGlyph: "·",
		// `*` rather than `⏸` on purpose: U+23F8 renders as a tofu box in
		// terminals without a symbol font, and as a 2-cell emoji in some that have
		// one - which would also throw off width-based truncation.
		warnGlyph: "*",
		showTokens: false,
		showElapsed: true,
		showTimeout: true,
		showQueued: true,
		showProgress: true,
		maxTargetLength: 44,
		maxWidth: 90,
		separator: " · ",
		ellipsis: "…",
		showLimits: true,
		ascii: false,
	};
}

/** Coarse duration for hints: `45s`, `5m`, `1h`. */
export function formatDurationCompact(ms: number): string {
	const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m`;
	return `${Math.floor(totalMinutes / 60)}h`;
}

/** `retries ≤3, idle timeout 5m` - the bound a no-response wait is running against. */
export function formatLimits(limits: ProviderLimits, ascii = false): string {
	const atMost = ascii ? "<=" : "\u2264";
	const parts: string[] = [];
	if (typeof limits.retries === "number" && limits.retries > 0) {
		parts.push(`retries ${atMost}${limits.retries}`);
	}
	if (typeof limits.maxRetryDelayMs === "number" && limits.maxRetryDelayMs > 0) {
		parts.push(`backoff ${atMost}${formatDurationCompact(limits.maxRetryDelayMs)}`);
	}
	if (typeof limits.idleMs === "number" && limits.idleMs > 0) {
		parts.push(`idle timeout ${formatDurationCompact(limits.idleMs)}`);
	}
	return parts.join(", ");
}

/**
 * Post-hoc summary of provider waits for one run, used by `/waiting-for` to
 * answer "what was that just now". Requests that never got headers are called
 * out explicitly: that is what a retry backoff or a dead socket looks like.
 */
export function formatRunStats(stats: RunStats, separator = " \u00b7 "): string {
	if (stats.requests === 0) return "no provider requests";
	const unanswered = stats.waits.filter((wait) => !wait.answered).map((wait) => wait.ms);
	const answered = stats.waits.filter((wait) => wait.answered).map((wait) => wait.ms);
	const parts = [`${stats.requests} requests`, `answered ${stats.answered}/${stats.requests}`];
	if (answered.length > 0) parts.push(`slowest first byte ${formatElapsed(Math.max(...answered))}`);
	if (unanswered.length > 0) {
		const recent = unanswered.slice(-3).map((ms) => formatElapsed(ms));
		parts.push(`no response ${recent.join(", ")}`);
	}
	return parts.join(separator);
}

/**
 * Everything a plain text console can render: one-cell ASCII characters only,
 * safe in cp437/cp850 code pages and in terminals with no Unicode at all.
 */
export function asciiRenderOptions(base: RenderOptions = defaultRenderOptions()): RenderOptions {
	return {
		...base,
		frames: ["|", "/", "-", "\\"],
		staticGlyph: "-",
		warnGlyph: "!",
		separator: " - ",
		ellipsis: "...",
		ascii: true,
	};
}

/**
 * Pick a glyph set from the environment. Deliberately conservative about
 * downgrading: we only leave Unicode when there is real evidence the terminal
 * cannot take it, because a wrong `ascii` choice is invisible to the user.
 */
export function detectRenderMode(env: NodeJS.ProcessEnv = process.env): GlyphSet {
	const explicit = (env["PI_WAITING_FOR_RENDER"] ?? "").trim().toLowerCase();
	if (explicit === "ascii") return "ascii";
	if (explicit === "unicode") return "unicode";

	const term = (env["TERM"] ?? "").trim().toLowerCase();
	if (!term) return "ascii";
	if (NO_BRAILLE_TERMS.includes(term) || NO_BRAILLE_TERMS.includes(term.split("-")[0] ?? "")) return "ascii";

	const locale = [env["LC_ALL"], env["LC_CTYPE"], env["LANG"]].find(
		(value) => typeof value === "string" && value.trim().length > 0,
	);
	// No locale at all is left as Unicode: modern terminals default to it.
	if (locale && !/utf-?8/i.test(locale)) return "ascii";
	return "unicode";
}

export function resolveRenderOptions(
	base: RenderOptions,
	mode: RenderMode = "auto",
	env: NodeJS.ProcessEnv = process.env,
): RenderOptions {
	const set = mode === "auto" ? detectRenderMode(env) : mode;
	return set === "ascii" ? asciiRenderOptions(base) : base;
}

/** `12s`, `1m 04s`. */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** `1.4k` style token counts, kept deliberately approximate-looking. */
export function formatTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens} tok`;
	return `${(tokens / 1000).toFixed(1)}k tok`;
}

export function truncate(text: string, max: number, ellipsis = "…"): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (max <= 0 || oneLine.length <= max) return oneLine;
	if (max <= ellipsis.length) return ellipsis;
	return `${oneLine.slice(0, max - ellipsis.length)}${ellipsis}`;
}

function labelFor(snapshot: Snapshot): string {
	switch (snapshot.phase) {
		case "prompt":
			return "waiting for you";
		case "toolRun": {
			const name = snapshot.tool?.name ?? "tool";
			return snapshot.otherTools > 0 ? `${name} + ${snapshot.otherTools} more` : name;
		}
		case "modelStream":
			if (snapshot.streamKind === "toolcall") return "generating tool call";
			if (snapshot.streamKind === "thinking") return "thinking";
			return "model";
		case "modelStall":
			return snapshot.providerStatus
				? snapshot.providerStatus === 429
					? "model rate-limited (429)"
					: `model error (${snapshot.providerStatus})`
				: "model silent";
		case "modelAwait":
			if (snapshot.providerStatus) {
				return snapshot.providerStatus === 429
					? "model rate-limited (429)"
					: `model error (${snapshot.providerStatus})`;
			}
			// Split by what we can actually observe: headers or not. Before headers
			// the wait includes connect, upload, provider queueing and any retry
			// backoff, none of which the model is "thinking" through.
			if (!snapshot.modelConnected) return "connecting to model";
			return "model first token";
		case "settling":
			// Nothing runs and no request is outstanding: handlers/queue/session work.
			return snapshot.turnHadResponse ? "finishing turn" : "preparing request";
		case "idle":
		default:
			return "";
	}
}

function metaFor(snapshot: Snapshot, options: RenderOptions): string[] {
	const meta: string[] = [];

	if (snapshot.phase === "prompt") {
		if (snapshot.promptTitle) meta.push(truncate(snapshot.promptTitle, options.maxTargetLength, options.ellipsis));
		return meta;
	}

	if (snapshot.phase === "toolRun" && snapshot.tool) {
		if (snapshot.tool.target) meta.push(truncate(snapshot.tool.target, options.maxTargetLength, options.ellipsis));
		if (options.showProgress && snapshot.tool.progress) {
			meta.push(truncate(snapshot.tool.progress, options.maxTargetLength, options.ellipsis));
		}
		const lines = snapshot.tool.outputLines;
		if (snapshot.quiet) {
			meta.push(lines > 0 ? `no new output ${formatElapsed(snapshot.silentMs)}` : "no output");
		} else if (lines > 0) {
			meta.push(`${lines} ${lines === 1 ? "line" : "lines"}`);
		} else if (snapshot.tool.outputChars > 0) {
			meta.push(`${snapshot.tool.outputChars} chars`);
		}
		if (options.showQueued && snapshot.queuedTools > 0) {
			meta.push(`+${snapshot.queuedTools} queued`);
		}
		return meta;
	}

	if (snapshot.phase === "modelStream") {
		if (options.showTokens && snapshot.estimatedTokens !== undefined && snapshot.estimatedTokens > 0) {
			meta.push(formatTokens(snapshot.estimatedTokens));
		}
		return meta;
	}

	if (snapshot.phase === "modelStall") return [];

	if (snapshot.phase === "modelAwait") {
		// No headers at all: name it, and show pi's own ceiling so the wait has a
		// bound the user can act on (wait vs Esc) instead of an open-ended counter.
		if (snapshot.warned) {
			if (!snapshot.modelConnected) meta.push("no response");
			if (options.showLimits && options.limits) {
				const limits = formatLimits(options.limits, options.ascii);
				if (limits) meta.push(limits);
			}
		}
		return meta;
	}

	return meta;
}

/**
 * Build the status line for the current snapshot.
 * Returns undefined when nothing should be shown (idle).
 */
export function renderLine(
	snapshot: Snapshot,
	frameIndex: number,
	options: RenderOptions = defaultRenderOptions(),
): RenderedLine | undefined {
	if (snapshot.phase === "idle") return undefined;

	const animate = snapshot.fresh && options.frames.length > 0;
	const glyph = snapshot.warned
		? options.warnGlyph
		: animate
			? (options.frames[frameIndex % options.frames.length] ?? options.staticGlyph)
			: options.staticGlyph;

	const label = labelFor(snapshot);
	if (!label) return undefined;

	const meta = metaFor(snapshot, options);
	const segments: Segment[] = [{ text: label, role: snapshot.warned ? "warn" : "label" }];
	for (const item of meta) segments.push({ text: item, role: snapshot.warned ? "warn" : "meta" });
	if (options.showElapsed) {
		const timeoutMs = options.showTimeout ? snapshot.tool?.timeoutMs : undefined;
		const elapsedText =
			timeoutMs && timeoutMs > 0
				? `${formatElapsed(snapshot.elapsedMs)} of ${formatElapsed(timeoutMs)}`
				: formatElapsed(snapshot.elapsedMs);
		segments.push({ text: elapsedText, role: snapshot.warned ? "warn" : "meta" });
	}

	const plain = `${glyph} ${segments.map((segment) => segment.text).join(options.separator)}`;
	const line: RenderedLine = {
		glyph,
		animate,
		warned: snapshot.warned,
		segments: segments.map((segment) =>
			snapshot.warned ? { text: segment.text, role: "warn" as SegmentRole } : segment,
		),
		plain:
			options.maxWidth > 0 && plain.length > options.maxWidth
				? truncate(plain, options.maxWidth, options.ellipsis)
				: plain,
	};
	return line;
}

// (inlined) 1 internal import statement(s) from src/limits.ts

// ---------------------------------------------------------------- src/limits.ts

/**
 * Reading pi's own provider ceilings.
 *
 * Separate module on purpose: it touches the filesystem but must not import the
 * pi package, so it stays unit-testable with plain `node --test` (config.ts
 * imports pi for the config path and therefore needs the jiti harness).
 *
 * Why we read these at all: retries happen inside a single
 * `before_provider_request` (pi-ai wraps the SDK call in `retryProviderRequest`),
 * so the extension can never count attempts. The best it can do is quote the
 * bound the wait is running against, which turns an open-ended counter into
 * something the user can act on.
 */



/** Mirrors pi's settings-manager defaults. */
export const DEFAULT_PI_RETRY = 3;
export const DEFAULT_PI_MAX_RETRY_DELAY_MS = 60_000;
export const DEFAULT_PI_HTTP_IDLE_TIMEOUT_MS = 300_000;

/**
 * Read `settings.json` (the file pi itself uses) from an explicit path so this
 * module stays pure of pi imports. Missing or corrupt file => pi's defaults.
 */
export function readPiLimits(file: string): ProviderLimits {
	const limits: ProviderLimits = {
		retries: DEFAULT_PI_RETRY,
		maxRetryDelayMs: DEFAULT_PI_MAX_RETRY_DELAY_MS,
		idleMs: DEFAULT_PI_HTTP_IDLE_TIMEOUT_MS,
	};
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return limits;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return limits;

	const raw = parsed as Record<string, unknown>;
	const retry = isSettingsRecord(raw["retry"]) ? raw["retry"] : {};
	const provider = isSettingsRecord(retry["provider"]) ? retry["provider"] : {};

	// `retry.enabled: false` means pi will not retry at all; a 429 then surfaces
	// immediately and the row should not promise retries.
	const enabled = retry["enabled"] !== false;
	const retries = numberOr(provider["maxRetries"], numberOr(retry["maxRetries"], DEFAULT_PI_RETRY));
	limits.retries = enabled ? Math.max(0, retries) : 0;
	limits.maxRetryDelayMs = Math.max(0, numberOr(provider["maxRetryDelayMs"], DEFAULT_PI_MAX_RETRY_DELAY_MS));
	limits.idleMs = Math.max(0, numberOr(raw["httpIdleTimeoutMs"], DEFAULT_PI_HTTP_IDLE_TIMEOUT_MS));
	return limits;
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------- src/smooth.ts

/**
 * Row smoothing: what to write to the status row, and when.
 *
 * Two problems, one place:
 *
 * 1. `setWorkingMessage(undefined)` does NOT hide pi's row. Core renders
 *    `workingMessage ?? "Working..."` (interactive-mode.js), so clearing the row
 *    mid-run replaces our text with core's default. Alternating a clear with our
 *    next paint is a visible strobe at tick rate. So: while the run is live we
 *    never hand the row back; we hold the last row instead.
 *
 * 2. Labels can flip faster than they are readable. A reasoning answer arrives
 *    as thinking-then-answer messages, and `thinking` -> `finishing turn` ->
 *    `thinking` at event rate is flicker, not information. So a new label must
 *    be stable for `labelHoldMs` before it replaces what is on screen - unless
 *    it is more severe (warning, blocking prompt, running tool), which is never
 *    delayed, and unless the shown row is itself getting stale
 *    (`maxHoldMs`), in which case staleness loses.
 *
 * Pure: the caller supplies the clock and performs the actual writes, and the
 * counters make flicker measurable instead of anecdotal.
 */

/** Higher wins the right to repaint immediately. */
export type RowSeverity = 0 | 1 | 2 | 3;

export const SEVERITY: Record<string, RowSeverity> = {
	none: 0,
	model: 1,
	tool: 2,
	attention: 3,
} as const;

export interface RowCandidate {
	/** The words on screen, used for change detection (not the whole row). */
	label: string;
	/** Fully formatted row, exactly as it should be written. */
	text: string;
	severity: RowSeverity;
}

export type RowDecision =
	| { kind: "write"; text: string }
	| { kind: "hold" }
	| { kind: "release" };

export interface SmoothingOptions {
	/** How long a different label must be seen before it replaces the shown one. */
	labelHoldMs: number;
	/** Upper bound on holding: past this, accept a new label rather than go stale. */
	maxHoldMs: number;
}

export function defaultSmoothingOptions(): SmoothingOptions {
	return { labelHoldMs: 300, maxHoldMs: 1500 };
}

export interface SmoothingStats {
	writes: number;
	labelChanges: number;
	/** Label switches we refused because they were not stable yet. */
	suppressed: number;
	holds: number;
	releases: number;
	/** Write rate over the current measurement window. */
	writesPerSecond: number;
	windowMs: number;
}

const WINDOW_MS = 1000;

export class RowSmoother {
	private options: SmoothingOptions;

	private shownLabel: string | undefined;
	private shownText: string | undefined;
	private shownSeverity: RowSeverity = 0;
	private shownAt = 0;

	private pendingLabel: string | undefined;
	private pendingAt = 0;

	private writes = 0;
	private labelChanges = 0;
	private suppressed = 0;
	private holds = 0;
	private releases = 0;

	private windowStart = 0;
	private windowWrites = 0;

	constructor(options: SmoothingOptions = defaultSmoothingOptions()) {
		this.options = { ...options };
	}

	setOptions(options: SmoothingOptions): void {
		this.options = { ...options };
	}

	/**
	 * Decide what to do about the row.
	 *
	 * @param candidate the row we would show, or undefined for "nothing to show"
	 * @param live      true while the agent run is live: then we never release,
	 *                  because core would immediately show its own "Working...".
	 */
	decide(candidate: RowCandidate | undefined, live: boolean, now: number): RowDecision {
		if (!candidate) {
			if (!live) return this.release();
			// Mid-run silence is not "nothing happening": keep the last row.
			this.holds++;
			return { kind: "hold" };
		}

		if (candidate.label === this.shownLabel) {
			if (candidate.text === this.shownText) {
				this.holds++;
				return { kind: "hold" };
			}
			return this.write(candidate, now, false);
		}

		const escalate = this.shownLabel === undefined || candidate.severity > this.shownSeverity;
		if (escalate || this.options.labelHoldMs <= 0) return this.write(candidate, now, true);

		if (this.pendingLabel !== candidate.label) {
			this.pendingLabel = candidate.label;
			this.pendingAt = now;
		}
		const stableEnough = now - this.pendingAt >= this.options.labelHoldMs;
		const shownTooLong = this.shownAt > 0 && now - this.shownAt >= this.options.maxHoldMs;
		if (stableEnough || shownTooLong) return this.write(candidate, now, true);

		this.suppressed++;
		return { kind: "hold" };
	}

	/** Give the row back to core (only valid when the run is over or disabled). */
	release(): RowDecision {
		this.shownLabel = undefined;
		this.shownText = undefined;
		this.shownSeverity = 0;
		this.shownAt = 0;
		this.pendingLabel = undefined;
		this.pendingAt = 0;
		this.releases++;
		return { kind: "release" };
	}

	/** Forget everything, e.g. on session start when core rebuilt the row. */
	reset(): void {
		this.shownLabel = undefined;
		this.shownText = undefined;
		this.shownSeverity = 0;
		this.shownAt = 0;
		this.pendingLabel = undefined;
		this.pendingAt = 0;
		this.writes = 0;
		this.labelChanges = 0;
		this.suppressed = 0;
		this.holds = 0;
		this.releases = 0;
		this.windowStart = 0;
		this.windowWrites = 0;
	}

	stats(now: number): SmoothingStats {
		const windowMs = Math.max(0, now - this.windowStart);
		return {
			writes: this.writes,
			labelChanges: this.labelChanges,
			suppressed: this.suppressed,
			holds: this.holds,
			releases: this.releases,
			writesPerSecond: windowMs > 0 ? (this.windowWrites * 1000) / windowMs : 0,
			windowMs,
		};
	}

	private write(candidate: RowCandidate, now: number, labelChanged: boolean): RowDecision {
		// The very first adoption is not a "change": only real switches count, so
		// the number reported by `/waiting-for` is the number of visible swaps.
		if (labelChanged && this.shownLabel !== undefined) {
			this.labelChanges++;
			this.pendingLabel = undefined;
			this.pendingAt = 0;
		}
		this.shownLabel = candidate.label;
		this.shownText = candidate.text;
		this.shownSeverity = candidate.severity;
		this.shownAt = now;
		this.writes++;

		if (this.windowStart === 0 || now - this.windowStart >= WINDOW_MS) {
			this.windowStart = now;
			this.windowWrites = 1;
		} else {
			this.windowWrites++;
		}
		return { kind: "write", text: candidate.text };
	}
}

// ---------------------------------------------------------------- src/paths.ts

/**
 * Filesystem locations, isolated because they are the only reason to import the
 * pi package outside the adapter.
 *
 * Keeping them here means config.ts and limits.ts stay free of pi imports and
 * can be unit-tested with plain `node --test` - without that split, importing
 * them at all requires jiti plus an aliased pi stub, which is how a config knob
 * that never reached the state machine slipped through unnoticed.
 */


/** `~/.pi/agent/pi-waiting-for.json` (config dir name is not hardcoded). */
export function configPath(): string {
	const base = CONFIG_DIR_NAME.replace(/^\./, "") || "pi";
	return path.join(getAgentDir(), `${base}-waiting-for.json`);
}

/**
 * pi's own settings file. Read only for provider ceilings (retry count, HTTP
 * idle timeout) so a "no response" wait can quote its upper bound; see
 * `readPiLimits` in limits.ts for the parsing.
 */
export function piSettingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

/**
 * Sidecar trace of per-turn provider timing (`traceTurns`, off by default).
 *
 * Deliberately NOT written through `pi.appendEntry()`: what we are timing is
 * pi's completion -> persistence path, and stamping it through that same path
 * would be circular. A sidecar also survives /new, resume, fork and compaction,
 * and can be `tail -f`-ed while a stall happens.
 */
export function turnLogPath(): string {
	const base = CONFIG_DIR_NAME.replace(/^\./, "") || "pi";
	return path.join(getAgentDir(), `${base}-waiting-for-turns.jsonl`);
}

// (inlined) 2 internal import statement(s) from src/config.ts

// ---------------------------------------------------------------- src/config.ts

/**
 * Config for pi-waiting-for.
 *
 * Stored as JSON next to pi's own user config (default:
 * ~/.pi/agent/pi-waiting-for.json). Deliberately independent of pi's
 * settings.json: extensions have no settings API, and keeping our own file
 * means `/waiting-for set` never touches unrelated user settings.
 *
 * No pi import here, on purpose - see paths.ts. That keeps all of this testable
 * with plain `node --test`.
 */



export interface WaitingForConfig extends Thresholds {
	/** Master switch. Off => pi's default working row is restored. */
	enabled: boolean;
	/**
	 * Record per-turn provider timing to the sidecar trace file. Off by default:
	 * it appends one JSON line per assistant message to
	 * `~/.pi/agent/pi-waiting-for-turns.jsonl`. See turnlog.ts for the fields and
	 * how to read them.
	 */
	traceTurns: boolean;
	/** Tick interval for the elapsed clock and honesty check. */
	tickMs: number;
	/** Glyph advance interval while activity is fresh. */
	frameMs: number;
	/** How long a different label must be stable before it replaces the shown one. */
	labelHoldMs: number;
	/** Longest we will hold a row before accepting a new label rather than go stale. */
	maxHoldMs: number;
	/** "auto" picks ASCII for consoles that cannot render braille. */
	renderMode: RenderMode;
	/** Copy of the render options we persist. */
	render: Pick<
		RenderOptions,
		| "frames"
		| "staticGlyph"
		| "warnGlyph"
		| "showTokens"
		| "showElapsed"
		| "showTimeout"
		| "showQueued"
		| "showProgress"
		| "maxTargetLength"
		| "maxWidth"
		| "separator"
		| "ellipsis"
		| "showLimits"
	>;
}

export function defaultConfig(): WaitingForConfig {
	const thresholds = defaultThresholds();
	const render = defaultRenderOptions();
	return {
		enabled: true,
		traceTurns: false,
		staleMs: thresholds.staleMs,
		quietMs: thresholds.quietMs,
		warnMs: thresholds.warnMs,
		settlingGraceMs: thresholds.settlingGraceMs,
		tickMs: 120,
		frameMs: 90,
		labelHoldMs: 300,
		maxHoldMs: 1500,
		renderMode: "auto",
		render: {
			frames: render.frames,
			staticGlyph: render.staticGlyph,
			warnGlyph: render.warnGlyph,
			showTokens: render.showTokens,
			showElapsed: render.showElapsed,
			showTimeout: render.showTimeout,
			showQueued: render.showQueued,
			showProgress: render.showProgress,
			maxTargetLength: render.maxTargetLength,
			maxWidth: render.maxWidth,
			separator: render.separator,
			ellipsis: render.ellipsis,
			showLimits: render.showLimits,
		},
	};
}


const RENDER_MODES = ["auto", "unicode", "ascii"] as const;

/** Config keys settable via `/waiting-for set <key> <value>`. */
export const SETTABLE_KEYS = [
	"enabled",
	"traceTurns",
	"staleMs",
	"quietMs",
	"warnMs",
	"tickMs",
	"frameMs",
	"labelHoldMs",
	"maxHoldMs",
	"settlingGraceMs",
	"showTokens",
	"showElapsed",
	"showTimeout",
	"showQueued",
	"showProgress",
	"showLimits",
	"maxTargetLength",
	"maxWidth",
	"renderMode",
] as const;

export type SettableKey = (typeof SETTABLE_KEYS)[number];

export function loadConfig(file: string): WaitingForConfig {
	const config = defaultConfig();
	try {
		const raw = fs.readFileSync(file, "utf8");
		const parsed = JSON.parse(raw) as Partial<WaitingForConfig> & { render?: Partial<WaitingForConfig["render"]> };
		merge(config as unknown as Record<string, unknown>, parsed);
		sanitize(config);
	} catch {
		// Missing or corrupt file: defaults are fine.
	}
	return config;
}

export function saveConfig(config: WaitingForConfig, file: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

/** Apply `key value` from the slash command. Returns an error string on bad input. */
export function applySet(config: WaitingForConfig, key: string, value: string): string | undefined {
	if (!isSettableKey(key)) {
		return `Unknown key "${key}". Settable: ${SETTABLE_KEYS.join(", ")}`;
	}
	if (key === "enabled") {
		if (value === "true" || value === "on" || value === "1") config.enabled = true;
		else if (value === "false" || value === "off" || value === "0") config.enabled = false;
		else return `enabled expects true/false`;
		return undefined;
	}
	if (key === "traceTurns") {
		if (value === "true" || value === "on" || value === "1") config.traceTurns = true;
		else if (value === "false" || value === "off" || value === "0") config.traceTurns = false;
		else return `traceTurns expects true/false`;
		return undefined;
	}
	if (
		key === "showTokens" ||
		key === "showElapsed" ||
		key === "showTimeout" ||
		key === "showQueued" ||
		key === "showProgress" ||
		key === "showLimits"
	) {
		if (value === "true" || value === "on" || value === "1") config.render[key] = true;
		else if (value === "false" || value === "off" || value === "0") config.render[key] = false;
		else return `${key} expects true/false`;
		return undefined;
	}
	if (key === "renderMode") {
		const mode = value.trim().toLowerCase();
		if (!(RENDER_MODES as readonly string[]).includes(mode)) return `renderMode expects ${RENDER_MODES.join("/")}`;
		config.renderMode = mode as RenderMode;
		return undefined;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return `${key} expects a number`;
	if (key === "maxHoldMs") {
		const maxHoldMs = Math.round(parsed);
		if (maxHoldMs <= config.labelHoldMs) {
			return `maxHoldMs (${maxHoldMs}) must exceed labelHoldMs (${config.labelHoldMs}), else the row could freeze`;
		}
		config.maxHoldMs = maxHoldMs;
		return undefined;
	}
	if (key === "labelHoldMs") {
		config.labelHoldMs = Math.round(parsed);
		// Raising the hold above the staleness bound would freeze the row.
		if (config.maxHoldMs <= config.labelHoldMs) config.maxHoldMs = config.labelHoldMs + 600;
		return undefined;
	}
	const numeric = key as
		| "staleMs"
		| "quietMs"
		| "warnMs"
		| "settlingGraceMs"
		| "tickMs"
		| "frameMs"
		| "labelHoldMs"
		| "maxHoldMs"
		| "maxTargetLength"
		| "maxWidth";
	if (numeric === "maxTargetLength" || numeric === "maxWidth") config.render[numeric] = Math.round(parsed);
	else config[numeric] = Math.round(parsed);
	return undefined;
}

export function thresholdsOf(config: WaitingForConfig): Thresholds {
	return {
		staleMs: config.staleMs,
		quietMs: config.quietMs,
		warnMs: config.warnMs,
		settlingGraceMs: config.settlingGraceMs,
	};
}

function isSettableKey(key: string): key is SettableKey {
	return (SETTABLE_KEYS as readonly string[]).includes(key);
}

function merge(target: Record<string, unknown>, source: Record<string, unknown> | undefined): void {
	if (!source) return;
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const existing = target[key];
		if (isRecord(existing) && isRecord(value)) {
			merge(existing, value);
		} else if (typeof existing === typeof value || existing === undefined) {
			if (existing !== undefined) target[key] = value;
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitize(config: WaitingForConfig): void {
	config.tickMs = clamp(config.tickMs, 50, 1000);
	config.frameMs = clamp(config.frameMs, 40, 1000);
	config.staleMs = clamp(config.staleMs, 100, 5000);
	config.quietMs = clamp(config.quietMs, 200, 30000);
	config.warnMs = clamp(config.warnMs, 1000, 600000);
	config.settlingGraceMs = clamp(config.settlingGraceMs, 0, 5000);
	config.labelHoldMs = clamp(config.labelHoldMs, 0, 5000);
	config.maxHoldMs = clamp(config.maxHoldMs, 250, 30000);
	// A hold longer than the staleness bound would freeze the row forever.
	if (config.maxHoldMs <= config.labelHoldMs) config.maxHoldMs = config.labelHoldMs + 600;
	config.render.maxTargetLength = clamp(config.render.maxTargetLength, 8, 200);
	config.render.maxWidth = clamp(config.render.maxWidth, 0, 400);
	if (!Array.isArray(config.render.frames) || config.render.frames.length === 0) {
		config.render.frames = defaultRenderOptions().frames;
	}
	if (!(RENDER_MODES as readonly string[]).includes(config.renderMode)) {
		config.renderMode = "auto";
	}
	if (typeof config.render.separator !== "string" || !config.render.separator) {
		config.render.separator = defaultRenderOptions().separator;
	}
	if (typeof config.render.ellipsis !== "string" || !config.render.ellipsis) {
		config.render.ellipsis = defaultRenderOptions().ellipsis;
	}
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.round(value)));
}

// ---------------------------------------------------------------- src/turnlog.ts

/**
 * Per-turn provider timing trace.
 *
 * Why: pi stores exactly two timestamps per assistant message - when the
 * message object was created (~= request sent) and when the completed message
 * was written to the session file. litellm/langfuse store three, all on the
 * upstream side (request received, first token, upstream read closed). So when
 * a turn takes two minutes and the model answered in eight seconds, there is no
 * timestamp anywhere inside the interval that holds the answer, and the stall
 * cannot be localised at all.
 *
 * This module stamps the same request from *inside pi's client*, using events
 * the extension already receives:
 *
 *   before_provider_request  -> t_request
 *   after_provider_response  -> t_headers + httpStatus   (headers, not body)
 *   message_start            -> t_stream_start           (first parsed chunk)
 *   message_update           -> t_first/last_delta, deltas, chars
 *   message_end              -> t_message_end
 *
 * Reading a record (all against the two clocks we already trust - the llama.cpp
 * slot log and litellm's langfuse trace):
 *
 *   t_headers fast, t_stream_start late, llama already done
 *       => bytes sat between the model's socket and pi's client.
 *   t_stream_start and t_message_end both prompt, but the session entry lands
 *   ~110s later
 *       => pi-side, after the stream: persistence or an awaited hook.
 *   t_headers - t_request large
 *       => the request was queued before any response, or retried (see
 *          `attempts`).
 *
 * Scope, stated plainly: this measures pi's client side. It can say "the bytes
 * were not here yet", never "the proxy did X".
 *
 * Pure module: no fs, no pi import, injected clock at every call site, so the
 * whole thing runs under plain `node --test`. The single file write lives in
 * extension.ts and is guarded - a failed write must never cost a turn.
 */

export const TURN_RECORD_VERSION = 1;

/** Join keys identifying where a record came from. */
export interface TurnContext {
	session?: string | null;
	cwd?: string | null;
}

/** Identity fields, taken off the finished assistant message. */
export interface TurnIdentity {
	model?: string | null;
	provider?: string | null;
	api?: string | null;
	responseId?: string | null;
	stopReason?: string | null;
}

/** One line of the trace file. Missing stamps stay null, never guessed. */
export interface TurnRecord {
	v: number;
	session: string | null;
	cwd: string | null;
	model: string | null;
	provider: string | null;
	api: string | null;
	responseId: string | null;
	stopReason: string | null;
	/** How many times a request was issued for this message (retries show up here). */
	attempts: number;
	t_request: number | null;
	t_headers: number | null;
	httpStatus: number | null;
	t_stream_start: number | null;
	t_first_delta: number | null;
	t_last_delta: number | null;
	deltas: number;
	chars: number;
	t_message_end: number | null;
}

/**
 * Collects stamps for the assistant message currently in flight and emits one
 * record per `message_end`.
 */
export class TurnTracer {
	private current: TurnRecord | undefined;
	private readonly contextOf: () => TurnContext;

	/**
	 * `contextOf` is called when a record starts, so the adapter can hand over
	 * live session values. Assigned rather than declared as a constructor
	 * parameter property: node strips types without transpiling, and parameter
	 * properties are not strippable.
	 */
	constructor(contextOf: () => TurnContext = () => ({})) {
		this.contextOf = contextOf;
	}

	noteRequest(now: number): void {
		if (this.current) {
			// A second request for the same message is a retry: keep the original
			// t_request so the wait is still measured from when we started.
			this.current.attempts += 1;
			return;
		}
		const context = this.contextOf();
		this.current = {
			v: TURN_RECORD_VERSION,
			session: context.session ?? null,
			cwd: context.cwd ?? null,
			model: null,
			provider: null,
			api: null,
			responseId: null,
			stopReason: null,
			attempts: 1,
			t_request: now,
			t_headers: null,
			httpStatus: null,
			t_stream_start: null,
			t_first_delta: null,
			t_last_delta: null,
			deltas: 0,
			chars: 0,
			t_message_end: null,
		};
	}

	noteResponse(status: number, now: number): void {
		// Last response wins: with retries, the status that produced this message
		// is the interesting one. `attempts` already records that there were others.
		this.note("t_headers", now);
		const current = this.current;
		if (current) current.httpStatus = status;
	}

	noteStreamStart(now: number): void {
		this.note("t_stream_start", now);
	}

	noteDelta(charCount: number, now: number): void {
		const current = this.current;
		if (!current) return;
		if (current.t_first_delta === null) current.t_first_delta = now;
		current.t_last_delta = now;
		current.deltas += 1;
		current.chars += charCount > 0 ? charCount : 0;
	}

	/**
	 * Close the in-flight record.
	 *
	 * Returns undefined when no request was ever seen for this message, which is
	 * how a mid-turn /resume or an externally generated assistant message_end
	 * stays out of the trace: a line with only an end stamp cannot answer any
	 * question, and junk lines cost more than the missing one.
	 */
	finish(identity: TurnIdentity | undefined, now: number): TurnRecord | undefined {
		const current = this.current;
		if (!current) return undefined;
		current.t_message_end = now;
		this.applyIdentity(current, identity);
		return this.take();
	}

	/** Drop whatever is in flight (session switch, abort). Emits nothing. */
	reset(): void {
		this.current = undefined;
	}

	/** True while a record is open - used by tests and by `/waiting-for why`. */
	isOpen(): boolean {
		return this.current !== undefined;
	}

	private applyIdentity(current: TurnRecord, identity: TurnIdentity | undefined): void {
		if (!identity) return;
		current.model = identity.model ?? current.model;
		current.provider = identity.provider ?? current.provider;
		current.api = identity.api ?? current.api;
		current.responseId = identity.responseId ?? current.responseId;
		current.stopReason = identity.stopReason ?? current.stopReason;
	}

	private note(field: "t_headers" | "t_stream_start", now: number): void {
		const current = this.current;
		if (!current) return;
		if (current[field] === null) current[field] = now;
	}

	private take(): TurnRecord {
		const record = this.current as TurnRecord;
		this.current = undefined;
		return record;
	}
}

/** Derived waits, in ms. Null whenever an operand is missing. */
export interface TurnWaits {
	headersMs: number | null;
	ttfbMs: number | null;
	streamMs: number | null;
	tailMs: number | null;
	totalMs: number | null;
}

export function waitsOf(record: TurnRecord): TurnWaits {
	const streamEnd = record.t_last_delta ?? record.t_stream_start;
	return {
		// Request handed to the HTTP client -> response headers back.
		headersMs: diff(record.t_headers, record.t_request),
		// Request -> first parsed stream chunk. What "no first token" looks like.
		ttfbMs: diff(record.t_stream_start, record.t_request),
		// First chunk -> last chunk: whether bytes trickle or land in one lump.
		streamMs: diff(record.t_last_delta ?? record.t_message_end, record.t_stream_start),
		// Last chunk -> message_end: pi's own parse/settle time after the wire is done.
		tailMs: diff(record.t_message_end, streamEnd),
		totalMs: diff(record.t_message_end, record.t_request),
	};
}

/** One-line rendering of a record, for `/waiting-for why`. */
export function formatTurnRecord(record: TurnRecord): string {
	const waits = waitsOf(record);
	const parts: string[] = [];
	parts.push(`headers ${formatMs(waits.headersMs)}`);
	parts.push(`first chunk ${formatMs(waits.ttfbMs)}`);
	parts.push(`stream ${formatMs(waits.streamMs)} (${record.deltas} deltas, ${record.chars}ch)`);
	parts.push(`tail ${formatMs(waits.tailMs)}`);
	parts.push(`total ${formatMs(waits.totalMs)}`);
	if (record.attempts > 1) parts.push(`attempts ${record.attempts}`);
	if (record.httpStatus !== null) parts.push(`http ${record.httpStatus}`);
	if (record.stopReason) parts.push(record.stopReason);
	const who = [record.model, record.responseId].filter(Boolean).join(" ");
	return who ? `${who}: ${parts.join("  ")}` : parts.join("  ");
}

/** Parse one trace line. Returns undefined for blank or corrupt lines. */
export function parseTurnLine(line: string): TurnRecord | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed) as Partial<TurnRecord>;
		if (!parsed || typeof parsed !== "object" || typeof parsed.v !== "number") return undefined;
		return {
			v: parsed.v,
			session: stringOr(parsed.session),
			cwd: stringOr(parsed.cwd),
			model: stringOr(parsed.model),
			provider: stringOr(parsed.provider),
			api: stringOr(parsed.api),
			responseId: stringOr(parsed.responseId),
			stopReason: stringOr(parsed.stopReason),
			attempts: finiteNumberOr(parsed.attempts, 1),
			t_request: numberOrNull(parsed.t_request),
			t_headers: numberOrNull(parsed.t_headers),
			httpStatus: numberOrNull(parsed.httpStatus),
			t_stream_start: numberOrNull(parsed.t_stream_start),
			t_first_delta: numberOrNull(parsed.t_first_delta),
			t_last_delta: numberOrNull(parsed.t_last_delta),
			deltas: finiteNumberOr(parsed.deltas, 0),
			chars: finiteNumberOr(parsed.chars, 0),
			t_message_end: numberOrNull(parsed.t_message_end),
		};
	} catch {
		return undefined;
	}
}

function diff(end: number | null, start: number | null): number | null {
	if (end === null || start === null) return null;
	const value = end - start;
	return Number.isFinite(value) ? value : null;
}

function formatMs(value: number | null): string {
	if (value === null) return "-";
	if (value < 1000) return `${value}ms`;
	return `${(value / 1000).toFixed(2)}s`;
}

function stringOr(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteNumberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// (inlined) 7 internal import statement(s) from src/extension.ts

// ---------------------------------------------------------------- src/extension.ts

/**
 * pi-waiting-for — pi adapter.
 *
 * Why this exists: pi's "Working" row is a blind frame cycler (pi-tui Loader
 * setInterval) that animates identically whether tokens are arriving, the
 * network is stalled, or a local command has been silent for 40 seconds.
 *
 * Mechanism (verified against pi 0.84.4):
 *   - setWorkingIndicator({ frames: [] }) removes the built-in glyph *and*
 *     starts no internal timer (Loader.restartAnimation returns early when
 *     frames.length <= 1), while keeping the row itself visible.
 *   - setWorkingIndicator() called per frame would reset currentFrame to 0 and
 *     restart the internal timer, so we NEVER poke it per tick.
 *   - setWorkingMessage(text) repaints without touching frames/timers, and only
 *     applies while the active indicator is the "working" one — which is
 *     exactly the guard we want so core's retry / compaction rows win.
 *
 * So: we own the clock and render everything into the message text.
 */




/** Preferred "what is it doing" argument per built-in tool. */
const TARGET_KEYS: Record<string, string[]> = {
	bash: ["command"],
	powershell: ["command"],
	read: ["path"],
	write: ["path"],
	edit: ["path"],
	grep: ["pattern"],
	find: ["pattern"],
	ls: ["path"],
};

const GENERIC_TARGET_KEYS = ["command", "path", "query", "pattern", "url", "name", "prompt"];

function targetOf(toolName: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	for (const key of [...(TARGET_KEYS[toolName] ?? []), ...GENERIC_TARGET_KEYS]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return undefined;
}

function countLines(text: string): number {
	if (!text) return 0;
	let count = 0;
	for (const line of text.split("\n")) if (line.length > 0) count++;
	return count;
}

/** pi sends *accumulated* partial results, so measure totals, not deltas. */
function measureOutput(partialResult: unknown): { chars: number; lines: number } {
	const content = (partialResult as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return { chars: content.length, lines: countLines(content) };
	if (!Array.isArray(content)) return { chars: 0, lines: 0 };
	let chars = 0;
	let lines = 0;
	for (const part of content) {
		const text = (part as { type?: string; text?: unknown } | undefined)?.text;
		if ((part as { type?: string } | undefined)?.type === "text" && typeof text === "string") {
			chars += text.length;
			lines += countLines(text);
		}
	}
	return { chars, lines };
}

/** bash/powershell take an optional `timeout` in *seconds*. */
function timeoutMsOf(toolName: string, args: unknown): number | undefined {
	if (toolName !== "bash" && toolName !== "powershell") return undefined;
	const value = (args as { timeout?: unknown } | undefined)?.timeout;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.round(value * 1000);
}

/** Session id for trace join keys. pi's session manager is read-only here. */
function sessionIdOf(ctx: ExtensionContext): string | null {
	try {
		const manager = ctx.sessionManager as { getSessionId?: () => string } | undefined;
		const id = manager?.getSessionId?.();
		return typeof id === "string" && id.length > 0 ? id : null;
	} catch {
		return null;
	}
}

/**
 * Append one trace record. Guarded twice over: a trace that can cost a turn is
 * worse than no trace, so nothing here may throw into the caller.
 */
function appendTurnRecord(record: TurnRecord): void {
	try {
		fs.appendFile(turnLogPath(), `${JSON.stringify(record)}\n`, (error) => {
			if (error) return;
		});
	} catch {
		// Discarded: the row and the turn are unaffected.
	}
}

/** Tail the trace without pulling a long-running log into memory. */
function tailTurnLog(file: string, count: number): TurnRecord[] {
	let handle: number | undefined;
	try {
		const size = fs.statSync(file).size;
		const want = Math.min(size, 64 * 1024);
		const buffer = Buffer.allocUnsafe(want);
		handle = fs.openSync(file, "r");
		fs.readSync(handle, buffer, 0, want, size - want);
		const lines = buffer.toString("utf8").split("\n");
		// First line is a fragment unless we happened to start at byte 0.
		if (size > want) lines.shift();
		const records: TurnRecord[] = [];
		for (const line of lines) {
			const record = parseTurnLine(line);
			if (record) records.push(record);
		}
		return records.slice(-count);
	} catch {
		return [];
	} finally {
		if (handle !== undefined) {
			try {
				fs.closeSync(handle);
			} catch {
				// Already read what we needed.
			}
		}
	}
}

/** String field names extension tools commonly use for progress state. */
const PROGRESS_STRING_KEYS = [
	"status",
	"message",
	"phase",
	"state",
	"activity",
	"currentTool",
	"label",
	"description",
	// Subagent-style tools report `{ mode: "parallel", results: [...] }`; least
	// specific, so a real status/message still wins.
	"mode",
];

/** Numeric fields rendered as `key=value` counters. */
const PROGRESS_COUNT_KEYS = ["toolCalls", "tools", "completed", "total", "tokens", "files", "lines", "steps", "count"];

/**
 * Derive a short progress hint from a tool's structured `details`. Built-in
 * tools put nothing useful here (bash reports truncation), so this exists for
 * extension tools such as subagent runners, which report things like
 * `{ mode: "parallel", results: [...] }`.
 */
function summarizeDetails(details: unknown): string | undefined {
	if (typeof details === "string") return details.trim() || undefined;
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const record = details as Record<string, unknown>;
	const pieces: string[] = [];

	for (const key of PROGRESS_STRING_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			pieces.push(value.trim());
			break;
		}
	}

	const results = record["results"];
	if (Array.isArray(results)) {
		const done = results.filter((entry) => entry !== undefined && entry !== null).length;
		if (results.length > 0) pieces.push(done === results.length ? `${done} done` : `${done}/${results.length} done`);
	}

	for (const key of PROGRESS_COUNT_KEYS) {
		if (pieces.length >= 3) break;
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) pieces.push(`${key}=${value}`);
	}

	return pieces.length > 0 ? pieces.join(" ") : undefined;
}

/** Config merged with the resolved glyph set (ASCII on plain consoles). */
function renderOptionsOf(config: WaitingForConfig, limits?: ProviderLimits): RenderOptions {
	const base: RenderOptions = { ...defaultRenderOptions(), ...config.render };
	if (limits) base.limits = limits;
	return resolveRenderOptions(base, config.renderMode);
}

export default function waitingFor(pi: ExtensionAPI): void {
	let config: WaitingForConfig = loadConfig(configPath());
	/** pi's retry/idle ceilings, re-read on refresh so `/settings` changes show up. */
	let limits: ProviderLimits = readPiLimits(piSettingsPath());
	const state = new WaitingState(thresholdsOf(config));
	/** Decides what to write, so flicker policy lives in one testable place. */
	const smoother = new RowSmoother({ labelHoldMs: config.labelHoldMs, maxHoldMs: config.maxHoldMs });

	let ctxRef: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let frameIndex = 0;
	let lastFrameAt = 0;
	/** Plain text last written to the row, for render dedupe. */
	let painted: string | undefined;
	/** Set when we have taken over the working row, so restore is symmetric. */
	let takenOver = false;

	// --------------------------------------------------------- turn tracing
	// Read lazily so /new and /resume inside this process show up in the records.
	let sessionIdRef: string | null = null;
	let cwdRef: string | null = null;
	const tracer = new TurnTracer(() => ({ session: sessionIdRef, cwd: cwdRef }));

	// ------------------------------------------------------------------ ui

	const uiOf = (): ExtensionUIContext | undefined => {
		const ctx = ctxRef;
		if (!ctx || !ctx.hasUI) return undefined;
		if (typeof ctx.ui.setWorkingMessage !== "function") return undefined;
		return ctx.ui;
	};

	const HIDDEN_INDICATOR: WorkingIndicatorOptions = { frames: [] };

	const takeOver = (): void => {
		const ui = uiOf();
		if (!ui || takenOver) return;
		ui.setWorkingVisible?.(true);
		ui.setWorkingIndicator?.(HIDDEN_INDICATOR);
		takenOver = true;
	};

	const restore = (): void => {
		const ui = uiOf();
		if (!ui) return;
		smoother.release();
		if (takenOver) ui.setWorkingIndicator?.(undefined);
		ui.setWorkingMessage?.(undefined);
		painted = undefined;
		takenOver = false;
	};

	/**
	 * How urgent this row is. Escalations bypass label hysteresis: a warning, a
	 * blocking prompt or a running command must show up on the next write, never
	 * after a hold.
	 */
	const severityOf = (snapshot: Snapshot, line: RenderedLine): RowSeverity => {
		if (line.warned || snapshot.phase === "prompt") return SEVERITY.attention;
		if (snapshot.phase === "toolRun") return SEVERITY.tool;
		if (snapshot.phase === "modelStream" || snapshot.phase === "modelAwait" || snapshot.phase === "modelStall") {
			return SEVERITY.model;
		}
		return SEVERITY.none;
	};

	const colorize = (ui: ExtensionUIContext, line: RenderedLine, separator: string): string => {
		const theme = ui.theme;
		const glyphColor = line.animate ? "accent" : line.warned ? "warning" : "dim";
		const parts = line.segments.map((segment) => {
			if (segment.role === "warn") return theme.fg("warning", segment.text);
			if (segment.role === "label") return theme.fg("muted", segment.text);
			return theme.fg("dim", segment.text);
		});
		return `${theme.fg(glyphColor, line.glyph)} ${parts.join(theme.fg("dim", separator))}`;
	};

	// --------------------------------------------------------------- clock

	const paint = (): void => {
		const ui = uiOf();
		if (!ui) return;
		if (!config.enabled) {
			restore();
			return;
		}
		takeOver();
		const snapshot = state.snapshot();
		const now = snapshot.now;
		if (snapshot.fresh && now - lastFrameAt >= config.frameMs) {
			frameIndex = (frameIndex + 1) % 1000;
			lastFrameAt = now;
		}
		const options = renderOptionsOf(config, limits);
		const line = renderLine(snapshot, frameIndex, options);
		const candidate: RowCandidate | undefined = line
			? {
					label: line.segments[0]?.text ?? "",
					text: colorize(ui, line, options.separator),
					severity: severityOf(snapshot, line),
				}
			: undefined;

		// While the run is live we never write undefined: core renders
		// `workingMessage ?? "Working..."`, so a mid-run clear is exactly the
		// "Working" <-> our-row strobe this is meant to stop.
		const decision = smoother.decide(candidate, state.isRunLive(), now);
		if (decision.kind === "write") {
			if (painted === decision.text) return;
			painted = decision.text;
			ui.setWorkingMessage(decision.text);
			return;
		}
		if (decision.kind === "release" && painted !== undefined) {
			painted = undefined;
			ui.setWorkingMessage(undefined);
		}
	};

	const tick = (): void => {
		try {
			paint();
		} catch {
			// Never let a status line break the agent.
		}
		// Stop only when the run is truly over. A momentary idle phase inside a live
		// run must not stop the clock and hand the row back to core's default text.
		if (!state.isActive() && !state.isRunLive()) {
			stopTimer();
			const ui = uiOf();
			if (ui && painted !== undefined) {
				smoother.release();
				ui.setWorkingMessage(undefined);
				painted = undefined;
			}
		}
	};

	const startTimer = (): void => {
		if (timer || !config.enabled) return;
		if (!uiOf()) return;
		timer = setInterval(tick, config.tickMs);
	};

	const stopTimer = (): void => {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	};

	const refresh = (): void => {
		// pi's retry/idle ceilings can change via /settings, and a ceilings change on
		// its own has to repaint a row that is already showing, so re-read here and
		// force a redraw by dropping the dedupe key.
		limits = readPiLimits(piSettingsPath());
		smoother.setOptions({ labelHoldMs: config.labelHoldMs, maxHoldMs: config.maxHoldMs });
		state.setThresholds(thresholdsOf(config));
		if (!config.enabled) {
			stopTimer();
			restore();
			return;
		}
		takeOver();
		if (state.isActive()) {
			startTimer();
			paint();
		}
	};

	// -------------------------------------------------------------- events

	pi.on("session_start", async (event, ctx) => {
		ctxRef = ctx;
		cwdRef = ctx.cwd ?? null;
		sessionIdRef = sessionIdOf(ctx);
		config = loadConfig(configPath());
		state.reset();
		// An in-flight turn from a previous session must not leak into this one.
		tracer.reset();
		// Core rebuilds the row on (re)load, so start from "nothing shown".
		smoother.reset();
		frameIndex = 0;
		lastFrameAt = 0;
		painted = undefined;
		takenOver = false;
		stopTimer();
		// pi resets workingMessage/workingVisible/indicator on reload, so we
		// must re-apply our takeover after it rather than only once at boot.
		if (config.enabled && ctx.hasUI) {
			takeOver();
		}
		void event.reason;
	});

	pi.on("agent_start", async (_event, ctx) => {
		ctxRef = ctx;
		state.onAgentStart();
		refresh();
	});

	pi.on("turn_start", async (_event, ctx) => {
		ctxRef = ctx;
		state.onTurnStart();
		refresh();
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		ctxRef = ctx;
		state.onProviderRequest();
		if (config.traceTurns) tracer.noteRequest(Date.now());
		startTimer();
	});

	pi.on("after_provider_response", async (event, ctx) => {
		ctxRef = ctx;
		state.onProviderResponse(event.status);
		if (config.traceTurns) tracer.noteResponse(event.status, Date.now());
		startTimer();
	});

	pi.on("message_start", async (event, ctx) => {
		ctxRef = ctx;
		if (event.message.role === "assistant") {
			state.onMessageStart();
			if (config.traceTurns) tracer.noteStreamStart(Date.now());
		}
		startTimer();
	});

	// High frequency (per streamed chunk): keep this O(1), never render here.
	pi.on("message_update", async (event, ctx) => {
		ctxRef = ctx;
		const streamEvent = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
		const kind = streamKindFromEvent(streamEvent?.type);
		const delta = streamEvent?.delta;
		const deltaLength = typeof delta === "string" ? delta.length : 0;
		state.onStream(kind ?? "text", deltaLength);
		// Stamped per chunk only while tracing is on: two compares and a store.
		if (config.traceTurns) tracer.noteDelta(deltaLength, Date.now());
	});

	pi.on("message_end", async (event, ctx) => {
		ctxRef = ctx;
		if (event.message.role !== "assistant") return;
		state.onMessageEnd();
		if (!config.traceTurns) return;
		const identity: TurnIdentity = {
			model: event.message.model,
			provider: event.message.provider,
			api: event.message.api,
			responseId: event.message.responseId ?? null,
			stopReason: event.message.stopReason ?? null,
		};
		const record = tracer.finish(identity, Date.now());
		if (record) appendTurnRecord(record);
	});

	// tool_call fires before execution and is awaited, so counting calls that have
	// not reached tool_execution_start reveals sequential batches waiting in line.
	pi.on("tool_call", async (event, ctx) => {
		ctxRef = ctx;
		state.onToolQueued(event.toolCallId, event.toolName);
	});

	pi.on("tool_execution_start", async (event: ToolExecutionStartEvent, ctx) => {
		ctxRef = ctx;
		state.onToolStart(event.toolCallId, event.toolName, targetOf(event.toolName, event.args), {
			timeoutMs: timeoutMsOf(event.toolName, event.args),
		});
		refresh();
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		ctxRef = ctx;
		const { chars, lines } = measureOutput(event.partialResult);
		state.onToolOutput(event.toolCallId, chars, lines, summarizeDetails(event.partialResult?.details));
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		ctxRef = ctx;
		state.onToolEnd(event.toolCallId);
		refresh();
	});

	pi.on("ui_prompt_start", async (event, ctx) => {
		ctxRef = ctx;
		state.onPromptStart(event.title);
		refresh();
	});

	pi.on("ui_prompt_end", async (_event, ctx) => {
		ctxRef = ctx;
		state.onPromptEnd();
		refresh();
	});

	pi.on("turn_end", async (_event, ctx) => {
		ctxRef = ctx;
		state.onTurnEnd();
		startTimer();
	});

	pi.on("agent_end", async (_event, ctx) => {
		ctxRef = ctx;
		state.onAgentEnd();
		stopTimer();
		if (painted !== undefined) {
			uiOf()?.setWorkingMessage(undefined);
			painted = undefined;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		ctxRef = ctx;
		state.onAgentEnd();
		stopTimer();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctxRef = ctx;
		stopTimer();
		state.reset();
		tracer.reset();
		restore();
	});

	// ------------------------------------------------------------- command

	const describe = (): string => {
		const snapshot = state.snapshot();
		const options = renderOptionsOf(config, limits);
		const line = renderLine(snapshot, frameIndex, options);
		const configLine = `enabled=${config.enabled} stale=${config.staleMs}ms quiet=${config.quietMs}ms warn=${config.warnMs}ms tick=${config.tickMs}ms tokens=${config.render.showTokens}`;
		const glyphLine = `glyphs=${detectRenderMode()} (renderMode=${config.renderMode})`;
		const limitLine = `pi ceilings: ${formatLimits(limits, options.ascii) || "none advertised"}`;
		const traceLine = `turn trace: ${config.traceTurns ? "on" : "off"} -> ${turnLogPath()}`;
		const separator = options.separator;
		const lastLine = `last run  ${formatRunStats(state.getLastStats(), separator)}`;
		const currentLine = `this run  ${formatRunStats(state.getStats(), separator)}`;
		const smoothing = smoother.stats(snapshot.now);
		const flickerLine =
			`row writes: ${smoothing.writes} (${smoothing.writesPerSecond.toFixed(1)}/s over `
			+ `${Math.round(smoothing.windowMs)}ms), labels ${smoothing.labelChanges}, `
			+ `flickers suppressed ${smoothing.suppressed}, releases ${smoothing.releases} `
			+ `(hold ${config.labelHoldMs}ms/max ${config.maxHoldMs}ms, grace ${config.settlingGraceMs}ms)`;
		return [
			`now: ${line ? line.plain : `${snapshot.phase} (nothing running)`}`,
			configLine,
			glyphLine,
			limitLine,
			traceLine,
			lastLine,
			currentLine,
			flickerLine,
			`config: ${configPath()}`,
			`set: /waiting-for set <${SETTABLE_KEYS.join("|")}> <value>`,
		].join("\n");
	};

	pi.registerCommand("waiting-for", {
		description: "Honest working indicator: status, on/off, thresholds.",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const [sub = "status", ...rest] = args.trim().split(/\s+/);
			const ui = ctx.hasUI ? ctx.ui : undefined;

			// "why did this turn take so long" - the derived waits, newest last.
			if (sub === "why") {
				const count = Math.min(50, Math.max(1, Number(rest[0]) || 5));
				const records = tailTurnLog(turnLogPath(), count);
				if (records.length === 0) {
					ui?.notify(
						`No trace records yet.\nfile: ${turnLogPath()}`
						+ `\ntraceTurns=${config.traceTurns}`
						+ (config.traceTurns ? "" : "  -> /waiting-for set traceTurns true"),
						"info",
					);
					return;
				}
				ui?.notify(
					[`last ${records.length} turns (${turnLogPath()})`, ...records.map(formatTurnRecord)].join("\n"),
					"info",
				);
				return;
				}

			if (sub === "on" || sub === "off") {
				config.enabled = sub === "on";
				try {
					saveConfig(config, configPath());
				} catch (error) {
					ui?.notify(`Could not save config: ${String(error)}`, "error");
				}
				refresh();
				ui?.notify(`pi-waiting-for ${config.enabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (sub === "set") {
				const key = rest[0];
				const value = rest.slice(1).join(" ");
				if (!key || !value) {
					ui?.notify(`Usage: /waiting-for set <${SETTABLE_KEYS.join("|")}> <value>`, "error");
					return;
				}
				const error = applySet(config, key, value);
				if (error) {
					ui?.notify(error, "error");
					return;
				}
				try {
					saveConfig(config, configPath());
				} catch (saveError) {
					ui?.notify(`Could not save config: ${String(saveError)}`, "error");
				}
				refresh();
				ui?.notify(`pi-waiting-for: ${key} = ${value}`, "info");
				return;
			}

			if (sub === "reset") {
				config = defaultConfig();
				try {
					saveConfig(config, configPath());
				} catch {
					// Best effort; in-memory reset still applies.
				}
				refresh();
				ui?.notify("pi-waiting-for: defaults restored", "info");
				return;
			}

			ui?.notify(describe(), "info");
		},
	});

	// --------------------------------------------------------------- flags

	pi.registerFlag("waiting-for", { description: "pi-waiting-for mode: on|off", type: "string" });
	const flag = pi.getFlag("waiting-for");
	if (typeof flag === "string") {
		const value = flag.trim().toLowerCase();
		if (value === "off" || value === "false") config = { ...config, enabled: false };
		else if (value === "on" || value === "true") config = { ...config, enabled: true };
	}

	// A `--waiting-for off` flag for this run must also stop any running clock.
	if (!config.enabled) stopTimer();
}
