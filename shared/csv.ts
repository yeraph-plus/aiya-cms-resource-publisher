/**
 * A small RFC 4180 CSV reader. Fields may be quoted ("…"), a quoted field
 * escapes quotes by doubling ("" → "), and commas or newlines inside quotes
 * are data. Both \r\n and \n end a row; a lone \r does too. The parser never
 * throws: an unterminated quote degrades to "the rest of the file is that
 * field", which is the least surprising read of a broken file.
 */

export interface ParsedCsv {
    headers: string[];
    /** Data rows under the header; short rows read as "" past their end. */
    rows: string[][];
}

export function parseCsv(text: string): ParsedCsv {
    if (text.startsWith("\uFEFF")) {
        text = text.slice(1);
    }

    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;

    const endField = (): void => {
        row.push(field);
        field = "";
    };
    const endRow = (): void => {
        endField();
        rows.push(row);
        row = [];
    };

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
        } else if (ch === ",") {
            endField();
        } else if (ch === "\r") {
            if (text[i + 1] === "\n") {
                i += 1;
            }
            endRow();
        } else if (ch === "\n") {
            endRow();
        } else {
            field += ch;
        }
    }
    if (field !== "" || row.length > 0) {
        endRow();
    }

    // Blank lines — trailing newlines, spreadsheet padding — are not data.
    const meaningful = rows.filter((candidate) => candidate.some((cell) => cell.trim() !== ""));
    const [headers = [], ...data] = meaningful;
    return { headers: headers.map((header) => header.trim()), rows: data };
}
