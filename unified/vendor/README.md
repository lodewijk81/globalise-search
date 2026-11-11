# Vendored CodeMirror

`codemirror.js` is CodeMirror 6 bundled into one minified ES module, so the static prototype in
`../proposal/` needs no build step. `codemirror-entry.js` lists what it exports.

The versions match the portal's `pnpm-lock.yaml`:
`@codemirror/state` 6.7.1, `@codemirror/view` 6.43.8, `@codemirror/commands` 6.10.4,
`@codemirror/autocomplete` 6.20.3, `@codemirror/language` 6.12.4, `@lezer/highlight` 1.2.3,
`@lezer/common` 1.5.2.

To rebuild:

```bash
mkdir /tmp/cm && cd /tmp/cm && npm init -y
npm install @codemirror/state@6.7.1 @codemirror/view@6.43.8 @codemirror/commands@6.10.4 \
  @codemirror/autocomplete@6.20.3 @codemirror/language@6.12.4 @lezer/highlight@1.2.3 @lezer/common@1.5.2 esbuild@0.25.9
cp /path/to/globalise-search/unified/vendor/codemirror-entry.js entry.js
npx esbuild entry.js --bundle --format=esm --minify --outfile=codemirror.js
```
