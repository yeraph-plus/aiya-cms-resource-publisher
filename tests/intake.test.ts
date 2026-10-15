import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The intake resolves its data dir (the legacy config path) at import time,
// exactly like the publisher's database does — point it at a temp dir so a
// developer's real intake.config.json can never leak into a test run.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "intake-test-"));

let config: typeof import("../intake/config.js");
let contract: typeof import("../intake/contract.js");
let parse: typeof import("../intake/parse.js");
let prompt: typeof import("../intake/prompt.js");

beforeAll(async () => {
    config = await import("../intake/config.js");
    contract = await import("../intake/contract.js");
    parse = await import("../intake/parse.js");
    prompt = await import("../intake/prompt.js");
});

describe("extractJson", () => {
    it("reads a bare object, a fenced block and one wrapped in prose", () => {
        expect(parse.extractJson('{"title":"甲"}')).toEqual({ ok: true, value: { title: "甲" } });
        expect(parse.extractJson('```json\n{"title":"甲"}\n```')).toEqual({ ok: true, value: { title: "甲" } });
        expect(parse.extractJson('好的，这是草稿：\n{"title":"甲","content":"x"}\n需要调整再告诉我。')).toEqual({
            ok: true,
            value: { title: "甲", content: "x" },
        });
    });

    it("names the failure instead of throwing", () => {
        expect(parse.extractJson("   ").ok).toBe(false);
        expect(parse.extractJson("模型今天不想干活").ok).toBe(false);
        const broken = parse.extractJson('{"title": "甲",}');
        expect(broken.ok).toBe(false);
        expect(broken.ok ? "" : broken.error).toContain("解析");
    });
});

describe("toDraft", () => {
    it("folds the model's loose shapes into a draft", () => {
        const result = parse.toDraft({
            title: " [GALGAME] 测试作 ",
            content: " <p>正文</p> ",
            terms: { resource_category: "GALGAME", resource_content: ["恋爱", 447, ""] },
            newTerms: { resource_other: "AI机翻" },
        });
        expect(result.ok).toBe(true);
        expect(result.ok ? result.value : null).toEqual({
            title: "[GALGAME] 测试作",
            content: "<p>正文</p>",
            terms: { resource_category: ["GALGAME"], resource_content: ["恋爱", "447"] },
            newTerms: { resource_other: ["AI机翻"] },
        });
    });

    it("ignores publishing fields the model volunteered, and refuses a title-less answer", () => {
        // Status, author, date and the file list belong to the publisher's own
        // settings now; a chatty model must not be able to set them.
        const result = parse.toDraft({
            title: "甲",
            status: "future",
            dateLocal: "2026-10-16T08:00",
            authorId: "投稿员",
            fileserve: { 1: { adapter: "platform" } },
        });
        expect(result.ok).toBe(true);
        expect(result.ok ? Object.keys(result.value).sort() : []).toEqual(["content", "newTerms", "terms", "title"]);

        const missing = parse.toDraft({ content: "只有正文" });
        expect(missing.ok).toBe(false);
        expect(missing.ok ? "" : missing.error).toContain("title");
        expect(parse.toDraft("不是对象").ok).toBe(false);
    });
});

describe("buildUserMessage", () => {
    it("lists the six taxonomies with counts, 分类 as a path, then the corpus", () => {
        const message = prompt.buildUserMessage("原始语料正文", {
            resource_category: [
                { name: "子分类", count: 167, path: "父分类 / 子分类" },
                { name: "GALGAME", count: 0 },
            ],
        });

        expect(message).toContain("resource_category）：父分类 / 子分类(167)、GALGAME");
        expect(message).toContain("- 原作（resource_original）：暂无词表");
        expect(message).toContain("- 其他（resource_other）：暂无词表");
        expect(message).toContain("层级词法");
        // The netdisk lane is the publisher's business: the prompt never
        // mentions file lists any more.
        expect(message).not.toContain("网盘");
        expect(message.trimEnd().endsWith("原始语料正文")).toBe(true);
    });
});

describe("intake config", () => {
    it("starts with no prompt templates at all, and degrades field by field", () => {
        const fresh = config.parseConfig(null);
        // The tool ships no presets: writing the prompts is the user's job.
        expect(fresh.templates).toEqual([]);
        expect(fresh.llm.provider).toBe("openai");
        expect(fresh.llm.jsonMode).toBe(true);

        // A hand-edited database value must not take the window down with it.
        expect(config.parseConfig("{ 这不是 json").templates).toEqual([]);
        expect(config.parseConfig('"just a string"').templates).toEqual([]);
        expect(config.parseConfig("{}").llm.model).toBe("");
    });

    it("keeps exactly the templates that are stored, without injecting any", () => {
        const stored = JSON.stringify({
            llm: { model: "m" },
            templates: [
                { id: "mine", label: "我自己写的", sourceHint: "来源页", prompt: "写点什么" },
                { id: "", label: "坏的", prompt: "" },
            ],
        });
        const loaded = config.parseConfig(stored);
        expect(loaded.templates.map((item) => item.id)).toEqual(["mine"]);

        // Clearing the list is a legitimate state, not an error.
        const cleared = config.mergeConfigPayload(loaded, { templates: [] });
        expect(cleared.error).toBeNull();
        expect(cleared.config.templates).toEqual([]);
    });

    it("round-trips through the stored blob and never hands the key to the browser", () => {
        const saved = config.defaultConfig();
        saved.llm = { ...saved.llm, provider: "gemini", model: "m", apiKey: "secret", temperature: 1.4, jsonMode: false };
        saved.templates = [{ id: "only", label: "唯一一份", sourceHint: "", prompt: "整理语料" }];

        const loaded = config.parseConfig(config.serializeConfig(saved));
        expect(loaded.llm).toMatchObject({ provider: "gemini", model: "m", apiKey: "secret", temperature: 1.4, jsonMode: false });
        expect(loaded.templates.map((item) => item.id)).toEqual(["only"]);

        const exposed = config.publicConfig(loaded, "http://127.0.0.1:5199");
        expect(exposed.llm.hasApiKey).toBe(true);
        expect(Object.keys(exposed.llm)).not.toContain("apiKey");
        expect(JSON.stringify(exposed)).not.toContain("secret");
        // The tool's address is a launch fact the window only displays.
        expect(exposed.publisherUrl).toBe("http://127.0.0.1:5199");
    });

    it("imports the pre-database file once, and ignores its stale publisher address", () => {
        const legacy = JSON.stringify({
            publisherUrl: "http://127.0.0.1:9999",
            llm: { provider: "openai", model: "legacy-model", apiKey: "legacy-key", jsonMode: false },
            templates: [{ id: "custom", label: "自定义", sourceHint: "", prompt: "整理这段语料" }],
        });
        const imported = config.parseLegacyConfig(legacy);
        expect(imported).not.toBeNull();
        expect(imported?.llm.model).toBe("legacy-model");
        expect(imported?.llm.apiKey).toBe("legacy-key");
        expect(imported?.templates.map((item) => item.id)).toEqual(["custom"]);
        expect(imported).not.toHaveProperty("publisherUrl");

        // Nothing worth importing: no key, no templates, or not JSON at all.
        expect(config.parseLegacyConfig(JSON.stringify({ publisherUrl: "http://x", llm: {} }))).toBeNull();
        expect(config.parseLegacyConfig("{ broken")).toBeNull();
        expect(config.parseLegacyConfig("[]")).toBeNull();
    });

    it("validates a PUT payload field by field", () => {
        const current = config.defaultConfig();
        const cases: [unknown, string][] = [
            ["不是对象", "必须是一个对象"],
            [{ llm: "x" }, "llm 必须是一个对象"],
            [{ llm: { provider: "anthropic" } }, "provider"],
            [{ llm: { baseUrl: "not a url" } }, "baseUrl"],
            [{ llm: { temperature: 9 } }, "temperature"],
            [{ llm: { jsonMode: "yes" } }, "jsonMode"],
            [{ llm: { usePublisherProxy: "yes" } }, "usePublisherProxy"],
            [{ templates: "不是数组" }, "templates 必须是数组"],
        ];
        for (const [payload, fragment] of cases) {
            const merged = config.mergeConfigPayload(current, payload);
            expect(merged.error, JSON.stringify(payload)).toContain(fragment);
            expect(merged.config).toBe(current);
        }

        // An empty key means "keep the stored one".
        const kept = config.mergeConfigPayload(
            { ...current, llm: { ...current.llm, apiKey: "stored" } },
            { llm: { apiKey: "", model: "new-model" }, templates: [{ id: "x", label: "X", sourceHint: "", prompt: "p" }] },
        );
        expect(kept.error).toBeNull();
        expect(kept.config.llm.apiKey).toBe("stored");
        expect(kept.config.llm.model).toBe("new-model");
        expect(kept.config.templates.map((item) => item.id)).toEqual(["x"]);

        // Entries without an id or a prompt are dropped, not refused.
        const dropped = config.mergeConfigPayload(current, { templates: [{ id: "", prompt: "x" }, { id: "y", prompt: "" }] });
        expect(dropped.error).toBeNull();
        expect(dropped.config.templates).toEqual([]);
    });

    it("shares the publisher's proxy by default and lets the switch turn it off", () => {
        expect(config.defaultConfig().llm.usePublisherProxy).toBe(true);

        const off = config.mergeConfigPayload(config.defaultConfig(), { llm: { usePublisherProxy: false } });
        expect(off.error).toBeNull();
        expect(off.config.llm.usePublisherProxy).toBe(false);
        expect(off.config.llm).not.toHaveProperty("proxyUrl");
    });

    it("keeps the output contract in step with what the parser reads", () => {
        // The contract is the only prompt text the tool owns. If it stops naming
        // a field the parser needs, every user-written template breaks.
        for (const key of ["title", "content", "terms", "newTerms"]) {
            expect(contract.OUTPUT_CONTRACT).toContain(`"${key}"`);
        }
        // …and it must not ask for the fields the publishing tool decides.
        for (const key of ["authorId", "dateLocal", "fileserve", "status"]) {
            expect(contract.OUTPUT_CONTRACT).not.toContain(`"${key}"`);
        }
        expect(contract.OUTPUT_CONTRACT).toContain("【输出格式】");
        expect(contract.OUTPUT_CONTRACT).toContain("分类是层级词法");
    });
});