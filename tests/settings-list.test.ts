import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import type { AskConfig } from "../src/config/schema.ts";
import type { AskConfigNotice, AskConfigPatch } from "../src/config/store.ts";
import { AskSettingsList } from "../src/ui/settings-list.ts";

const savedConfig: AskConfig = {
	answer: {
		...DEFAULT_ASK_CONFIG.answer,
	},
	behaviour: {
		autoSubmitWhenAnsweredWithoutNotes: false,
		confirmDismissWhenDirty: true,
		doublePressReviewShortcuts: true,
		presentSingleAsMulti: false,
		showFooterHints: true,
	},
	keymaps: DEFAULT_ASK_CONFIG.keymaps,
	notifications: {
		channels: ["bell"],
		enabled: true,
	},
};

function plainTheme() {
	return {
		bg(_color: string, text: string) {
			return text;
		},
		fg(_color: string, text: string) {
			return text;
		},
	};
}

function createList(
	options: {
		configPath?: string;
		notice?: AskConfigNotice;
		onClose?: () => void;
		onSave?: (config: AskConfig | AskConfigPatch) => Promise<AskConfig>;
		savedConfig?: AskConfig;
	} = {}
) {
	const onClose =
		options.onClose ??
		(() => {
			// test callback intentionally unused
		});
	const baseConfig = options.savedConfig ?? savedConfig;
	return new AskSettingsList(plainTheme(), {
		configPath: options.configPath ?? "/tmp/eko24ive-pi-ask.json",
		notice: options.notice,
		onClose,
		onSave:
			options.onSave ??
			((patch) => Promise.resolve({ ...baseConfig, ...patch } as AskConfig)),
		savedConfig: baseConfig,
		tui: {
			requestRender() {
				// no-op in tests
			},
		},
	});
}

test("settings list renders behaviour settings and config path", () => {
	const list = createList();
	const text = list.render(72).join("\n");

	assert(text.includes("╭"));
	assert(text.includes("@eko24ive/pi-ask"));
	assert(text.includes("Live settings"));
	assert(text.includes("Defaults for future asks"));
	assert(text.includes("Auto-submit when answered without notes"));
	assert(text.includes("[off]"));
	assert(text.includes("Confirm dismiss when dirty"));
	assert(text.includes("Present single-select as multi-select"));
	assert(text.includes("on"));
	assert(text.includes("Edit this config file to customize"));
	assert(text.includes("keymaps"));
	assert(text.includes("notifications"));
	assert(text.includes("extraction settings"));
	assert(text.includes("/tmp/eko24ive-pi-ask.json"));
	assert(text.includes("Esc / Ctrl+C / ? to close"));
	assert.equal(text.includes("Esc to cancel"), false);
	assert.equal(text.includes("Keymaps"), false);
	assert.equal(text.includes("Ctrl+S"), false);
	assert.equal(text.includes("Saved"), false);
});

test("settings list stays within narrow render width", () => {
	const list = createList();
	const lines = list.render(28);

	assert(lines.every((line) => visibleWidth(line) <= 28));
	const text = lines.join("\n");
	assert(text.includes("/tmp/eko24ive-pi-ask"));
	assert(text.includes("n"));
});

test("settings list saves behaviour changes immediately without success feedback", async () => {
	let saved: AskConfig | AskConfigPatch | undefined;
	const list = createList({
		onSave: (config) => {
			saved = config;
			return Promise.resolve({ ...savedConfig, ...config } as AskConfig);
		},
	});

	list.handleInput(" ");
	await new Promise((resolve) => setImmediate(resolve));

	const text = list.render(72).join("\n");
	// Only the toggled slice is sent so unrelated disk sections cannot be
	// clobbered by a stale in-memory copy.
	assert.deepEqual(saved, {
		behaviour: { autoSubmitWhenAnsweredWithoutNotes: true },
	});
	assert.equal(text.includes("Saved"), false);
});

test("settings list shows save failures and reverts the toggle", async () => {
	const list = createList({
		onSave: () => Promise.reject(new Error("disk nope")),
	});

	list.handleInput(" ");
	await new Promise((resolve) => setImmediate(resolve));

	const text = list.render(72).join("\n");
	assert(text.includes("disk nope"));
	assert(text.includes("Auto-submit when answered without notes"));
	assert(text.includes("[off]"));
});

test("settings list renders load warnings", () => {
	const list = createList({
		notice: {
			kind: "warning",
			text: "Unable to save ask config; edit it manually.",
		},
	});

	const text = list.render(72).join("\n");

	assert(text.includes("Unable to save ask config; edit it manually."));
});

test("settings list clears load warnings after successful save", async () => {
	const list = createList({
		notice: {
			kind: "warning",
			text: "Unable to save ask config; edit it manually.",
		},
	});

	list.handleInput(" ");
	await new Promise((resolve) => setImmediate(resolve));

	const text = list.render(72).join("\n");

	assert.equal(
		text.includes("Unable to save ask config; edit it manually."),
		false
	);
});

test("settings list uses configured navigation and close keys", async () => {
	let saved: AskConfig | AskConfigPatch | undefined;
	const customConfig: AskConfig = {
		...savedConfig,
		keymaps: {
			...savedConfig.keymaps,
			settingsModal: {
				...savedConfig.keymaps.settingsModal,
				nextOption: ["j"],
				previousOption: ["k"],
				toggle: ["x"],
				close: ["q"],
			},
		},
	};
	const list = createList({
		onSave: (config) => {
			saved = config;
			return Promise.resolve({ ...customConfig, ...config } as AskConfig);
		},
		savedConfig: customConfig,
	});

	list.handleInput("j");
	list.handleInput("x");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(saved?.behaviour?.confirmDismissWhenDirty, false);
});

test("settings list resets config to defaults after double press", async () => {
	let saveCount = 0;
	let saved: AskConfig | AskConfigPatch | undefined;
	const customConfig: AskConfig = {
		...savedConfig,
		behaviour: {
			...savedConfig.behaviour,
			autoSubmitWhenAnsweredWithoutNotes: true,
			showFooterHints: false,
		},
		notifications: {
			...savedConfig.notifications,
			enabled: false,
		},
	};
	const list = createList({
		onSave: (config) => {
			saveCount += 1;
			saved = config;
			return Promise.resolve({ ...customConfig, ...config } as AskConfig);
		},
		savedConfig: customConfig,
	});

	list.handleInput("\x1b[A");
	list.handleInput(" ");
	assert.equal(saveCount, 0);
	assert(list.render(72).join("\n").includes("[confirm reset]"));

	list.handleInput(" ");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(saveCount, 1);
	assert.deepEqual(saved, DEFAULT_ASK_CONFIG);
});

test("settings list closes with configured keys and dispose idempotently", () => {
	let closed = 0;
	const list = createList({
		onClose: () => {
			closed += 1;
		},
	});

	list.handleInput("?");
	list.handleInput("\u0003");
	list.dispose();
	assert.equal(closed, 1);
});

test("settings list with config store preserves existing provider and model on disk when toggling a setting", async () => {
	const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { AskConfigStore } = await import("../src/config/store.ts");

	const root = await mkdtemp(join(tmpdir(), "pi-ask-settings-list-preserve-"));
	const configPath = join(root, "eko24ive-pi-ask.json");

	await writeFile(
		configPath,
		JSON.stringify(
			{
				schemaVersion: 5,
				provider: "deepseek",
				model: "deepseek-chat",
				answer: {
					provider: "deepseek",
					model: "deepseek-chat",
					extractionModels: [{ provider: "deepseek", id: "deepseek-chat" }],
				},
				behaviour: {
					autoSubmitWhenAnsweredWithoutNotes: false,
					confirmDismissWhenDirty: true,
					doublePressReviewShortcuts: true,
					presentSingleAsMulti: false,
					showFooterHints: true,
				},
			},
			null,
			2
		)
	);

	const store = new AskConfigStore(configPath);
	const loaded = await store.ensureLoaded();

	const list = createList({
		configPath,
		onSave: (nextConfig) => store.save(nextConfig),
		savedConfig: loaded.config,
	});

	// Toggle first item (autoSubmitWhenAnsweredWithoutNotes) from false to true
	list.handleInput(" ");
	await new Promise((resolve) => setTimeout(resolve, 20));

	const savedJson = JSON.parse(await readFile(configPath, "utf-8"));
	assert.equal(savedJson.provider, "deepseek");
	assert.equal(savedJson.model, "deepseek-chat");
	assert.equal(savedJson.answer?.provider, "deepseek");
	assert.equal(savedJson.answer?.model, "deepseek-chat");
	assert.deepEqual(savedJson.answer?.extractionModels, [
		{ provider: "deepseek", id: "deepseek-chat" },
	]);
	assert.equal(savedJson.behaviour?.autoSubmitWhenAnsweredWithoutNotes, true);

	await rm(root, { force: true, recursive: true });
});

test("settings list toggle preserves disk edits made after load", async () => {
	const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { AskConfigStore } = await import("../src/config/store.ts");

	const root = await mkdtemp(join(tmpdir(), "pi-ask-settings-list-stale-"));
	const configPath = join(root, "eko24ive-pi-ask.json");
	const initialModels = [{ provider: "ollama", id: "llama3" }];
	const externalModels = [{ provider: "deepseek", id: "deepseek-chat" }];

	await writeFile(
		configPath,
		JSON.stringify({
			schemaVersion: 5,
			answer: { extractionModels: initialModels },
			behaviour: {
				...DEFAULT_ASK_CONFIG.behaviour,
				autoSubmitWhenAnsweredWithoutNotes: false,
				showFooterHints: true,
			},
		})
	);

	const store = new AskConfigStore(configPath);
	const loaded = await store.ensureLoaded();
	const list = createList({
		configPath,
		onSave: (nextConfig) => store.save(nextConfig),
		savedConfig: loaded.config,
	});

	// External edit after load: different models plus an unrelated flag flip.
	await writeFile(
		configPath,
		JSON.stringify({
			schemaVersion: 5,
			answer: { extractionModels: externalModels },
			behaviour: {
				...DEFAULT_ASK_CONFIG.behaviour,
				autoSubmitWhenAnsweredWithoutNotes: false,
				showFooterHints: false,
			},
		})
	);

	// Toggle first item (autoSubmitWhenAnsweredWithoutNotes) from false to true.
	list.handleInput(" ");
	await new Promise((resolve) => setTimeout(resolve, 20));

	const savedJson = JSON.parse(await readFile(configPath, "utf-8"));
	assert.deepEqual(savedJson.answer?.extractionModels, externalModels);
	assert.equal(savedJson.behaviour?.autoSubmitWhenAnsweredWithoutNotes, true);
	assert.equal(savedJson.behaviour?.showFooterHints, false);

	await rm(root, { force: true, recursive: true });
});
