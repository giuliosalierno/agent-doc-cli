import subprocess
import difflib
from pathlib import Path

# Workspace directory relative to the project root
WORKSPACE_DIR = Path(__file__).parent.parent.parent / "workspace"
WORKSPACE_DIR.mkdir(exist_ok=True)

# Max lines returned to prevent context window flooding
MAX_OUTPUT_LINES = 200


def list_docs() -> str:
    """Lists all documents currently in the workspace.

    Returns:
        A list of filenames in the workspace, or a message if empty.
    """
    try:
        files = [f.name for f in WORKSPACE_DIR.iterdir() if f.is_file()]
        if not files:
            return "Workspace is empty. Use create_doc or upload_doc to add files."
        return "Files in workspace:\n" + "\n".join(f"- {f}" for f in sorted(files))
    except Exception as e:
        return f"Error listing documents: {str(e)}"


def create_doc(filename: str, content: str) -> str:
    """Creates a new document in the workspace from text content.

    Use this when the user provides document content directly in the chat
    (e.g., pastes text or shares content inline).

    Args:
        filename: The name for the new file (e.g., "report.md").
        content: The text content to write to the file.

    Returns:
        A message indicating success or failure.
    """
    try:
        file_path = WORKSPACE_DIR / filename
        with open(file_path, "w") as f:
            f.write(content)
        line_count = content.count("\n") + 1
        return f"Successfully created {filename} in workspace ({line_count} lines)."
    except Exception as e:
        return f"Error creating document: {str(e)}"



def convert_doc(filename: str) -> str:
    """Converts a document in the workspace to Markdown.

    Args:
        filename: The name of the file in the workspace to convert.

    Returns:
        The path to the converted Markdown file or an error message.
    """
    try:
        input_path = WORKSPACE_DIR / filename
        if not input_path.exists():
            return f"Error: File {filename} not found in workspace."

        output_filename = input_path.stem + ".md"
        output_path = WORKSPACE_DIR / output_filename

        ext = input_path.suffix.lower()

        if ext in [".docx", ".html", ".latex", ".tex", ".pdf"]:
            subprocess.run(
                ["pandoc", str(input_path), "-o", str(output_path)], check=True
            )
        else:
            return f"Error: Unsupported file format {ext}. Supported: .docx, .html, .latex, .tex, .pdf"

        return f"Successfully converted {filename} to {output_filename}."
    except Exception as e:
        return f"Error converting document: {str(e)}"


def read_doc(filename: str, start_line: int, end_line: int) -> str:
    """Reads a document from the workspace with line numbers.

    Args:
        filename: The name of the file in the workspace.
        start_line: The 1-based line number to start reading from.
        end_line: The 1-based line number to end reading at (-1 for end of file).

    Returns:
        The content of the document with line numbers, truncated if too long.
    """
    try:
        file_path = WORKSPACE_DIR / filename
        if not file_path.exists():
            return f"Error: File {filename} not found in workspace."

        with open(file_path, "r") as f:
            lines = f.readlines()

        total_lines = len(lines)
        if end_line == -1:
            end_line = total_lines

        start_idx = max(0, start_line - 1)
        end_idx = min(total_lines, end_line)

        selected = lines[start_idx:end_idx]
        truncated = False
        if len(selected) > MAX_OUTPUT_LINES:
            selected = selected[:MAX_OUTPUT_LINES]
            truncated = True

        content = ""
        for i, line in enumerate(selected):
            content += f"{start_idx + i + 1}: {line}"

        if truncated:
            content += f"\n... (truncated at {MAX_OUTPUT_LINES} lines, file has {total_lines} total lines)"

        return content
    except Exception as e:
        return f"Error reading document: {str(e)}"


def search_doc(
    pattern: str,
    filename: str,
    context: int,
    output_mode: str,
    case_insensitive: bool,
    max_results: int,
) -> str:
    """Searches for a pattern in documents within the workspace.

    Args:
        pattern: The regex pattern to search for.
        filename: Filename to restrict the search to (empty string for all files).
        context: Number of lines of context to show around matches (0 for none).
        output_mode: One of "snippets" (matching lines), "titles" (file names only), "count" (match counts).
        case_insensitive: Whether to search case-insensitively.
        max_results: Maximum number of results to return (0 for unlimited).

    Returns:
        The search results.
    """
    try:
        cmd = ["rg", "--line-number", "--heading"]

        if output_mode == "titles":
            cmd.append("-l")
        elif output_mode == "count":
            cmd.append("-c")

        if case_insensitive:
            cmd.append("-i")

        if context > 0 and output_mode == "snippets":
            cmd.extend(["-C", str(context)])

        if max_results > 0:
            cmd.extend(["-m", str(max_results)])

        cmd.append(pattern)

        if filename:
            cmd.append(str(WORKSPACE_DIR / filename))
        else:
            cmd.append(str(WORKSPACE_DIR))

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            output = result.stdout
            output_lines = output.splitlines()
            if len(output_lines) > MAX_OUTPUT_LINES:
                output = "\n".join(output_lines[:MAX_OUTPUT_LINES])
                output += f"\n... (truncated at {MAX_OUTPUT_LINES} lines)"
            return output
        elif result.returncode == 1:
            return "No matches found."
        else:
            return f"Error running search: {result.stderr}"
    except FileNotFoundError:
        return "Error: ripgrep (rg) is not installed. Install it with: apt install ripgrep"
    except Exception as e:
        return f"Error during search: {str(e)}"


def edit_doc(
    filename: str, old_string: str, new_string: str, replace_all: bool
) -> str:
    """Replaces a string in a document with a new string.

    Args:
        filename: The name of the file in the workspace to edit.
        old_string: The exact string to find (must be unique unless replace_all is true).
        new_string: The string to replace it with.
        replace_all: If true, replace all occurrences. If false, old_string must be unique.

    Returns:
        A diff of the changes or an error message.
    """
    try:
        file_path = WORKSPACE_DIR / filename
        if not file_path.exists():
            return f"Error: File {filename} not found in workspace."

        with open(file_path, "r") as f:
            content = f.read()

        count = content.count(old_string)
        if count == 0:
            return "Error: old_string not found in file."
        if count > 1 and not replace_all:
            return f"Error: old_string is not unique ({count} occurrences). Provide more context or set replace_all=true."

        # Smart newline handling for deletions
        if new_string == "" and not old_string.endswith("\n") and old_string + "\n" in content:
            actual_old = old_string + "\n"
        else:
            actual_old = old_string

        if replace_all:
            new_content = content.replace(actual_old, new_string)
        else:
            new_content = content.replace(actual_old, new_string, 1)

        with open(file_path, "w") as f:
            f.write(new_content)

        diff = difflib.unified_diff(
            content.splitlines(keepends=True),
            new_content.splitlines(keepends=True),
            fromfile=f"a/{filename}",
            tofile=f"b/{filename}",
        )
        diff_text = "".join(diff)
        return diff_text if diff_text else "Edit applied (no visible diff)."
    except Exception as e:
        return f"Error editing document: {str(e)}"


def export_doc(filename: str, output_format: str) -> str:
    """Exports a document from the workspace to a specified format.

    Args:
        filename: The name of the file in the workspace to export.
        output_format: The target format (e.g., pdf, docx, html).

    Returns:
        The path to the exported file or an error message.
    """
    try:
        input_path = WORKSPACE_DIR / filename
        if not input_path.exists():
            return f"Error: File {filename} not found in workspace."

        output_filename = input_path.stem + "." + output_format
        output_path = WORKSPACE_DIR / output_filename

        subprocess.run(
            ["pandoc", str(input_path), "-o", str(output_path)], check=True
        )
        return f"Successfully exported {filename} to {output_filename}."
    except Exception as e:
        return f"Error exporting document: {str(e)}"
