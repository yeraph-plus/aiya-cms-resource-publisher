import { describe, expect, it } from "vitest";
import { parseCsv } from "../shared/csv.js";
import {
    buildImportRows,
    guessMapping,
    normalizeImportDate,
    normalizeImportStatus,
    type BuildOptions,
} from "../shared/import.js";

const AUTHORS = [
    { id: 2, name: "Yeraph" },
    { id: 7, name: "投稿员" },
];

const TERM_OPTIONS = {
    resource_category: [
        { id: 12, name: "漫画", slug: "comic" },
        { id: 13, name: "动画", slug: "anime" },
    ],
    resource_author: [{ id: 21, name: "藤子·F·不二雄", slug: "fujiko" }],
};

const OPTIONS: BuildOptions = {
    authors: AUTHORS,
    termOptions: TERM_OPTIONS,
    defaultStatus: "draft",
    defaultAuthorId: 2,
    unmatchedAuthor: "error",
};

describe("guessMapping", () => {
    it("maps Chinese headers onto their targets", () => {
        const mapping = guessMapping(["标题", "正文", "状态", "发布时间", "发布者", "分类", "原作"]);
        expect(mapping.title).toBe(0);
        expect(mapping.content).toBe(1);
        expect(mapping.status).toBe(2);
        expect(mapping.date).toBe(3);
        expect(mapping.author).toBe(4);
        expect(mapping["term:resource_category"]).toBe(5);
        expect(mapping["term:resource_original"]).toBe(6);
        expect(mapping["term:resource_character"]).toBeNull();
    });

    it("reads a bare 作者 header as the term column, never the account", () => {
        const mapping = guessMapping(["标题", "作者"]);
        expect(mapping.author).toBeNull();
        expect(mapping["term:resource_author"]).toBe(1);
    });

    it("never assigns one column to two targets", () => {
        const mapping = guessMapping(["名称", "name"]);
        // 名称 takes the title; the latin alias name would match the same
        // column, but it is already used — both stay title-less past col 0.
        expect(mapping.title).toBe(0);
        expect(mapping.content).toBeNull();
    });
});

describe("normalizeImportDate", () => {
    it("folds the common spreadsheet shapes into minute-precision wall clock", () => {
        expect(normalizeImportDate("2026-10-05")).toBe("2026-10-05T00:00");
        expect(normalizeImportDate("2026/10/5 9:30")).toBe("2026-10-05T09:30");
        expect(normalizeImportDate("2026年10月5日 09:30:07")).toBe("2026-10-05T09:30");
        expect(normalizeImportDate("2026-10-05T09:30")).toBe("2026-10-05T09:30");
    });

    it("returns \"\" for an empty cell and null for junk", () => {
        expect(normalizeImportDate("")).toBe("");
        expect(normalizeImportDate("  ")).toBe("");
        expect(normalizeImportDate("下周二")).toBeNull();
        expect(normalizeImportDate("2026-13-05")).toBeNull();
        expect(normalizeImportDate("2026-02-31")).toBeNull();
        expect(normalizeImportDate("2026-10-05 24:00")).toBeNull();
    });
});

describe("normalizeImportStatus", () => {
    it("accepts english and chinese aliases", () => {
        expect(normalizeImportStatus("publish")).toBe("publish");
        expect(normalizeImportStatus("草稿")).toBe("draft");
        expect(normalizeImportStatus("定时")).toBe("future");
        expect(normalizeImportStatus("撤回")).toBeNull();
    });
});

describe("buildImportRows", () => {
    it("builds dirty-row shapes from a mapped table", () => {
        const parsed = parseCsv(
            ["标题", "正文", "状态", "发布时间", "发布者", "分类", "作者"].join(",") + "\n" +
            "资源甲,正文一,publish,2026/10/5 9:30,Yeraph,漫画、动画,藤子·F·不二雄\n" +
            "资源乙,,草稿,,,未知分类,新作者",
        );
        const mapping = guessMapping(parsed.headers);
        const built = buildImportRows(parsed, mapping, OPTIONS);

        expect(built.fatal).toBeNull();
        expect(built.errors).toEqual([]);
        expect(built.rows).toEqual([
            {
                status: "publish",
                title: "资源甲",
                content: "正文一",
                authorId: 2,
                dateLocal: "2026-10-05T09:30",
                termRefs: {
                    resource_category: ["12", "13"],
                    resource_author: ["21"],
                },
            },
            {
                status: "draft",
                title: "资源乙",
                content: "",
                authorId: 2,
                dateLocal: "",
                termRefs: {
                    resource_category: ["name:未知分类"],
                    resource_author: ["name:新作者"],
                },
            },
        ]);
    });

    it("collects every problem of a row in one error", () => {
        const parsed = parseCsv("标题,状态,发布时间,发布者\n,撤回,下周二,路西法");
        const built = buildImportRows(parsed, guessMapping(parsed.headers), OPTIONS);
        expect(built.rows).toEqual([]);
        expect(built.errors).toEqual([
            { row: 1, title: "（第 1 行）", error: "标题为空；状态无法识别：撤回；发布时间无法解读：下周二；作者未匹配：路西法" },
        ]);
    });

    it("rejects future rows without a date and unknown numeric author ids", () => {
        const parsed = parseCsv("标题,状态,发布时间,发布者\n定时甲,future,,99\n定时乙,future,2026/10/6 8:00,7");
        const built = buildImportRows(parsed, guessMapping(parsed.headers), OPTIONS);
        expect(built.errors.map((error) => error.error)).toEqual([
            "定时（future）行必须携带发布时间；作者 id 不存在：99",
        ]);
        expect(built.rows.map((row) => row.title)).toEqual(["定时乙"]);
        expect(built.rows[0]).toMatchObject({ status: "future", authorId: 7, dateLocal: "2026-10-06T08:00" });
    });

    it("falls back to the default author when the policy allows it", () => {
        const parsed = parseCsv("标题,发布者\n资源甲,陌生人");
        const built = buildImportRows(parsed, guessMapping(parsed.headers), { ...OPTIONS, unmatchedAuthor: "default" });
        expect(built.errors).toEqual([]);
        expect(built.rows[0]?.authorId).toBe(2);
    });

    it("matches authors case-insensitively and keeps an empty cell on the default", () => {
        const parsed = parseCsv("标题,发布者\n甲,yeraph\n乙,\n丙,7");
        const built = buildImportRows(parsed, guessMapping(parsed.headers), OPTIONS);
        expect(built.rows.map((row) => row.authorId)).toEqual([2, 2, 7]);
    });

    it("refuses the whole import when the title column is unmapped", () => {
        const parsed = parseCsv("正文\n甲");
        const built = buildImportRows(parsed, guessMapping(parsed.headers), OPTIONS);
        expect(built.fatal).toContain("未映射");
        expect(built.rows).toEqual([]);
    });
});
