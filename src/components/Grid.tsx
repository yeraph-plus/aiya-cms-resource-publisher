import { useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, type CellValueChangedEvent, type ColDef } from "ag-grid-community";
import type { AuthorDTO, RowDTO, TermInfo } from "../types";
import { TAXONOMY_ORDER } from "../types";
import { configSummary } from "../../shared/fileserve";
import type { RowPatch } from "../api";

ModuleRegistry.registerModules([AllCommunityModule]);

interface Props {
    rows: RowDTO[];
    terms: Record<string, TermInfo[]>;
    authors: AuthorDTO[];
    selectedId: number | null;
    onSelect: (localId: number) => void;
    onEdit: (localId: number, patch: RowPatch) => void;
}

function flagBadges(row: RowDTO): string[] {
    const badges: string[] = [];
    if (row.postId === null) {
        badges.push("新行");
    }
    if (row.dirty) {
        badges.push("待推送");
    }
    if (row.conflict) {
        badges.push("冲突");
    }
    if (row.missing) {
        badges.push("线上缺失");
    }
    return badges;
}

function refsToNames(refs: string[] | undefined, options: TermInfo[] | undefined): string {
    if (!refs || refs.length === 0) {
        return "";
    }
    return refs
        .map((ref) => {
            if (ref.startsWith("name:")) {
                return `${ref.slice("name:".length)}（新）`;
            }
            const found = options?.find((option) => option.id === Number(ref));
            return found ? found.name : `#${ref}`;
        })
        .join("、");
}

export default function Grid({ rows, terms, authors, selectedId, onSelect, onEdit }: Props) {
    const authorName = (id: number | null): string => {
        if (id === null) {
            return "";
        }
        return authors.find((author) => author.id === id)?.name ?? `#${id}`;
    };

    const columnDefs = useMemo<ColDef<RowDTO>[]>(() => {
        const tagTaxonomies = TAXONOMY_ORDER.filter((slug) => slug !== "resource_category");
        return [
            {
                headerName: "标记",
                width: 110,
                valueGetter: (params) => flagBadges(params.data!).join(" "),
                cellRenderer: (params: { data?: RowDTO }) => {
                    const data = params.data;
                    if (!data) {
                        return "";
                    }
                    return (
                        <span className="flex gap-1">
                            {flagBadges(data).map((badge) => (
                                <span
                                    key={badge}
                                    className={`px-1 rounded text-[11px] ${
                                        badge === "冲突"
                                            ? "bg-red-100 text-red-700"
                                            : badge === "待推送"
                                              ? "bg-amber-100 text-amber-700"
                                              : badge === "线上缺失"
                                                ? "bg-neutral-300 text-neutral-700"
                                                : "bg-blue-100 text-blue-700"
                                    }`}
                                >
                                    {badge}
                                </span>
                            ))}
                        </span>
                    );
                },
            },
            { headerName: "线上ID", field: "postId", width: 70 },
            {
                headerName: "标题",
                field: "title",
                flex: 2,
                editable: true,
                cellClass: "leading-5",
            },
            {
                headerName: "作者",
                width: 90,
                valueGetter: (params) => authorName(params.data?.authorId ?? null),
            },
            {
                headerName: "分类",
                flex: 1,
                valueGetter: (params) => refsToNames(params.data?.terms["resource_category"], terms["resource_category"]),
            },
            {
                headerName: "标签",
                flex: 1.5,
                valueGetter: (params) =>
                    tagTaxonomies
                        .map((slug) => refsToNames(params.data?.terms[slug], terms[slug]))
                        .filter(Boolean)
                        .join("、"),
            },
            {
                headerName: "发布时间",
                field: "dateLocal",
                flex: 1,
                editable: true,
                valueFormatter: (params) => (params.value ?? "").replace("T", " ").slice(0, 16),
            },
            {
                headerName: "文件列表",
                width: 110,
                valueGetter: (params) => configSummary((params.data?.fileserveParsed ?? null) as never),
            },
            {
                headerName: "错误",
                field: "lastError",
                flex: 1,
                cellClass: "text-red-600 text-xs",
                tooltipField: "lastError",
            },
        ];
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [terms, authors]);

    const onCellValueChanged = (event: CellValueChangedEvent<RowDTO>) => {
        const row = event.data;
        if (!row) {
            return;
        }
        const field = event.colDef.field;
        if (field === "title") {
            onEdit(row.localId, { title: row.title });
        } else if (field === "dateLocal") {
            onEdit(row.localId, { dateLocal: row.dateLocal });
        }
    };

    return (
        <div className="h-full">
            <AgGridReact<RowDTO>
                rowData={rows}
                columnDefs={columnDefs}
                rowSelection="single"
                getRowId={(params) => String(params.data.localId)}
                onCellValueChanged={onCellValueChanged}
                onRowClicked={(event) => {
                    const id = event.data?.localId;
                    if (id !== undefined) {
                        onSelect(id);
                    }
                }}
                defaultColDef={{ resizable: true, sortable: true }}
                headerHeight={30}
                rowHeight={30}
            />
        </div>
    );
}
