import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	access,
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_ASK_CONFIG,
	normalizeAskConfig,
	toAskConfigFileV5,
} from "./defaults.ts";
import { AskConfigMigrationError, migrateAskConfig } from "./migrate.ts";
import { CURRENT_ASK_CONFIG_SCHEMA_VERSION } from "./migrations/index.ts";
import type {
	AskAnswerModelPreference,
	AskConfig,
	AskConfigFileV5,
} from "./schema.ts";

const INVALID_CONFIG_NOTICE =
	"Config was invalid or unsupported. Loaded defaults for this session and left the config file unchanged. Edit the config file or run /reload after fixing it.";
const MIGRATION_FAILED_NOTICE =
	"Config migration failed. Loaded defaults for this session and left the config file unchanged. Edit the config file or run /reload after fixing it.";

export interface AskConfigNotice {
	kind: "error" | "warning" | "success";
	text: string;
}

interface AskConfigLoadResult {
	config: AskConfig;
	notice?: AskConfigNotice;
}

/** Minimal config update. Only the provided slices are merged over disk. */
export interface AskConfigPatch {
	answer?: Partial<AskConfig["answer"]>;
	behaviour?: Partial<AskConfig["behaviour"]>;
	keymaps?: Partial<AskConfig["keymaps"]>;
	notifications?: Partial<AskConfig["notifications"]>;
}

export async function writeJsonFileAtomic(
	filePath: string,
	data: unknown
): Promise<void> {
	const content = JSON.stringify(data, null, 2).concat("\n");
	const dir = dirname(filePath);
	await mkdir(dir, { recursive: true });

	// Preserve user-managed filesystem shape. A bare rename would silently
	// replace a read-only file when the directory is writable, and would swap
	// a symlinked config (dotfiles managers) for a regular file.
	const existingStat = await lstatSafe(filePath);
	if (existingStat?.isSymbolicLink()) {
		await writeFile(filePath, content, "utf-8");
		return;
	}
	if (existingStat) {
		await access(filePath, constants.W_OK);
	}

	const tempPath = join(
		dir,
		`.${basename(filePath)}.tmp-${process.pid}-${randomUUID()}`
	);
	const handle = await open(
		tempPath,
		"wx",
		existingStat ? toPermissionBits(existingStat.mode) : 0o666
	);
	try {
		await handle.writeFile(content, "utf-8");
		await handle.sync();
		await handle.close();
	} catch (error) {
		try {
			await rm(tempPath, { force: true });
		} catch {
			// ignore cleanup error
		}
		throw error;
	}
	if (existingStat) {
		try {
			await chmod(tempPath, toPermissionBits(existingStat.mode));
		} catch {
			// Keep umask-derived mode when the original mode cannot be kept.
		}
	}
	try {
		await rename(tempPath, filePath);
	} catch (error) {
		try {
			await rm(tempPath, { force: true });
		} catch {
			// ignore cleanup error
		}
		throw error;
	}
}

function toPermissionBits(mode: number): number {
	// Low nine permission bits without tripping the no-bitwise lint rule.
	return mode % 0o1000;
}

async function lstatSafe(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (isMissingFileError(error)) {
			return;
		}
		throw error;
	}
}

export class AskConfigStore {
	private config?: AskConfig;
	private loadPromise?: Promise<AskConfigLoadResult>;
	private notice?: AskConfigNotice;
	private readonly listeners = new Set<(config: AskConfig) => void>();
	private readonly configPath: string;
	private readonly legacyConfigPaths: string[];

	constructor(configPath?: string, legacyConfigPaths?: string[]) {
		this.configPath = configPath ?? getAskConfigPath();
		this.legacyConfigPaths = (
			legacyConfigPaths ?? (configPath ? [] : getLegacyAskConfigPaths())
		).filter((path) => path !== this.configPath);
	}

	subscribe(onChange: (config: AskConfig) => void): () => void {
		this.listeners.add(onChange);
		return () => {
			this.listeners.delete(onChange);
		};
	}

	async ensureLoaded(): Promise<AskConfigLoadResult> {
		if (this.config) {
			return { config: this.config, notice: this.notice };
		}
		if (!this.loadPromise) {
			this.loadPromise = this.loadFromDisk();
		}
		const result = await this.loadPromise;
		this.config = result.config;
		this.notice = result.notice;
		this.loadPromise = undefined;
		return result;
	}

	async getConfig(): Promise<AskConfig> {
		return (await this.ensureLoaded()).config;
	}

	async save(config: AskConfig | AskConfigPatch): Promise<AskConfig> {
		try {
			const rawContent = await this.readDiskConfig();
			const existing = parseJsonObject(rawContent);
			const merged = mergeConfigFileData(existing, config);

			await writeJsonFileAtomic(this.configPath, merged);

			const normalized = normalizeAskConfig(
				merged as unknown as Partial<AskConfigFileV5>
			);
			this.setConfig(normalized);
			return normalized;
		} catch (error) {
			throw createConfigSaveError(this.configPath, error);
		}
	}

	setConfig(config: AskConfig): void {
		this.config = normalizeAskConfig(config);
		this.notice = undefined;
		for (const listener of this.listeners) {
			listener(this.config);
		}
	}

	private async loadFromDisk(): Promise<AskConfigLoadResult> {
		const content = await this.readDiskConfig();
		if (content === undefined) {
			return this.loadMissingConfig();
		}

		const parsed = parseJson(content);
		if (!parsed.ok) {
			return this.loadDefaultsWithNotice(INVALID_CONFIG_NOTICE);
		}

		return this.loadParsedConfig(parsed.value);
	}

	private async readDiskConfig(): Promise<string | undefined> {
		for (const path of [this.configPath, ...this.legacyConfigPaths]) {
			const content = await readConfigFileIfPresent(path);
			if (content !== undefined) {
				return content;
			}
		}
	}

	private async loadMissingConfig(): Promise<AskConfigLoadResult> {
		const config = normalizeAskConfig(DEFAULT_ASK_CONFIG);
		try {
			await this.save(config);
			return { config };
		} catch (saveError) {
			return {
				config,
				notice: {
					kind: "warning",
					text: getErrorMessage(saveError),
				},
			};
		}
	}

	private loadParsedConfig(parsed: unknown): AskConfigLoadResult {
		try {
			const migrated = migrateAskConfig(parsed);
			return {
				config: migrated.config,
				notice: migrated.notice
					? {
							kind: "error",
							text: migrated.notice,
						}
					: undefined,
			};
		} catch (error) {
			if (error instanceof AskConfigMigrationError) {
				return this.loadDefaultsWithNotice(
					error.reason === "migration_failed"
						? MIGRATION_FAILED_NOTICE
						: INVALID_CONFIG_NOTICE
				);
			}
			throw error;
		}
	}

	private loadDefaultsWithNotice(text: string): AskConfigLoadResult {
		return {
			config: normalizeAskConfig(DEFAULT_ASK_CONFIG),
			notice: {
				kind: "error",
				text,
			},
		};
	}
}

let askConfigStore: AskConfigStore | undefined;
let testSandboxDir: string | undefined;

export function isTestEnvironment(): boolean {
	return (
		process.env.NODE_ENV === "test" ||
		process.env.PI_ASK_TEST === "1" ||
		Boolean(process.env.NODE_TEST_CONTEXT) ||
		process.execArgv.some((arg) => arg.includes("test")) ||
		process.argv.some(
			(arg) =>
				arg.endsWith(".test.ts") ||
				arg.endsWith(".test.js") ||
				arg.includes("node:test")
		)
	);
}

export function getTestSandboxDir(): string {
	if (!testSandboxDir) {
		testSandboxDir = join(tmpdir(), `pi-ask-test-sandbox-${process.pid}`);
	}
	return testSandboxDir;
}

export function setTestSandboxDir(dir: string | undefined): void {
	testSandboxDir = dir;
}

export function getAskConfigBaseDir(): string {
	if (process.env.PI_CODING_AGENT_DIR) {
		return process.env.PI_CODING_AGENT_DIR;
	}
	if (isTestEnvironment()) {
		return getTestSandboxDir();
	}
	return getAgentDir();
}

export function getAskConfigStore(): AskConfigStore {
	askConfigStore ??= new AskConfigStore();
	return askConfigStore;
}

export function setAskConfigStore(store: AskConfigStore | undefined): void {
	askConfigStore = store;
}

export function resetAskConfigStore(): void {
	askConfigStore = undefined;
}

export function getAskConfigPath(): string {
	return join(getAskConfigBaseDir(), "extensions", "eko24ive-pi-ask.json");
}

export function getLegacyAskConfigPaths(): string[] {
	return [join(getAskConfigBaseDir(), "eko24ive-pi-ask.json")];
}

function parseJsonObject(content: string | undefined): Record<string, unknown> {
	if (content === undefined) {
		return {};
	}
	const parsed = parseJson(content);
	if (
		parsed.ok &&
		parsed.value &&
		typeof parsed.value === "object" &&
		!Array.isArray(parsed.value)
	) {
		return parsed.value as Record<string, unknown>;
	}
	return {};
}

function getRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

function mergeTopLevelKeys(
	target: Record<string, unknown>,
	source: AskConfig | AskConfigPatch
): void {
	for (const [key, value] of Object.entries(source)) {
		if (
			value !== undefined &&
			![
				"schemaVersion",
				"answer",
				"behaviour",
				"keymaps",
				"notifications",
			].includes(key)
		) {
			target[key] = value;
		}
	}
}

function mergeBehaviour(
	target: Record<string, unknown>,
	behaviour?: Partial<AskConfig["behaviour"]>
): void {
	if (!behaviour) {
		return;
	}
	const existing = getRecord(target.behaviour);
	target.behaviour = {
		...existing,
		...behaviour,
	};
}

function mergeNotifications(
	target: Record<string, unknown>,
	notifications?: Partial<AskConfig["notifications"]>
): void {
	if (!notifications) {
		return;
	}
	const existing = getRecord(target.notifications);
	target.notifications = {
		...existing,
		...(notifications.channels === undefined
			? {}
			: { channels: notifications.channels }),
		...(notifications.enabled === undefined
			? {}
			: { enabled: notifications.enabled }),
	};
}

const ASK_KEYMAP_SECTIONS = [
	"global",
	"main",
	"editor",
	"noteEditor",
	"settingsModal",
] as const;

function mergeKeymaps(
	target: Record<string, unknown>,
	keymaps?: Partial<AskConfig["keymaps"]>
): void {
	if (!keymaps) {
		return;
	}
	const existing = getRecord(target.keymaps);
	const merged: Record<string, unknown> = { ...existing };
	for (const section of ASK_KEYMAP_SECTIONS) {
		const sourceSection = keymaps[section];
		if (sourceSection === undefined) {
			continue;
		}
		merged[section] = {
			...getRecord(existing[section]),
			...(sourceSection as Record<string, unknown>),
		};
	}
	for (const [key, value] of Object.entries(keymaps)) {
		if (
			value !== undefined &&
			!(ASK_KEYMAP_SECTIONS as readonly string[]).includes(key)
		) {
			merged[key] = value;
		}
	}
	target.keymaps = merged;
}

function resolveAnswerModels(
	existingModels: unknown,
	configuredModels?: AskAnswerModelPreference[]
): unknown[] | undefined {
	if (configuredModels !== undefined) {
		return configuredModels;
	}
	if (Array.isArray(existingModels) && existingModels.length > 0) {
		return existingModels;
	}
	return;
}

function mergeAnswer(
	target: Record<string, unknown>,
	answer?: Partial<AskConfig["answer"]>
): void {
	if (!answer) {
		return;
	}
	const existing = getRecord(target.answer);
	const modelsToSave = resolveAnswerModels(
		existing.extractionModels,
		answer.extractionModels
	);

	target.answer = {
		...existing,
		...(modelsToSave === undefined ? {} : { extractionModels: modelsToSave }),
		...(answer.extractionRetries === undefined
			? {}
			: { extractionRetries: answer.extractionRetries }),
		...(answer.extractionTimeoutMs === undefined
			? {}
			: { extractionTimeoutMs: answer.extractionTimeoutMs }),
	};
}

function mergeConfigFileData(
	existing: Record<string, unknown>,
	config: AskConfig | AskConfigPatch
): Record<string, unknown> {
	const data =
		Object.keys(existing).length === 0
			? (toAskConfigFileV5(
					normalizeAskConfig(config as unknown as Partial<AskConfigFileV5>)
				) as Record<string, unknown>)
			: { ...existing };

	data.schemaVersion = Math.max(
		typeof data.schemaVersion === "number" ? data.schemaVersion : 0,
		CURRENT_ASK_CONFIG_SCHEMA_VERSION
	);

	mergeTopLevelKeys(data, config);
	mergeBehaviour(data, config.behaviour);
	mergeNotifications(data, config.notifications);
	mergeKeymaps(data, config.keymaps);
	mergeAnswer(data, config.answer);

	return data;
}

function createConfigSaveError(path: string, error: unknown): Error {
	const detail = getErrorMessage(error);
	return new Error(
		`Unable to save ask config at ${path}. The file may be read-only or managed outside pi-ask; edit it manually and run /reload. ${detail}`
	);
}

function parseJson(
	content: string
): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(content) };
	} catch {
		return { ok: false };
	}
}

async function readConfigFileIfPresent(
	path: string
): Promise<string | undefined> {
	try {
		return await readFile(path, "utf-8");
	} catch (error) {
		if (isMissingFileError(error)) {
			return;
		}
		throw error;
	}
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
	return (
		!!error &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
