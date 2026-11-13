#!/usr/bin/env python3
"""Faux client League (LCU) pour les tests du compagnon.

HTTPS auto-signé sur 127.0.0.1:<port libre>, authentification Basic riot:<token>,
scénario chronométré (fichier JSON) qui fait évoluer gameflow-phase, la session de
sélection des champions et (facultatif, clé "gameflow_session") la session de jeu (file). Écrit le lockfile une fois prêt et journalise chaque requête
(méthode, chemin, authentification correcte) en JSONL.

Usage : fake_lcu.py --scenario s.json --fixtures dir --lockfile f --cert c --key k --log l --token t
"""
import argparse
import base64
import copy
import json
import os
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
for name in ("scenario", "fixtures", "lockfile", "cert", "key", "log", "token"):
    ap.add_argument("--" + name, required=True)
args = ap.parse_args()

with open(args.scenario, encoding="utf-8") as fh:
    STEPS = json.load(fh)
FIXTURES = {}
for step in STEPS:
    for key in ("session", "summoner", "gameflow_session"):
        name = step.get(key)
        if isinstance(name, str) and name not in FIXTURES:
            with open(os.path.join(args.fixtures, name), encoding="utf-8") as fh:
                FIXTURES[name] = json.load(fh)
with open(os.path.join(args.fixtures, "gameflow-session.json"), encoding="utf-8") as fh:
    GAMEFLOW_SESSION = json.load(fh)

START = time.monotonic()
LOCK = threading.Lock()
EXPECTED_AUTH = "Basic " + base64.b64encode(("riot:" + args.token).encode()).decode()


def current_step():
    t = time.monotonic() - START
    acc = 0.0
    for step in STEPS:
        acc += step["for"]
        if t < acc:
            return step, acc - t
    return STEPS[-1], 0.0


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # silence
        pass

    def _send(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _log(self, auth_ok):
        with LOCK, open(args.log, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"method": self.command, "path": self.path, "auth_ok": auth_ok,
                                 "t": round(time.monotonic() - START, 2)}) + "\n")

    def _handle(self):
        auth_ok = self.headers.get("Authorization") == EXPECTED_AUTH
        self._log(auth_ok)
        if not auth_ok:
            return self._send(401, {"errorCode": "UNAUTHORIZED", "httpStatus": 401})
        if self.command != "GET":
            return self._send(405, {"errorCode": "METHOD_NOT_ALLOWED", "httpStatus": 405})
        step, left = current_step()
        not_found = {"errorCode": "RPC_ERROR", "httpStatus": 404, "message": "No active delegate"}
        if self.path == "/lol-summoner/v1/current-summoner":
            name = step.get("summoner", "current-summoner.json")
            if name == 404:
                return self._send(404, not_found)
            return self._send(200, FIXTURES.get(name) or json.load(open(os.path.join(args.fixtures, name))))
        if self.path == "/lol-gameflow/v1/gameflow-phase":
            return self._send(200, step.get("gameflow", "None"))
        if self.path == "/lol-gameflow/v1/session":
            name = step.get("gameflow_session")
            return self._send(200, FIXTURES[name] if name else GAMEFLOW_SESSION)
        if self.path == "/lol-champ-select/v1/session":
            name = step.get("session")
            if not name:
                return self._send(404, not_found)
            sess = copy.deepcopy(FIXTURES[name])
            # Le chrono change à chaque seconde : ne doit PAS provoquer de nouvel envoi.
            sess["timer"]["adjustedTimeLeftInPhase"] = int(left * 1000)
            return self._send(200, sess)
        return self._send(404, not_found)

    do_GET = do_PUT = do_POST = do_PATCH = do_DELETE = _handle


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(args.cert, args.key)
server.socket = ctx.wrap_socket(server.socket, server_side=True)
port = server.server_address[1]
with open(args.lockfile, "w", encoding="utf-8") as fh:
    fh.write("LeagueClient:%d:%d:%s:https" % (os.getpid(), port, args.token))
try:
    server.serve_forever()
finally:
    try:
        os.remove(args.lockfile)
    except OSError:
        pass
