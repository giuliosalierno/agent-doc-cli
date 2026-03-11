import sys
import os
from pathlib import Path

# Add 'app' to path to import tools
sys.path.append(str(Path(__file__).parent / "app"))
from app.tools.document_tools import upload_doc, WORKSPACE_DIR

def test_upload():
    # File in root directory
    test_file = "../test_upload.md"
    
    print(f"Attempting to upload: {test_file}")
    print(f"File exists? {Path(test_file).exists()}")
    
    result = upload_doc(test_file)
    print(f"Result: {result}")
    
    # Check workspace
    workspace_file = WORKSPACE_DIR / "test_upload.md"
    print(f"Workspace file exists? {workspace_file.exists()}")
    if workspace_file.exists():
        print(f"Size: {workspace_file.stat().st_size} bytes")
        with open(workspace_file, 'r') as f:
            print("First line of content:", f.readline().strip())

if __name__ == "__main__":
    test_upload()
