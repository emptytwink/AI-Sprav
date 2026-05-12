# services/ping.py
import socket
from flask import Blueprint, jsonify

bp_ping = Blueprint("ping", __name__)

@bp_ping.route("/api/ping", methods=["GET"])
def ping():
    return jsonify(
        {
            "ok": True,
            "service": "spravochnik",
            "version": "1.0",
            "host": socket.gethostname(),
        }
    )
