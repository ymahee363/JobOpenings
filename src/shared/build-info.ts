/** When this extension build was made (set by scripts/build.mjs); 0 in tests. */
declare const __BUILT_AT__: number | undefined;
export const BUILT_AT: number = typeof __BUILT_AT__ === 'number' ? __BUILT_AT__ : 0;
