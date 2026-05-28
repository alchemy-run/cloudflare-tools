// Reproduces the CJS/ESM default-export interop bug that affects TS-compiled
// CJS packages with both `__esModule: true` and `exports.default = X`.
//
// `@databases/validate-unicode`'s `module.exports` is an object (not a function)
// with `default: assertValidUnicode`. Under Rolldown's Node-style interop
// heuristic (which kicks in because our importer is in a package with
// `"type": "module"`), `import assertValidUnicode from "..."` resolves to the
// entire `module.exports` object instead of `module.exports.default`. Calling
// it as a function then throws `TypeError: ... is not a function` at runtime.
//
// `@databases/sql`'s default *does* work because that package sets
// `module.exports = sql` (the function itself), so this fixture isolates the
// problematic case via `@databases/validate-unicode`.
import assertValidUnicode from "@databases/validate-unicode";

export default {
  fetch() {
    const result = assertValidUnicode("hello");
    return Response.json({ result });
  },
};
