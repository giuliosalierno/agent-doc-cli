# Claude Code Grep Tool — Architecture Analysis

> Reference document for implementing a similar content-search tool in the **agent-doc-cli**.

---

## 1. What the Grep Tool Is

The Grep tool is a **dedicated, schema-defined tool** exposed to the LLM as a callable function. It wraps [ripgrep (`rg`)](https://github.com/BurntSushi/ripgrep) behind a structured JSON-Schema interface so the model never runs raw shell commands for content search.

### Key design principle

Claude Code enforces a strict rule: **the model must never invoke `grep` or `rg` via the Bash tool**. Instead, it calls the Grep tool, which:

- Gives the user a clear, reviewable tool-call (name, parameters, description) before execution.
- Applies permission checks — the user can approve/deny each call.
- Standardises output format so the model always receives predictable results.

---

## 2. Parameter Schema

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | `string` | **yes** | Regex pattern (ripgrep syntax, not POSIX grep). |
| `path` | `string` | no | File or directory to search. Defaults to cwd. |
| `output_mode` | `enum` | no | `"files_with_matches"` (default), `"content"`, or `"count"`. |
| `glob` | `string` | no | Glob filter, e.g. `"*.js"`, `"**/*.tsx"`. Maps to `rg --glob`. |
| `type` | `string` | no | File-type shorthand, e.g. `"py"`, `"js"`. Maps to `rg --type`. |
| `-i` | `boolean` | no | Case-insensitive search. |
| `-n` | `boolean` | no | Show line numbers (default `true`, only with `output_mode: "content"`). |
| `-A` | `number` | no | Lines after match (context). |
| `-B` | `number` | no | Lines before match (context). |
| `-C` / `context` | `number` | no | Lines before and after match. |
| `multiline` | `boolean` | no | Enable multiline mode (`rg -U --multiline-dotall`). |
| `head_limit` | `number` | no | Cap output to first N lines/entries (like `| head -N`). |
| `offset` | `number` | no | Skip first N entries before applying `head_limit`. |

---

## 3. Execution Flow

```
┌──────────────┐     ┌──────────────────┐     ┌────────────────┐
│  LLM output  │────▶│  Tool dispatcher  │────▶│  Permission    │
│  (tool_use)  │     │  parses JSON args │     │  gate (user    │
│              │     │                    │     │  approve/deny) │
└──────────────┘     └──────────────────┘     └───────┬────────┘
                                                       │ approved
                                                       ▼
                                              ┌────────────────┐
                                              │  Build rg      │
                                              │  command from   │
                                              │  parameters     │
                                              └───────┬────────┘
                                                       │
                                                       ▼
                                              ┌────────────────┐
                                              │  Execute rg    │
                                              │  (sandboxed)   │
                                              └───────┬────────┘
                                                       │
                                                       ▼
                                              ┌────────────────┐
                                              │  Post-process  │
                                              │  (offset,      │
                                              │  head_limit,   │
                                              │  format output)│
                                              └───────┬────────┘
                                                       │
                                                       ▼
                                              ┌────────────────┐
                                              │  Return result │
                                              │  to LLM        │
                                              └────────────────┘
```

### Step-by-step

1. **Model decides to search** — Based on the user's request, the LLM emits a `tool_use` block with `name: "Grep"` and the JSON parameters.
2. **Tool dispatcher** — Claude Code's runtime matches the tool name, validates the parameters against the JSON Schema, and prepares execution.
3. **Permission gate** — The user's permission mode determines whether the call auto-executes or requires manual approval. The full tool call (name + args) is shown to the user.
4. **Command construction** — Parameters are mapped to `rg` flags:
   - `pattern` → positional argument
   - `path` → positional argument (or cwd)
   - `output_mode: "files_with_matches"` → `rg -l`
   - `output_mode: "content"` → `rg` (default output)
   - `output_mode: "count"` → `rg -c`
   - `glob` → `--glob`
   - `type` → `--type`
   - `-i` → `-i`
   - `-A/-B/-C` → `-A/-B/-C`
   - `multiline` → `-U --multiline-dotall`
5. **Sandboxed execution** — The `rg` process runs within Claude Code's sandbox, respecting file-system boundaries.
6. **Post-processing** — `offset` and `head_limit` are applied to truncate output before returning to the model (prevents context-window flooding).
7. **Result returned** — The output string is injected back into the conversation as a tool result.

---

## 4. Output Modes

| Mode | rg equivalent | Returns | Use case |
|------|--------------|---------|----------|
| `files_with_matches` | `rg -l` | List of file paths | "Which files contain X?" |
| `content` | `rg` (with optional context) | Matching lines with line numbers | "Show me the code that does X" |
| `count` | `rg -c` | Per-file match counts | "How often does X appear?" |

---

## 5. How the Model Is Guided to Use It

Claude Code uses **system-prompt instructions** to enforce correct tool usage:

1. **Prohibition rule** — "Do NOT use the Bash tool to run `grep` or `rg`. Use the Grep tool instead."
2. **Delegation guidance** — "For simple, directed searches use Grep directly. For broader exploration, use the Agent tool with `subagent_type=Explore`."
3. **Parallelism** — "If multiple searches are independent, call them in parallel in one response."
4. **Fallback** — "Only use Bash for shell operations that have no dedicated tool equivalent."

---

## 6. Design Patterns to Adopt for agent-doc-cli

### 6.1 Wrap CLI tools behind structured schemas

Don't let the LLM compose raw shell commands for document search. Define a tool like:

```json
{
  "name": "SearchDocs",
  "parameters": {
    "query": { "type": "string", "required": true },
    "doc_type": { "type": "string", "enum": ["markdown", "pdf", "docx"] },
    "scope": { "type": "string", "description": "Directory or doc collection" },
    "output_mode": { "type": "string", "enum": ["snippets", "titles", "count"] }
  }
}
```

### 6.2 Output truncation is essential

The `head_limit` and `offset` parameters prevent the tool from flooding the context window. For agent-doc-cli, this is even more critical since documents can be large. Always cap returned content and support pagination.

### 6.3 Permission gating

Every tool call should pass through a permission layer. For agent-doc-cli, this is especially important for write operations (edit, delete, rename).

### 6.4 Output modes give the model flexibility

Three output modes (`files_with_matches`, `content`, `count`) let the model choose the right level of detail for the task. For agent-doc-cli, consider modes like:
- `titles` — list matching document titles
- `snippets` — show matching paragraphs with surrounding context
- `full` — return entire matching sections

### 6.5 System-prompt enforcement

The model must be told in the system prompt which tools exist and when to use them. Without this, the model may fall back to raw Bash commands, bypassing permissions and structured output.

### 6.6 Parallel tool calls

Allow the model to issue multiple independent search calls in a single turn. This is critical for performance when the agent needs to gather information from multiple sources before making an edit.

---

## 7. Suggested Tool Set for agent-doc-cli

Based on Claude Code's tool architecture, a document agent should expose:

| Tool | Purpose | Analogous to |
|------|---------|-------------|
| `SearchDocs` | Content search across documents | `Grep` |
| `ListDocs` | Find documents by name/pattern | `Glob` |
| `ReadDoc` | Read a document or section | `Read` |
| `EditDoc` | Apply targeted edits to a document | `Edit` |
| `WriteDoc` | Create a new document | `Write` |
| `RunCommand` | Escape hatch for shell operations | `Bash` |

Each tool should follow the same pattern: **JSON Schema definition → permission gate → execution → post-processing → result**.
