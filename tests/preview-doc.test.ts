import { describe, expect, it } from "vitest";

const { buildPreviewDoc, paragraphize } = await import("../shared/preview.js");

const options = { siteUrl: "https://site.test", localImageUrl: (path: string) => path };

/**
 * The site's body is `wpautop`'d on render and WP stores no `<p>`, so a source
 * is normally plain text with blank lines between paragraphs. The preview has
 * to rebuild those paragraphs or every post reads as one run-on block.
 */
describe("paragraphize", () => {
    it("turns a blank line into a paragraph and a single newline into a break", () => {
        expect(paragraphize("第一段第一行\n第一段第二行\n\n第二段。")).toBe(
            "<p>第一段第一行<br />\n第一段第二行</p>\n<p>第二段。</p>",
        );
    });

    it("leaves markup that already opens a block alone", () => {
        const source = "<ul>\n<li>a</li>\n</ul>\n\n<hr />\n\n收尾一句。";
        expect(paragraphize(source)).toBe("<ul>\n<li>a</li>\n</ul>\n<hr />\n<p>收尾一句。</p>");
    });

    it("does not wrap a stored paragraph twice", () => {
        expect(paragraphize("<p>旧数据里的段落。</p>")).toBe("<p>旧数据里的段落。</p>");
    });

    it("leaves a shortcode line unwrapped, so the literal tag stays visible on its own line", () => {
        expect(paragraphize('说明：\n\n[alert type="warning" name="注意"]文本[/alert]')).toBe(
            '<p>说明：</p>\n[alert type="warning" name="注意"]文本[/alert]',
        );
    });
});

describe("the preview document", () => {
    it("paragraphizes plain-text sources the way the site would", () => {
        const doc = buildPreviewDoc("第一段。\n\n第二段。", options);
        expect(doc).toContain("<p>第一段。</p>\n<p>第二段。</p>");
    });

    it("keeps a specs blockquote one line per field", () => {
        const doc = buildPreviewDoc("<blockquote>游戏名称：A\n英文名称：B</blockquote>", options);
        expect(doc).toContain("<blockquote>游戏名称：A<br />\n英文名称：B</blockquote>");
    });

    it("does not add breaks to a blockquote that already has its own markup", () => {
        const doc = buildPreviewDoc("<blockquote><p>已有段落。</p>\n<p>第二段。</p></blockquote>", options);
        expect(doc).toContain("<blockquote><p>已有段落。</p>\n<p>第二段。</p></blockquote>");
    });
});
