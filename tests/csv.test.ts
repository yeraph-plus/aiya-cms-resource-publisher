import { describe, expect, it } from "vitest";
import { parseCsv } from "../shared/csv.js";

describe("parseCsv", () => {
    it("reads a plain table", () => {
        const parsed = parseCsv("标题,状态\n甲,publish\n乙,draft");
        expect(parsed.headers).toEqual(["标题", "状态"]);
        expect(parsed.rows).toEqual([["甲", "publish"], ["乙", "draft"]]);
    });

    it("keeps commas and newlines inside quotes as data", () => {
        const parsed = parseCsv('标题,正文\n"带,逗号","第一行\n第二行"');
        expect(parsed.rows[0]).toEqual(["带,逗号", "第一行\n第二行"]);
    });

    it("unescapes doubled quotes inside a quoted field", () => {
        const parsed = parseCsv('a,b\n"""引用""",尾');
        expect(parsed.rows[0]).toEqual(['"引用"', "尾"]);
    });

    it("accepts CRLF line endings", () => {
        const parsed = parseCsv("a,b\r\n1,2\r\n3,4");
        expect(parsed.headers).toEqual(["a", "b"]);
        expect(parsed.rows).toEqual([["1", "2"], ["3", "4"]]);
    });

    it("strips a BOM and trims header cells", () => {
        const parsed = parseCsv("\uFEFF标题 , 状态\n甲,publish");
        expect(parsed.headers).toEqual(["标题", "状态"]);
        // Data cells keep their raw content — only headers are trimmed.
        expect(parsed.rows[0]).toEqual(["甲", "publish"]);
    });

    it("drops blank and whitespace-only lines", () => {
        const parsed = parseCsv("a,b\n1,\n\n,  \n2,3");
        expect(parsed.rows).toEqual([["1", ""], ["2", "3"]]);
    });

    it("treats a missing trailing newline as the end of the row", () => {
        const parsed = parseCsv("a,b\n1,2");
        expect(parsed.rows).toEqual([["1", "2"]]);
    });

    it("degrades an unterminated quote to the rest of the file", () => {
        const parsed = parseCsv('a,b\n"未闭合,还在继续');
        // The quote never closes, so the comma is data too: one field.
        expect(parsed.rows[0]).toEqual(["未闭合,还在继续"]);
    });

    it("returns an empty table for empty input", () => {
        expect(parseCsv("").headers).toEqual([]);
        expect(parseCsv("\n\n").rows).toEqual([]);
    });

    it("pads nothing: short rows simply read as empty past their end", () => {
        const parsed = parseCsv("a,b,c\n1");
        expect(parsed.rows[0]?.[0]).toBe("1");
        expect(parsed.rows[0]?.[1]).toBeUndefined();
        expect(parsed.rows[0]?.[2]).toBeUndefined();
    });
});
