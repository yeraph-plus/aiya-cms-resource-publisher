import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The intake config resolves its path at import time, exactly like the
// publisher's database does — point it at a temp dir before importing.
process.env.PUBLISHER_DATA = mkdtempSync(join(tmpdir(), "intake-test-"));

let config: typeof import("../intake/config.js");
let parse: typeof import("../intake/parse.js");
let prompt: typeof import("../intake/prompt.js");

beforeAll(async () => {
    config = await import("../intake/config.js");
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
    it("falls back to the built-ins when the file is missing or unusable", () => {
        const loaded = config.loadConfig();
        expect(loaded.publisherUrl).toBe("http://127.0.0.1:5175");
        expect(loaded.templates).toHaveLength(6);
        expect(loaded.llm.provider).toBe("openai");
        expect(loaded.llm.jsonMode).toBe(true);

        writeFileSync(config.configPath, "{ 这不是 json", "utf8");
        expect(config.loadConfig().templates).toHaveLength(6);
    });

    it("round-trips a saved config and never hands the key to the browser", () => {
        const saved = config.defaultConfig();
        saved.publisherUrl = "http://127.0.0.1:5199";
        saved.llm = { ...saved.llm, provider: "gemini", model: "m", apiKey: "secret", temperature: 1.4, jsonMode: false };
        saved.templates = saved.templates.slice(0, 2);
        config.saveConfig(saved);

        const loaded = config.loadConfig();
        expect(loaded.publisherUrl).toBe("http://127.0.0.1:5199");
        expect(loaded.llm).toMatchObject({ provider: "gemini", model: "m", apiKey: "secret", temperature: 1.4, jsonMode: false });
        expect(loaded.templates.map((item) => item.id)).toEqual(["game", "book"]);

        const exposed = config.publicConfig(loaded);
        expect(exposed.llm.hasApiKey).toBe(true);
        expect(Object.keys(exposed.llm)).not.toContain("apiKey");
        expect(JSON.stringify(exposed)).not.toContain("secret");
    });

    it("validates a PUT payload field by field", () => {
        const current = config.defaultConfig();
        const cases: [unknown, string][] = [
            ["不是对象", "必须是一个对象"],
            [{ publisherUrl: "" }, "不能为空"],
            [{ publisherUrl: "ftp://x" }, "http(s)"],
            [{ llm: "x" }, "llm 必须是一个对象"],
            [{ llm: { provider: "anthropic" } }, "provider"],
            [{ llm: { temperature: 9 } }, "temperature"],
            [{ llm: { jsonMode: "yes" } }, "jsonMode"],
            [{ llm: { usePublisherProxy: "yes" } }, "usePublisherProxy"],
            [{ templates: [] }, "至少"],
        ];
        for (const [payload, fragment] of cases) {
            const merged = config.mergeConfigPayload(current, payload);
            expect(merged.error, JSON.stringify(payload)).toContain(fragment);
            expect(merged.config).toBe(current);
        }

        // An empty key means "keep the stored one"; an empty template list is
        // the only way to lose the built-ins, and it is refused above.
        const kept = config.mergeConfigPayload(
            { ...current, llm: { ...current.llm, apiKey: "stored" } },
            { llm: { apiKey: "", model: "new-model" }, templates: [{ id: "x", label: "X", sourceHint: "", prompt: "p" }] },
        );
        expect(kept.error).toBeNull();
        expect(kept.config.llm.apiKey).toBe("stored");
        expect(kept.config.llm.model).toBe("new-model");
        expect(kept.config.templates.map((item) => item.id)).toEqual(["x"]);
    });

    it("shares the publisher's proxy by default and lets the switch turn it off", () => {
        expect(config.defaultConfig().llm.usePublisherProxy).toBe(true);

        const off = config.mergeConfigPayload(config.defaultConfig(), { llm: { usePublisherProxy: false } });
        expect(off.error).toBeNull();
        expect(off.config.llm.usePublisherProxy).toBe(false);
        expect(off.config.llm).not.toHaveProperty("proxyUrl");
    });

    it("refreshes an untouched built-in prompt once and leaves an edited one alone", () => {
        // A miniature of the pre-2.0 contract: it declares the fields the
        // publisher owns now (authorId in the JSON block, status in a hard
        // rule). A template carrying these was never rewritten by hand.
        const oldContract = `【输出格式】\n{\n  "title": "站内标题",\n  "status": "draft",\n  "authorId": null\n}\n\n【硬规则】\n5. status 固定 "draft"，authorId 固定 null。`;

        const saved = config.defaultConfig();
        saved.templatesVersion = 1;
        saved.templates = saved.templates.map((template) =>
            template.id === "game"
                ? { ...template, prompt: oldContract }
                : { ...template, prompt: `${template.prompt}\n（我自己改的补充）` },
        );
        config.saveConfig(saved);

        const loaded = config.loadConfig();
        expect(loaded.templatesVersion).toBe(config.CURRENT_TEMPLATES_VERSION);
        const game = loaded.templates.find((item) => item.id === "game")?.prompt ?? "";
        expect(game).not.toContain('"authorId"');
        expect(game).toContain("只输出上面列出的字段");
        expect(loaded.templates.find((item) => item.id === "book")?.prompt).toContain("（我自己改的补充）");
    });
});