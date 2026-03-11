# Copyright 2025 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import os
import google.auth
from google.adk.agents.llm_agent import LlmAgent
from google.adk.models import Gemini
from google.genai import types
from .tools.document_tools import (
    list_docs,
    create_doc,
    convert_doc,
    read_doc,
    search_doc,
    edit_doc,
    export_doc
)

_, project_id = google.auth.default()
os.environ.setdefault("GOOGLE_CLOUD_PROJECT", project_id)
os.environ.setdefault("GOOGLE_CLOUD_LOCATION", "global")
os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "True")

DOCUMENT_AGENT_INSTRUCTIONS = """You are a specialized Document Management Agent. Your goal is to help users ingest, convert, search, edit, and export documents.

**CRITICAL — Handling User Content:**
- When a user shares text or file content directly in the chat, use `create_doc` to save it to the workspace immediately. Do NOT ask for a file path — the content is already in the message.
- When a user mentions a file name (like "summary.txt"), save the content they provided using that name.
- Use `list_docs` to check what files are already in the workspace.

**Workflow Principles:**
1. **Markdown-First**: For non-text formats (PDF, DOCX), convert to Markdown after upload for searching and editing.
2. **Read-Before-Edit**: Always use `read_doc` or `search_doc` to understand the content before using `edit_doc`.
3. **Precision**: Use `edit_doc` with enough context in `old_string` to ensure it is unique. If `edit_doc` returns an error about uniqueness, use `read_doc` to find more surrounding context.
4. **Validation**: After an edit, use `read_doc` to verify the changes.

**Tool Usage Rules (all parameters are REQUIRED):**
- `create_doc`: Use to save text content from the chat into the workspace.
- `read_doc`: Use `start_line=1` and `end_line=-1` to read the whole file.
- `search_doc`: Use `filename=""` for all files, `context=0` for no context, `output_mode="snippets"` for matching lines, `"titles"` for file names only, `"count"` for match counts. Use `case_insensitive=false` and `max_results=0` for defaults.
- `edit_doc`: Use `replace_all=false` for single replacements. Set `replace_all=true` to replace all occurrences.

You can handle PDF, DOCX, HTML, LaTeX, and plain text files."""

root_agent = LlmAgent(
    name="document_agent",
    model=Gemini(
        model="gemini-3.1-flash-lite-preview",
        retry_options=types.HttpRetryOptions(attempts=3),
    ),
    instruction=DOCUMENT_AGENT_INSTRUCTIONS,
    tools=[list_docs, create_doc, convert_doc, read_doc, search_doc, edit_doc, export_doc],
)
