Import("env")

import subprocess
import sys
from pathlib import Path

project = Path(env["PROJECT_DIR"])
repo = project / ".." / ".." / ".."
lua = repo / "device-apps" / "field-recorder.lua"
out = project / "src" / "field-recorder.embed.h"
script = repo / "tools" / "embed-lua-app.py"

subprocess.run(
    [sys.executable, str(script), str(lua), str(out), "FIELD_RECORDER_APP"],
    check=True,
)
