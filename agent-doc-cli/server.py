import json
import logging
import os
import sys

import uvicorn
from fastapi import FastAPI, UploadFile, File
from fastapi.requests import Request
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types as genai_types
from pathlib import Path
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, stream=sys.stderr)
logger = logging.getLogger(__name__)

# Import the agent
sys.path.insert(0, str(Path(__file__).parent))
from app import root_agent

PROJECT_ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"
WORKSPACE_DIR = PROJECT_ROOT / "workspace"
WORKSPACE_DIR.mkdir(exist_ok=True)

# ADK setup
session_service = InMemorySessionService()
runner = Runner(agent=root_agent, app_name="doc_editor", session_service=session_service)

app = FastAPI()

# Tools that modify files
FILE_MODIFYING_TOOLS = {"create_doc", "edit_doc", "convert_doc", "export_doc"}


class ChatRequest(BaseModel):
    message: str


async def chat_streamer(request: ChatRequest):
    user_id = "default_user"
    session_id = "default_session"

    if not await session_service.get_session(
        app_name="doc_editor", user_id=user_id, session_id=session_id
    ):
        await session_service.create_session(
            app_name="doc_editor", user_id=user_id, session_id=session_id
        )

    try:
        async for event in runner.run_async(
            user_id=user_id,
            session_id=session_id,
            new_message=genai_types.Content(
                role="user", parts=[genai_types.Part(text=request.message)]
            ),
        ):
            # Tool calls
            if event.get_function_calls():
                for call in event.get_function_calls():
                    yield json.dumps({
                        "type": "tool_call",
                        "name": call.name,
                        "args": call.args,
                    }) + "\n"

            # Tool responses
            if event.get_function_responses():
                for response in event.get_function_responses():
                    result_text = ""
                    raw = response.response
                    if isinstance(raw, dict):
                        # ADK wraps tool returns in {"result": "..."}
                        if "result" in raw and isinstance(raw["result"], str):
                            result_text = raw["result"]
                        else:
                            result_text = json.dumps(raw)
                    elif isinstance(raw, str):
                        result_text = raw
                    else:
                        result_text = str(raw)

                    # Strip namespace prefix (e.g. "api:edit_doc" -> "edit_doc")
                    tool_name = response.name
                    if ":" in tool_name:
                        tool_name = tool_name.split(":")[-1]

                    yield json.dumps({
                        "type": "tool_result",
                        "name": tool_name,
                        "result": result_text,
                    }) + "\n"

                    # If a file-modifying tool ran, send workspace refresh signal
                    if tool_name in FILE_MODIFYING_TOOLS:
                        yield json.dumps({"type": "workspace_changed"}) + "\n"

            # Final text response
            if event.is_final_response() and event.content and event.content.parts:
                for part in event.content.parts:
                    if part.text:
                        yield json.dumps({
                            "type": "text",
                            "content": part.text,
                        }) + "\n"
    except Exception as e:
        logger.error(f"Error during agent execution: {e}", exc_info=True)
        yield json.dumps({
            "type": "text",
            "content": f"An error occurred: {str(e)}. Please try again.",
        }) + "\n"


@app.post("/chat")
async def chat(request: Request):
    chat_request = ChatRequest(**(await request.json()))
    return StreamingResponse(
        chat_streamer(chat_request), media_type="text/event-stream"
    )


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.get("/api/workspace")
async def list_workspace():
    files = []
    if WORKSPACE_DIR.exists():
        for f in sorted(WORKSPACE_DIR.iterdir()):
            if f.is_file():
                files.append({
                    "name": f.name,
                    "size": f.stat().st_size,
                    "modified": f.stat().st_mtime,
                })
    return {"files": files}


@app.get("/api/workspace/{filename:path}")
async def get_workspace_file(filename: str):
    file_path = WORKSPACE_DIR / filename
    if not file_path.exists() or not file_path.is_file():
        return {"error": "File not found"}, 404
    try:
        content = file_path.read_text()
        return {"filename": filename, "content": content}
    except Exception as e:
        return {"error": str(e)}, 500


CONVERTIBLE_EXTENSIONS = {".pdf", ".docx", ".doc", ".html", ".latex", ".tex"}


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    try:
        content = await file.read()
        file_path = WORKSPACE_DIR / file.filename
        file_path.write_bytes(content)

        result = {
            "filename": file.filename,
            "size": len(content),
            "message": f"Uploaded {file.filename} ({len(content)} bytes)",
        }

        # Auto-convert to markdown if applicable
        ext = file_path.suffix.lower()
        if ext in CONVERTIBLE_EXTENSIONS:
            import subprocess
            md_filename = file_path.stem + ".md"
            md_path = WORKSPACE_DIR / md_filename
            try:
                if ext == ".pdf":
                    # Use pdftotext for PDFs (pandoc can't read them)
                    txt_path = WORKSPACE_DIR / (file_path.stem + ".txt")
                    subprocess.run(
                        ["pdftotext", "-layout", str(file_path), str(txt_path)],
                        check=True,
                        capture_output=True,
                    )
                    # Rename .txt to .md
                    txt_path.rename(md_path)
                else:
                    subprocess.run(
                        ["pandoc", str(file_path), "-o", str(md_path)],
                        check=True,
                        capture_output=True,
                    )
                result["converted"] = md_filename
                result["message"] += f" → converted to {md_filename}"
            except Exception as conv_err:
                result["convert_error"] = str(conv_err)

        return result
    except Exception as e:
        return {"error": str(e)}


# Mount frontend static files (must be last)
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8501))
    logger.info(f"Starting DocAI server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
