export declare const DEFAULT_MAX_DOMAINS = 4;
export declare function pkgRootOfThisModule(): string;
export declare function findArchFile(start: string): string | null;
export interface ArchRules {
    allowed: Set<string>;
    domains: Map<string, string>;
}
export declare function parseArchRules(text: string): ArchRules;
export declare function domainsOfTargets(libRoot: string, targets: readonly string[]): string[];
export interface RenderArchContextOptions {
    pkgRoot?: string;
    targets?: readonly string[] | null;
    maxDomains?: number;
}
export declare function renderArchContext(opts: RenderArchContextOptions): string | null;
