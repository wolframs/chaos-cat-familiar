import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

// The import graph of an ES module entrypoint, read from source (process-split plan, step 7: the boundary checks).
// Edges are static imports and re-exports and dynamic import() calls with a literal specifier; a dynamic import with
// a computed specifier is reported as such, so a check can refuse it rather than miss it. Imports of this repo's own
// workspace packages (@chaos-cat-familiar/*) are followed into the package like relative ones; other bare specifiers
// (installed packages, builtins) are leaves.
//
// The source is tokenized (strings, template literals with nested substitutions, comments, regular expression
// literals), so the forms are found however they are spaced (`import{a}from"./x.js"`, `export*from"./y.js"`) and
// text that only looks like an import (in a string, a template, a comment, `obj.import(...)`) is not taken for one.
// Node ships no public ES module parser and the repo has no parser dependency; this covers the ESM grammar's import
// and export-from forms, which is all the checks need.

// Comments may mention modules; strings may contain "//". Strip block comments and line comments outside strings.
export function stripComments(source) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") quote = ch;
    out += ch;
    i += 1;
  }
  return out;
}

// After these words an expression starts, so a "/" opens a regular expression rather than dividing.
const BEFORE_EXPRESSION = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case",
  "do", "else", "yield", "await"]);
const NAME_START = /[A-Za-z_$\u0080-￿]/;
const NAME_PART = /[\w$\u0080-￿]/;

// Tokens: { type: "name" | "string" | "template" | "regex" | "number" | "punct", value, start, end }. A template
// literal yields one "template" token per text part; `complete` marks one without substitutions.
export function tokenize(source) {
  const tokens = [];
  const braces = [];   // "{" for a block or object, "${" for a template substitution
  const n = source.length;
  let i = source.startsWith("#!") ? Math.max(source.indexOf("\n"), 0) || n : 0;
  const push = (type, value, start, end, extra = {}) => tokens.push({ type, value, start, end, ...extra });
  const regexAllowed = () => {
    const previous = tokens.at(-1);
    if (!previous) return true;
    if (previous.type === "name") return BEFORE_EXPRESSION.has(previous.value);
    if (previous.type !== "punct") return false;
    return ![")", "]", "}"].includes(previous.value);
  };
  // Reads template text from `from` up to the closing backtick or the next "${".
  const templateText = (from) => {
    let j = from;
    let text = "";
    while (j < n) {
      const ch = source[j];
      if (ch === "\\") { text += source.slice(j, j + 2); j += 2; continue; }
      if (ch === "`") return { end: j + 1, text, closed: true };
      if (ch === "$" && source[j + 1] === "{") return { end: j + 2, text, closed: false };
      text += ch;
      j += 1;
    }
    return { end: n, text, closed: true };
  };
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === "/" && next === "/") { const end = source.indexOf("\n", i); i = end < 0 ? n : end; continue; }
    if (ch === "/" && next === "*") { const end = source.indexOf("*/", i + 2); i = end < 0 ? n : end + 2; continue; }
    if (ch === "\"" || ch === "'") {
      let j = i + 1;
      let value = "";
      while (j < n && source[j] !== ch && source[j] !== "\n") {
        if (source[j] === "\\") { value += source[j + 1] ?? ""; j += 2; } else { value += source[j]; j += 1; }
      }
      push("string", value, i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      const part = templateText(i + 1);
      push("template", part.text, i, part.end, { complete: part.closed });
      if (!part.closed) braces.push("${");
      i = part.end;
      continue;
    }
    if (ch === "{") { braces.push("{"); push("punct", "{", i, i + 1); i += 1; continue; }
    if (ch === "}") {
      if (braces.pop() === "${") {
        // The substitution ends; the template's text goes on.
        const part = templateText(i + 1);
        push("template", part.text, i, part.end, { complete: false });
        if (!part.closed) braces.push("${");
        i = part.end;
        continue;
      }
      push("punct", "}", i, i + 1);
      i += 1;
      continue;
    }
    if (ch === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== "\n") {
        const c = source[j];
        if (c === "\\") { j += 2; continue; }
        if (inClass) { if (c === "]") inClass = false; } else if (c === "[") inClass = true; else if (c === "/") break;
        j += 1;
      }
      j += 1;
      while (j < n && NAME_PART.test(source[j])) j += 1;   // flags
      push("regex", source.slice(i, j), i, j);
      i = j;
      continue;
    }
    if (NAME_START.test(ch)) {
      let j = i + 1;
      while (j < n && NAME_PART.test(source[j])) j += 1;
      push("name", source.slice(i, j), i, j);
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(next ?? ""))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(source[j])) j += 1;
      push("number", source.slice(i, j), i, j);
      i = j;
      continue;
    }
    if (source.startsWith("...", i)) { push("punct", "...", i, i + 3); i += 3; continue; }
    if (ch === "?" && next === "." && !/[0-9]/.test(source[i + 2] ?? "")) { push("punct", "?.", i, i + 2); i += 2; continue; }
    push("punct", ch, i, i + 1);
    i += 1;
  }
  return tokens;
}

const isPunct = (token, value) => token?.type === "punct" && token.value === value;
// What may stand between `import`/`export` and `from`: bindings, braces, commas, `*`, `as`, quoted export names.
const inClause = (token) => token.type === "name" || token.type === "string"
  || (token.type === "punct" && ["{", "}", ",", "*"].includes(token.value));

// The `from "x"` that ends an import or export clause starting at index `start`, or null.
function fromClause(tokens, start) {
  for (let j = start; j < tokens.length; j++) {
    const token = tokens[j];
    if (token.type === "name" && token.value === "from" && tokens[j + 1]?.type === "string"
      && !isPunct(tokens[j - 1], "{") && !isPunct(tokens[j - 1], ",")) {
      return { specifier: tokens[j + 1].value, end: j + 1 };
    }
    if (!inClause(token)) return null;
  }
  return null;
}

export function moduleImports(source) {
  const tokens = tokenize(source);
  const found = [];
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.type !== "name" || (token.value !== "import" && token.value !== "export")) continue;
    const previous = tokens[k - 1];
    if (isPunct(previous, ".") || isPunct(previous, "?.")) continue;   // registry.import(...)
    const next = tokens[k + 1];
    if (!next || isPunct(next, ":")) continue;                        // { import: ... }
    if (token.value === "import") {
      if (next.type === "string") { found.push({ specifier: next.value, dynamic: false }); k += 1; continue; }
      if (isPunct(next, ".")) continue;                                // import.meta
      if (isPunct(next, "(")) {
        // The first argument, up to a comma at the call's own depth or its closing parenthesis.
        let depth = 0;
        const argument = [];
        for (let j = k + 1; j < tokens.length; j++) {
          const item = tokens[j];
          if (item.type === "punct" && ["(", "[", "{"].includes(item.value)) depth += 1;
          else if (item.type === "punct" && [")", "]", "}"].includes(item.value)) depth -= 1;
          if (depth === 0 || (depth === 1 && isPunct(item, ","))) break;
          if (j > k + 1) argument.push(item);
        }
        const only = argument.length === 1 ? argument[0] : null;
        if (only?.type === "string" || (only?.type === "template" && only.complete)) {
          found.push({ specifier: only.value, dynamic: true });
        } else {
          const expression = argument.length ? source.slice(argument[0].start, argument.at(-1).end) : "";
          found.push({ specifier: null, dynamic: true, expression });
        }
        continue;
      }
      const clause = fromClause(tokens, k + 1);
      if (clause) { found.push({ specifier: clause.specifier, dynamic: false }); k = clause.end; }
      continue;
    }
    // export ... from "x" (export * from, export * as ns from, export { a } from); local exports have no `from`.
    if (isPunct(next, "*") || isPunct(next, "{")) {
      const clause = fromClause(tokens, k + 1);
      if (clause) { found.push({ specifier: clause.specifier, dynamic: false }); k = clause.end; }
    }
  }
  return found;
}

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

export function isBuiltin(specifier) {
  return BUILTINS.has(specifier) || specifier.startsWith("node:");
}

// The npm workspaces of the repo that holds `file` (the nearest package.json with "workspaces"): name -> folder.
const workspaceCache = new Map();
export function workspacePackages(file) {
  let dir = path.dirname(file);
  for (;;) {
    const manifestPath = path.join(dir, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (Array.isArray(manifest.workspaces)) break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return new Map();
    dir = parent;
  }
  if (workspaceCache.has(dir)) return workspaceCache.get(dir);
  const packages = new Map();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  for (const pattern of manifest.workspaces) {
    const folders = pattern.endsWith("/*")
      ? fs.readdirSync(path.join(dir, pattern.slice(0, -2)), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, pattern.slice(0, -2), entry.name))
      : [path.join(dir, pattern)];
    for (const folder of folders) {
      const packagePath = path.join(folder, "package.json");
      if (!fs.existsSync(packagePath)) continue;
      const name = JSON.parse(fs.readFileSync(packagePath, "utf8")).name;
      if (name) packages.set(name, folder);
    }
  }
  workspaceCache.set(dir, packages);
  return packages;
}

// A bare specifier naming a workspace package (or a file in one) as its file, or null.
function resolveWorkspace(specifier, packages) {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const folder = packages.get(name);
  if (!folder) return null;
  const subpath = specifier.slice(name.length + 1);
  if (subpath) return { name, file: path.join(folder, subpath) };
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, "package.json"), "utf8"));
  const exported = typeof manifest.exports === "string" ? manifest.exports
    : manifest.exports?.["."]?.import ?? manifest.exports?.["."]?.default ?? manifest.exports?.["."]
      ?? manifest.exports?.import ?? manifest.exports?.default;
  return { name, file: path.join(folder, typeof exported === "string" ? exported : manifest.main ?? "index.js") };
}

// Walks every local module reachable from entry. Bare specifiers (packages, builtins) are leaves, except this repo's
// workspace packages, whose items carry `workspace: <package name>`.
export function importGraph(entry) {
  const modules = new Map();
  const stack = [path.resolve(entry instanceof URL ? fileURLToPath(entry) : entry)];
  while (stack.length) {
    const file = stack.pop();
    if (modules.has(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    const imports = moduleImports(source).map((item) => {
      if (!item.specifier || isBuiltin(item.specifier)) return item;
      if (item.specifier.startsWith(".") || item.specifier.startsWith("/")) {
        return { ...item, resolved: path.resolve(path.dirname(file), item.specifier) };
      }
      const workspace = resolveWorkspace(item.specifier, workspacePackages(file));
      return workspace ? { ...item, resolved: workspace.file, workspace: workspace.name } : item;
    });
    modules.set(file, { source, imports });
    for (const item of imports) if (item.resolved) stack.push(item.resolved);
  }
  return modules;
}

// The chain of imports from entry to target (for a readable failure), or null.
export function importPath(modules, entry, isTarget) {
  const start = path.resolve(entry instanceof URL ? fileURLToPath(entry) : entry);
  const queue = [[start, [start]]];
  const seen = new Set([start]);
  while (queue.length) {
    const [file, chain] = queue.shift();
    for (const item of modules.get(file)?.imports ?? []) {
      const key = item.resolved ?? item.specifier;
      if (isTarget(item)) return [...chain, `${item.dynamic ? "import()" : "import"} ${key}`];
      if (item.resolved && !seen.has(item.resolved)) {
        seen.add(item.resolved);
        queue.push([item.resolved, [...chain, item.resolved]]);
      }
    }
  }
  return null;
}
