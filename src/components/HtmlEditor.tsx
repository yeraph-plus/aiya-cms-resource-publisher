import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { html } from "@codemirror/lang-html";

interface Props {
    value: string;
    onChange: (value: string) => void;
    /** The pane is on screen. CodeMirror measures 0 in a hidden box, so it is
     * asked to re-measure when the preview tab hands the space back. */
    visible: boolean;
}

const theme = EditorView.theme({
    "&": { height: "100%", fontSize: "12px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "ui-monospace, Consolas, monospace", lineHeight: "1.6" },
    ".cm-gutters": { backgroundColor: "#fafafa", borderRight: "1px solid #e5e5e5", color: "#a3a3a3" },
    ".cm-activeLine": { backgroundColor: "#f5f9ff" },
    ".cm-activeLineGutter": { backgroundColor: "#f0f4fa" },
});

/**
 * Source editor for the post body. HTML syntax highlighting, search and undo
 * come from CodeMirror's basic setup; nothing is prettified, because this
 * tool's contract is "the source is what the site gets" — a formatter that
 * reflows attributes would make every save dirty.
 */
export default function HtmlEditor({ value, onChange, visible }: Props) {
    const host = useRef<HTMLDivElement | null>(null);
    const view = useRef<EditorView | null>(null);
    // Last value this editor produced. An external change (grid cell edit, a
    // row replaced by 还原) arrives as a new `value`; anything else came from
    // here and must not be re-dispatched, or the cursor jumps on every key.
    const emitted = useRef(value);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    useEffect(() => {
        const parent = host.current;
        if (parent === null) {
            return;
        }
        const instance = new EditorView({
            parent,
            state: EditorState.create({
                doc: emitted.current,
                extensions: [
                    basicSetup,
                    html(),
                    theme,
                    EditorView.lineWrapping,
                    EditorView.updateListener.of((update) => {
                        if (update.docChanged) {
                            emitted.current = update.state.doc.toString();
                            onChangeRef.current(emitted.current);
                        }
                    }),
                ],
            }),
        });
        view.current = instance;
        return () => {
            instance.destroy();
            view.current = null;
        };
    }, []);

    useEffect(() => {
        const instance = view.current;
        if (instance === null || value === emitted.current) {
            return;
        }
        emitted.current = value;
        instance.dispatch({ changes: { from: 0, to: instance.state.doc.length, insert: value } });
    }, [value]);

    useEffect(() => {
        if (visible) {
            // The editor was display:none while the preview was up.
            view.current?.requestMeasure();
        }
    }, [visible]);

    return <div ref={host} className="h-full overflow-hidden" />;
}
