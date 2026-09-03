export interface NarrowBounds {
    path: string;
    max?: number;
    min?: number;
    enum?: unknown[];
    pattern?: string;
}
export interface NarrowResult {
    narrowed: unknown;
    clamped: Array<{
        path: string;
        from: unknown;
        to: unknown;
    }>;
    changed: boolean;
}
export declare function computeNarrowedParams(params: unknown, bounds: NarrowBounds[]): NarrowResult;
