import { ADAPTER_FIELDS, ADAPTER_LABELS, emptyGroup, nextId, type FieldValue, type FileServeConfig } from "../../shared/fileserve";

interface Props {
    config: FileServeConfig | null;
    onChange: (config: FileServeConfig | null) => void;
}

const ADAPTER_IDS = Object.keys(ADAPTER_FIELDS);

export default function FileServeEditor({ config, onChange }: Props) {
    const groups = config ?? {};
    const entries = Object.entries(groups).sort(([a], [b]) => Number(a) - Number(b));

    const commit = (next: FileServeConfig): void => {
        onChange(Object.keys(next).length > 0 ? next : {});
    };

    const addGroup = (): void => {
        const id = nextId(groups);
        commit({ ...groups, [id]: emptyGroup("platform") });
    };

    const removeGroup = (id: string): void => {
        const next = { ...groups };
        delete next[id];
        commit(next);
    };

    const changeAdapter = (id: string, adapter: string): void => {
        const previous = groups[id];
        if (!previous) {
            return;
        }
        commit({ ...groups, [id]: { ...emptyGroup(adapter), title: previous.title ?? "", price: previous.price ?? 0 } });
    };

    const setField = (id: string, field: string, value: FieldValue): void => {
        const group = groups[id];
        if (!group) {
            return;
        }
        commit({ ...groups, [id]: { ...group, [field]: value } });
    };

    return (
        <div className="space-y-2">
            {entries.map(([id, group]) => {
                const fields = ADAPTER_FIELDS[group.adapter] ?? [];
                return (
                    <div key={id} className="border border-neutral-200 rounded p-2 bg-neutral-50">
                        <div className="flex items-center gap-2 mb-1.5">
                            <span className="font-mono text-xs text-neutral-500">组 #{id}</span>
                            <select
                                value={group.adapter}
                                onChange={(event) => changeAdapter(id, event.target.value)}
                                className="text-xs"
                            >
                                {ADAPTER_IDS.map((adapter) => (
                                    <option key={adapter} value={adapter}>
                                        {ADAPTER_LABELS[adapter] ?? adapter}
                                    </option>
                                ))}
                            </select>
                            <button
                                className="ml-auto text-xs text-red-500 hover:underline"
                                onClick={() => removeGroup(id)}
                            >
                                删除组
                            </button>
                        </div>
                        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
                            {fields.map((field) => (
                                <label key={field.id} className={field.type === "text" && field.id !== "code" && field.id !== "password" ? "col-span-2" : "block"}>
                                    <span className="lbl">{field.id}</span>
                                    {field.type === "text" ? (
                                        <input
                                            className="w-full"
                                            value={String(group[field.id] ?? "")}
                                            onChange={(event) => setField(id, field.id, event.target.value)}
                                        />
                                    ) : (
                                        <input
                                            type="number"
                                            className="w-full"
                                            value={group[field.id] === null || group[field.id] === undefined ? "" : Number(group[field.id])}
                                            onChange={(event) =>
                                                setField(id, field.id, event.target.value === "" ? null : Number(event.target.value))
                                            }
                                        />
                                    )}
                                </label>
                            ))}
                        </div>
                    </div>
                );
            })}

            <div className="flex items-center gap-3">
                <button className="btn" onClick={addGroup}>
                    + 添加组
                </button>
                {entries.length > 0 && (
                    <details className="text-xs text-neutral-500">
                        <summary className="cursor-pointer select-none">JSON 预览</summary>
                        <pre className="mt-1 p-2 bg-neutral-900 text-green-200 rounded overflow-auto max-h-56 text-[11px] leading-4">
                            {JSON.stringify(groups, null, 2)}
                        </pre>
                    </details>
                )}
                {entries.length === 0 && <span className="text-xs text-neutral-400">没有数据组（推送空配置会清除线上文件列表）</span>}
            </div>
        </div>
    );
}
