/**
 * One-slot progress reporter for the long-running site operations (pull and
 * push). The endpoint handlers read the current snapshot while the operation
 * runs and clear the slot when it settles — the UI polls /api/progress to
 * show what the tool is doing instead of sitting on a dead-looking spinner.
 */
export interface Progress {
    /** Short human label of what is happening right now. */
    phase: string;
    /** Completed units; 0/0 means "no countable units" — indeterminate. */
    done: number;
    total: number;
}

let current: Progress | null = null;

export function setProgress(progress: Progress | null): void {
    current = progress;
}

export function getProgress(): Progress | null {
    return current;
}
