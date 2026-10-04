import { describe, expect, it } from "vitest";
import { buildPayload } from "../server/payload.js";
import type { PostRow } from "../server/db.js";

function row(patch: Partial<PostRow>): PostRow {
    return {
        localId: 1,
        postId: null,
        status: "publish",
        title: "标题",
        content: "正文",
        authorId: null,
        dateLocal: "",
        dateGmt: "",
        modifiedGmt: "",
        fileserve: null,
        slug: null,
        dirty: true,
        conflict: false,
        missing: false,
        lastSyncedGmt: null,
        lastPushedGmt: null,
        lastError: null,
        snapshot: null,
        ...patch,
    };
}

describe("push payload building", () => {
    it("sends the whole row: title, content, status, terms and fileserve", () => {
        const payload = buildPayload(
            row({
                authorId: 2,
                dateLocal: "2020-05-06T07:08:00",
                fileserve: '{"1":{"adapter":"platform","url":"https://x","price":5}}',
            }),
            { resource_category: ["44"], resource_original: ["81", "name:新标签"] },
        );
        expect(payload).toEqual({
            title: "标题",
            content: "正文",
            status: "publish",
            authorId: 2,
            date: "2020-05-06T07:08:00",
            terms: { resource_category: [44], resource_original: [81, "新标签"] },
            fileserve: { "1": { adapter: "platform", url: "https://x", price: 5 } },
        });
    });

    it("omits the date on updates whose date matches the confirmed snapshot", () => {
        // The snapshot echoes what the server last confirmed; pushing the same
        // date back must not suppress the "fileserve changed → bump" rule.
        const snapshot = JSON.stringify({
            status: "publish",
            title: "标题",
            content: "正文",
            authorId: null,
            dateLocal: "2020-05-06T07:08:00",
            dateGmt: "2020-05-05T23:08:00",
            modifiedGmt: "2026-09-28T20:00:00",
            terms: {},
            fileserve: null,
        });
        const payload = buildPayload(row({ postId: 367, dateLocal: "2020-05-06T07:08:00", snapshot }), {});
        expect(payload.date).toBeUndefined();

        const changed = buildPayload(row({ postId: 367, dateLocal: "2021-01-01T00:00:00", snapshot }), {});
        expect(changed.date).toBe("2021-01-01T00:00:00");
    });

    it("always sends the date for new rows that have one", () => {
        const payload = buildPayload(row({ postId: null, dateLocal: "2020-05-06T07:08:00" }), {});
        expect(payload.date).toBe("2020-05-06T07:08:00");
    });

    it("keeps fileserve null as no-change and {} as clear", () => {
        const untouched = buildPayload(row({ fileserve: null }), {});
        expect(untouched.fileserve).toBeNull();

        const cleared = buildPayload(row({ postId: 9, fileserve: "{}" }), {});
        expect(cleared.fileserve).toEqual({});
    });
});
