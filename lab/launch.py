"""Merge Intelligence Lab launcher (PyInstaller entry point; also `python lab/launch.py`)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mil.main import main

if __name__ == "__main__":
    main()
