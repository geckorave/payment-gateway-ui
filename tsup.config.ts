import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    minify: true,
    sourcemap: true,
    treeshake: true,
    clean: true,
    target: "es2019",
    external: ["react", "react-dom", "tailwindcss"]
});
