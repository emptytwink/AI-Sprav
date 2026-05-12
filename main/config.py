# main/config.py
from pathlib import Path

class Config:
    BASE_DIR = Path(__file__).resolve().parent.parent

    UPLOAD_DIR = None
    SYNC_DIR = "sync"
    SYNC_INTERVAL = 15
    SYNC_AUTOSTART = "false"
