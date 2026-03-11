# How Claude Code Makes Edits

Analysis of the Edit tool implementation from Claude Code v2.1.72 (`cli.js` bundled source).

## 1. Tool Schema (Input)

The Edit tool accepts these parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `file_path` | string | Absolute path to the file |
| `old_string` | string | Exact text to find and replace |
| `new_string` | string | Replacement text (must differ from `old_string`) |
| `replace_all` | boolean (optional, default `false`) | Replace all occurrences |

## 2. Core Edit Logic

The edit is a **string replacement**, not a line-based or AST-based operation.

### `lY1()` — Single Edit Entry Point

```
lY1({filePath, fileContents, oldString, newString, replaceAll})
```

Delegates to `QI6()` for the actual work.

### `QI6()` — Multi-Edit Applicator

```
QI6({filePath, fileContents, edits})
```

This is the core engine. It:

1. **Iterates edits sequentially** — each edit is applied to the result of the previous one.
2. **Checks for conflicts** — if `old_string` is a substring of a `new_string` from a prior edit, it throws an error to prevent cascading issues.
3. **Applies the replacement** via `Sv5()` (simple `string.replace()` or `replaceAll()`).
4. **Validates the edit worked** — if the content didn't change, throws `"String not found in file"`.
5. **Validates the result differs from original** — throws `"Original and edited file match exactly"` otherwise.
6. **Generates a unified diff** via `UY1()` (which uses `bH6`, a diff library).

### `Sv5()` — Smart String Replace

Handles a special case for deletions: when `new_string` is empty and `old_string` doesn't end with a newline but appears followed by one in the file, it removes the trailing newline too. This prevents leaving blank lines when deleting content.

```js
// Pseudocode reconstruction
function Sv5(fileContent, oldString, newString, replaceAll) {
  const replaceFn = replaceAll
    ? (s, old, rep) => s.replaceAll(old, () => rep)
    : (s, old, rep) => s.replace(old, () => rep);

  if (newString !== "") return replaceFn(fileContent, oldString, newString);

  // Deletion: also consume trailing newline if old_string doesn't end with one
  if (!oldString.endsWith("\n") && fileContent.includes(oldString + "\n")) {
    return replaceFn(fileContent, oldString + "\n", newString);
  }
  return replaceFn(fileContent, oldString, newString);
}
```

## 3. Smart Curly Quote Handling

Claude models sometimes output "smart" (curly) quotes instead of straight quotes. Two functions handle this:

- **`S46(fileContent, oldString)`** — If `old_string` isn't found literally, normalizes curly quotes (`'` `'` `"` `"`) to straight quotes in both the file and the search string, finds the match position, then returns the original (un-normalized) substring from the file.
- **`dJ6(oldString, newOldString, newString)`** — Applies the inverse curly-quote transformation to `new_string` so it matches the convention used in the file (e.g., if the file uses smart quotes, the replacement will too).

## 4. Pre-Edit Normalization (`P$7`)

Before applying edits, `P$7()` performs additional normalization:

- **Trailing whitespace stripping** on `new_string` via `HY8()`.
- **Token replacement** (`Iv5()`) — replaces special XML-like tokens the model might hallucinate:

| Model output | Normalized to |
|--------------|---------------|
| `<fnr>` | `<function_results>` |
| `<n>` | `<name>` |
| `</n>` | `</name>` |
| `<o>` | `<output>` |
| `</o>` | `</output>` |
| `\n\nH:` | `\n\nHuman:` |
| `\n\nA:` | `\n\nAssistant:` |

- If `old_string` doesn't match after basic normalization, it tries these token replacements to find a match in the file.

## 5. Read-Before-Edit Guard

The system prompt states: *"You must use your Read tool at least once in the conversation before editing."*

This is enforced in code — the tool tracks which files have been read and will error if you attempt to edit an unread file. This ensures the model has seen the current file contents before attempting a replacement.

## 6. Uniqueness Constraint

The edit **fails if `old_string` is not unique** in the file (unless `replace_all: true`). Since `string.replace()` only replaces the first occurrence, a non-unique match would lead to ambiguous behavior. The system prompt instructs:

> "Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`."

## 7. Diff Generation & Display

After applying the edit:

- `UY1()` generates a unified diff using `bH6` (the `diff` library's `structuredPatch` function).
- Special characters (`&`, `$`) are escaped before diffing and unescaped after, to prevent regex replacement issues.
- The diff is displayed to the user with **word-level highlighting** — paired add/remove lines get character-level diffing to show exactly what changed within a line.

## 8. Post-Edit Actions

After a successful edit:

1. **File write** — the modified content is written to disk via `writeFileSync`.
2. **LSP notification** — `textDocument/didChange` is sent to any running LSP servers for that file, keeping language tooling in sync.
3. **Secret scanning** (`FN1()`) — for team memory paths, the new content is scanned for secrets (API keys, tokens, private keys, etc.) and the edit is **blocked** if secrets are detected.
4. **Git diff metadata** is optionally computed and included in the result.

## 9. Alternative Edit Mode (Line-Reference Edits)

There is also a newer schema (`vr4`) supporting structured edits with line references in the format `LINE#HASH`:

| Operation | Description |
|-----------|-------------|
| `set` | Replace a specific line identified by `ref` |
| `set_range` | Replace a range of lines from `beg` to `end` |
| `insert` | Insert lines `before` or `after` a referenced line |
| `replace` | Text find/replace (like the classic mode) |

This provides an alternative to the string-match approach by anchoring edits to specific lines using a hash to verify line identity.

## 10. Architecture Diagram

```
User Request (old_string, new_string, file_path)
         |
         v
    P$7() — Normalize (curly quotes, token replacement, whitespace)
         |
         v
    QI6() — Apply edit(s) sequentially
     |-- Sv5() — String replace (with smart newline handling)
     |-- Validate: string found? content changed?
     '-- UY1() -> bH6() — Generate unified diff
         |
         v
    writeFileSync() — Write to disk
         |
         |-- LSP didChange notification
         |-- Secret scan (team memory paths)
         '-- Return diff + metadata to user
```

## Key Design Decisions

- **String replacement over line-based patching** — Makes edits robust against line number shifts between read and edit. The tradeoff is requiring exact, unique matches.
- **Sequential multi-edit application** — Edits within a single call are applied in order, each building on the previous result. Conflict detection prevents one edit from corrupting another.
- **Defensive normalization** — Multiple layers of normalization (curly quotes, XML tokens, whitespace) compensate for common model output artifacts.
- **Read-before-edit enforcement** — Ensures the model has current file context, reducing stale-edit failures.
- **Uniqueness requirement** — Eliminates ambiguity about which occurrence to replace, forcing the model to provide sufficient context.
