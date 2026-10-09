#!/usr/bin/env python3
"""Nightly world backup for the SID server (runs in LXC 120 as root via sid-backup.timer).

Pauses autosave over RCON, flushes the world to disk, archives the world plus the SIDLocal
plugin data, turns autosave back on and keeps the newest 7 archives."""
import glob, os, socket, struct, subprocess, sys, time

SERVER = "/var/lib/pterodactyl/volumes/957838a4-67e6-4c59-a2fc-94c92e984c2a"
BACKUPS = "/root/sid-backups"
KEEP = 7

def props():
    values = {}
    with open(os.path.join(SERVER, "server.properties")) as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, v = line.rstrip("\n").split("=", 1)
                values[k] = v
    return values

def rcon(sock, request_id, kind, body):
    data = struct.pack("<ii", request_id, kind) + body.encode() + b"\x00\x00"
    sock.sendall(struct.pack("<i", len(data)) + data)
    size = struct.unpack("<i", sock.recv(4))[0]
    payload = b""
    while len(payload) < size:
        payload += sock.recv(size - len(payload))
    return payload[8:-2].decode(errors="replace")

def main():
    p = props()
    # Docker publishes RCON on the server address, not on localhost.
    sock = socket.create_connection((os.environ.get("RCON_HOST", "10.0.0.58"), int(p.get("rcon.port", "25576"))), timeout=30)
    rcon(sock, 1, 3, p["rcon.password"])
    rcon(sock, 2, 2, "save-off")
    rcon(sock, 3, 2, "save-all flush")
    time.sleep(3)
    os.makedirs(BACKUPS, mode=0o700, exist_ok=True)
    target = os.path.join(BACKUPS, time.strftime("world-%Y%m%d-%H%M%S.tar.gz"))
    try:
        subprocess.run(["tar", "-czf", target, "-C", SERVER, "world", "plugins/SIDLocal", "server.properties"], check=True)
    finally:
        rcon(sock, 4, 2, "save-on")
        sock.close()
    archives = sorted(glob.glob(os.path.join(BACKUPS, "world-*.tar.gz")))
    for old in archives[:-KEEP]:
        os.remove(old)
    print(f"backup {target} ({os.path.getsize(target) // 1048576} MB), keeping {min(len(archives), KEEP)}")

if __name__ == "__main__":
    sys.exit(main())
