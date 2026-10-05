// Types for release-feed.mjs (the unit tests import it).

export declare const REPO: string;
export declare function artifacts(version: string): { dmg: string; zip: string; blockmap: string; feed: string };
export declare function uploadOrder(version: string): string[];
export declare function sha512Base64(buf: Uint8Array): string;
export declare function rewriteFeed(yml: string, file: string, o: { sha512: string; size: number }): string;
export declare function releaseChecks(f: {
  version: string; rootVersion: string; tags: string[]; clean: boolean; profile: string | undefined; gh: boolean; release: boolean;
}): Array<{ name: string; ok: boolean; detail: string }>;
