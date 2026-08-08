import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "neutral",
  dts: false, // tsup's bundled rollup-plugin-dts is incompatible with TypeScript 7's compiler
  // API (throws on `useCaseSensitiveFileNames`) — declarations are emitted separately by
  // `tsc -p tsconfig.build.json` instead, see the "build" script.
  clean: true,
  external: [/^cloudflare:/],
});
