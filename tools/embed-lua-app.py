#!/usr/bin/env python3
"""Generate a C header embedding a Lua source file as a raw string literal."""
from __future__ import annotations

import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) < 3:
        print("usage: embed-lua-app.py SOURCE.lua OUTPUT.h [SYMBOL]", file=sys.stderr)
        sys.exit(2)

    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    symbol = sys.argv[3] if len(sys.argv) > 3 else "EMBEDDED_LUA_APP"
    text = src.read_text(encoding="utf-8")

    delim = "LUAAPP"
    while f"){delim}" in text:
        delim += "X"

    dst.write_text(
        "#pragma once\n"
        f'static const char {symbol}[] = R"{delim}({text}){delim}";\n',
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
