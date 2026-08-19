import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import re
import shutil
import socket
import struct
import math
import webbrowser
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import uuid4


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
HELPER_PROJECT = BASE_DIR / "audio-helper" / "AudioHelper.csproj"
HELPER_DLL = BASE_DIR / "audio-helper" / "bin" / "Release" / "net10.0" / "AudioHelper.dll"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

HOST: "WebSocket | None" = None
VIEWERS: dict[str, "WebSocket"] = {}
CLOUDFLARED_PROCESS: "asyncio.subprocess.Process | None" = None
TUNNEL_INFO: dict[str, Any] = {
    "status": "stopped",
    "url": None,
    "watchUrl": None,
    "message": "Tunel ainda nao iniciado.",
}
AUDIO_SELECTION: dict[str, Any] = {
    "enabled": False,
    "includePids": [],
    "mock": False,
    "version": 0,
}


class WebSocket:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader = reader
        self.writer = writer
        self.closed = False
        self._send_lock = asyncio.Lock()

    async def recv_text(self) -> str | None:
        header = await self.reader.readexactly(2)
        first, second = header
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F

        if length == 126:
            length = int.from_bytes(await self.reader.readexactly(2), "big")
        elif length == 127:
            length = int.from_bytes(await self.reader.readexactly(8), "big")

        mask = await self.reader.readexactly(4) if masked else b""
        payload = await self.reader.readexactly(length) if length else b""

        if masked:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))

        if opcode == 0x8:
            await self.close()
            return None

        if opcode == 0x9:
            await self._send_frame(payload, opcode=0xA)
            return ""

        if opcode != 0x1:
            return ""

        return payload.decode("utf-8")

    async def send_json(self, payload: dict[str, Any]) -> None:
        await self.send_text(json.dumps(payload))

    async def send_text(self, text: str) -> None:
        await self._send_frame(text.encode("utf-8"), opcode=0x1)

    async def send_binary(self, payload: bytes) -> None:
        await self._send_frame(payload, opcode=0x2)

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            await self._send_frame(b"", opcode=0x8)
        except OSError:
            pass
        self.writer.close()
        try:
            await self.writer.wait_closed()
        except (OSError, ConnectionResetError):
            pass

    async def _send_frame(self, payload: bytes, opcode: int) -> None:
        if self.closed and opcode != 0x8:
            return

        async with self._send_lock:
            length = len(payload)
            frame = bytearray([0x80 | opcode])

            if length < 126:
                frame.append(length)
            elif length < 65536:
                frame.append(126)
                frame.extend(length.to_bytes(2, "big"))
            else:
                frame.append(127)
                frame.extend(length.to_bytes(8, "big"))

            frame.extend(payload)
            self.writer.write(frame)
            await self.writer.drain()


def local_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def http_response(
    status: str,
    body: bytes,
    content_type: str = "text/plain; charset=utf-8",
    extra_headers: dict[str, str] | None = None,
) -> bytes:
    headers = {
        "Content-Length": str(len(body)),
        "Content-Type": content_type,
        "Connection": "close",
        "Cache-Control": "no-store",
        **(extra_headers or {}),
    }
    head = "\r\n".join([f"HTTP/1.1 {status}", *[f"{key}: {value}" for key, value in headers.items()], "", ""])
    return head.encode("utf-8") + body


def wav_header(sample_rate: int = SAMPLE_RATE if "SAMPLE_RATE" in globals() else 44_100) -> bytes:
    byte_rate = sample_rate * CHANNELS * 2 if "CHANNELS" in globals() else sample_rate * 4
    block_align = CHANNELS * 2 if "CHANNELS" in globals() else 4
    return (
        b"RIFF"
        + struct.pack("<I", 0xFFFFFFFF)
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, CHANNELS if "CHANNELS" in globals() else 2, sample_rate, byte_rate, block_align, 16)
        + b"data"
        + struct.pack("<I", 0xFFFFFFFF)
    )


async def write_stream_headers(writer: asyncio.StreamWriter, content_type: str) -> None:
    headers = "\r\n".join(
        [
            "HTTP/1.1 200 OK",
            f"Content-Type: {content_type}",
            "Cache-Control: no-store",
            "Connection: close",
            "",
            "",
        ]
    )
    writer.write(headers.encode("ascii"))
    await writer.drain()


async def send_json(ws: WebSocket | None, payload: dict[str, Any]) -> None:
    if ws is None or ws.closed:
        return
    try:
        await ws.send_json(payload)
    except OSError:
        ws.closed = True


async def read_request(reader: asyncio.StreamReader) -> tuple[str, str, dict[str, str]] | None:
    request_line = await reader.readline()
    if not request_line:
        return None

    parts = request_line.decode("iso-8859-1").strip().split()
    if len(parts) != 3:
        return None

    method, target, _version = parts
    headers: dict[str, str] = {}

    while True:
        line = await reader.readline()
        if line in {b"\r\n", b"\n", b""}:
            break

        name, _, value = line.decode("iso-8859-1").partition(":")
        headers[name.strip().lower()] = value.strip()

    return method, target, headers


async def serve_http(path: str, writer: asyncio.StreamWriter) -> None:
    if path == "/health":
        body = json.dumps({"ok": True, "host": HOST is not None, "viewers": len(VIEWERS)}).encode("utf-8")
        writer.write(http_response("200 OK", body, "application/json"))
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        return

    if path == "/tunnel":
        body = json.dumps(TUNNEL_INFO).encode("utf-8")
        writer.write(http_response("200 OK", body, "application/json"))
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        return

    if path in {"/", "/host", "/watch"}:
        file_path = STATIC_DIR / "index.html"
    elif path.startswith("/static/"):
        relative = unquote(path.removeprefix("/static/"))
        file_path = (STATIC_DIR / relative).resolve()
        if not str(file_path).startswith(str(STATIC_DIR.resolve())):
            writer.write(http_response("403 Forbidden", b"Forbidden"))
            await writer.drain()
            writer.close()
            await writer.wait_closed()
            return
    else:
        writer.write(http_response("404 Not Found", b"Not found"))
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        return

    if not file_path.exists() or not file_path.is_file():
        writer.write(http_response("404 Not Found", b"Not found"))
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        return

    body = file_path.read_bytes()
    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
        content_type += "; charset=utf-8"

    writer.write(http_response("200 OK", body, content_type))
    await writer.drain()
    writer.close()
    await writer.wait_closed()


async def ensure_audio_helper() -> None:
    if HELPER_DLL.exists():
        return

    if shutil.which("dotnet") is None:
        raise RuntimeError("dotnet nao encontrado para compilar o helper de audio.")

    process = await asyncio.create_subprocess_exec(
        "dotnet",
        "build",
        str(HELPER_PROJECT),
        "-c",
        "Release",
        cwd=str(BASE_DIR),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    output, _ = await process.communicate()
    if process.returncode != 0:
        raise RuntimeError(output.decode("utf-8", errors="replace"))


async def run_audio_helper(*args: str) -> dict[str, Any] | list[Any]:
    await ensure_audio_helper()

    process = await asyncio.create_subprocess_exec(
        "dotnet",
        str(HELPER_DLL),
        *args,
        cwd=str(BASE_DIR),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    if process.returncode != 0:
        error = stderr.decode("utf-8", errors="replace").strip() or stdout.decode("utf-8", errors="replace").strip()
        raise RuntimeError(error or f"Audio helper falhou com codigo {process.returncode}.")

    return json.loads(stdout.decode("utf-8"))


async def serve_audio_apps(writer: asyncio.StreamWriter) -> None:
    try:
        apps = await run_audio_helper("list")
        body = json.dumps({"ok": True, "apps": apps}).encode("utf-8")
        writer.write(http_response("200 OK", body, "application/json"))
    except Exception as exc:
        body = json.dumps({"ok": False, "message": str(exc)}).encode("utf-8")
        writer.write(http_response("500 Internal Server Error", body, "application/json"))

    await writer.drain()
    writer.close()
    await writer.wait_closed()


async def serve_audio_mute(reader: asyncio.StreamReader, headers: dict[str, str], writer: asyncio.StreamWriter) -> None:
    try:
        length = int(headers.get("content-length", "0"))
        raw_body = await reader.readexactly(length) if length else b"{}"
        payload = json.loads(raw_body.decode("utf-8"))
        process_id = str(int(payload["processId"]))
        muted = "true" if bool(payload["muted"]) else "false"
        result = await run_audio_helper("mute", process_id, muted)
        body = json.dumps({"ok": True, "result": result}).encode("utf-8")
        writer.write(http_response("200 OK", body, "application/json"))
    except Exception as exc:
        body = json.dumps({"ok": False, "message": str(exc)}).encode("utf-8")
        writer.write(http_response("500 Internal Server Error", body, "application/json"))

    await writer.drain()
    writer.close()
    await writer.wait_closed()


async def serve_audio_selection(reader: asyncio.StreamReader, method: str, headers: dict[str, str], writer: asyncio.StreamWriter) -> None:
    global AUDIO_SELECTION

    try:
        if method == "POST":
            length = int(headers.get("content-length", "0"))
            raw_body = await reader.readexactly(length) if length else b"{}"
            payload = json.loads(raw_body.decode("utf-8"))
            include_pids = [str(int(pid)) for pid in payload.get("includePids", [])]
            AUDIO_SELECTION = {
                "enabled": bool(payload.get("enabled")) and (bool(include_pids) or bool(payload.get("mock"))),
                "includePids": include_pids,
                "mock": bool(payload.get("mock")),
                "version": int(AUDIO_SELECTION["version"]) + 1,
            }

        body = json.dumps({"ok": True, **AUDIO_SELECTION}).encode("utf-8")
        writer.write(http_response("200 OK", body, "application/json"))
    except Exception as exc:
        body = json.dumps({"ok": False, "message": str(exc), **AUDIO_SELECTION}).encode("utf-8")
        writer.write(http_response("500 Internal Server Error", body, "application/json"))

    await writer.drain()
    writer.close()
    await writer.wait_closed()


CHUNK_SIZE = 8192
SAMPLE_RATE = 44_100
CHANNELS = 2


def parse_pid_list(value: str) -> list[str]:
    pids = []
    for item in value.split(","):
        item = item.strip()
        if item.isdigit() and item not in pids:
            pids.append(item)
    return pids


def mix_pcm16(chunks: list[bytes], size: int = CHUNK_SIZE) -> bytes:
    if not chunks:
        return b"\x00" * size

    padded = [chunk[:size].ljust(size, b"\x00") for chunk in chunks]
    output = bytearray(size)

    for offset in range(0, size, 2):
        value = 0
        for chunk in padded:
            value += int.from_bytes(chunk[offset : offset + 2], "little", signed=True)

        value = max(-32768, min(32767, value))
        output[offset : offset + 2] = int(value).to_bytes(2, "little", signed=True)

    return bytes(output)


async def generate_mock_audio(ws: WebSocket, process_ids: list[str] | None = None) -> None:
    ids = [int(pid) for pid in (process_ids or ["1"])]
    phases = [0.0 for _ in ids]
    frequencies = [220.0 + (pid % 12) * 37.0 for pid in ids]
    frames = CHUNK_SIZE // (CHANNELS * 2)

    try:
        while not ws.closed:
            samples = bytearray()
            for _ in range(frames):
                mixed = 0.0
                for index, frequency in enumerate(frequencies):
                    mixed += math.sin(phases[index]) * (7000 / max(1, len(frequencies)))
                    phases[index] += 2 * math.pi * frequency / SAMPLE_RATE
                    if phases[index] > 2 * math.pi:
                        phases[index] -= 2 * math.pi

                value = int(max(-32768, min(32767, mixed)))
                samples.extend(struct.pack("<hh", value, value))

            await ws.send_binary(bytes(samples))
            await asyncio.sleep(frames / SAMPLE_RATE)
    except (ConnectionResetError, asyncio.IncompleteReadError, OSError):
        pass
    finally:
        await ws.close()


def mock_audio_chunk(phases: list[float], frequencies: list[float]) -> tuple[bytes, list[float]]:
    frames = CHUNK_SIZE // (CHANNELS * 2)
    samples = bytearray()
    for _ in range(frames):
        mixed = 0.0
        for index, frequency in enumerate(frequencies):
            mixed += math.sin(phases[index]) * (7000 / max(1, len(frequencies)))
            phases[index] += 2 * math.pi * frequency / SAMPLE_RATE
            if phases[index] > 2 * math.pi:
                phases[index] -= 2 * math.pi

        value = int(max(-32768, min(32767, mixed)))
        samples.extend(struct.pack("<hh", value, value))

    return bytes(samples), phases


async def stream_mock_wav(writer: asyncio.StreamWriter, process_ids: list[str] | None = None) -> None:
    ids = [int(pid) for pid in (process_ids or ["1"])]
    phases = [0.0 for _ in ids]
    frequencies = [220.0 + (pid % 12) * 37.0 for pid in ids]
    frames = CHUNK_SIZE // (CHANNELS * 2)

    await write_stream_headers(writer, "audio/wav")
    writer.write(wav_header())
    await writer.drain()

    try:
        while True:
            chunk, phases = mock_audio_chunk(phases, frequencies)
            writer.write(chunk)
            await writer.drain()
            await asyncio.sleep(frames / SAMPLE_RATE)
    except (ConnectionResetError, BrokenPipeError, OSError):
        pass
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except (OSError, ConnectionResetError):
            pass


async def stream_single_process_audio(ws: WebSocket, process_id: str, mode: str) -> None:
    process: asyncio.subprocess.Process | None = None

    try:
        await ensure_audio_helper()
        process = await asyncio.create_subprocess_exec(
            "dotnet",
            str(HELPER_DLL),
            mode,
            process_id,
            cwd=str(BASE_DIR),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        if process.stdout is None:
            await ws.close()
            return

        while not ws.closed:
            chunk = await process.stdout.read(8192)
            if not chunk:
                break
            await ws.send_binary(chunk)
    except (ConnectionResetError, asyncio.IncompleteReadError, OSError):
        pass
    finally:
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        await ws.close()


async def stream_single_process_wav(writer: asyncio.StreamWriter, process_id: str, mode: str = "stream-include") -> None:
    process: asyncio.subprocess.Process | None = None

    await write_stream_headers(writer, "audio/wav")
    writer.write(wav_header())
    await writer.drain()

    try:
        await ensure_audio_helper()
        process = await asyncio.create_subprocess_exec(
            "dotnet",
            str(HELPER_DLL),
            mode,
            process_id,
            cwd=str(BASE_DIR),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )

        if process.stdout is None:
            return

        while True:
            chunk = await process.stdout.read(CHUNK_SIZE)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, OSError):
        pass
    finally:
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        writer.close()
        try:
            await writer.wait_closed()
        except (OSError, ConnectionResetError):
            pass


async def pump_process_audio(process: asyncio.subprocess.Process, queue: asyncio.Queue[bytes]) -> None:
    if process.stdout is None:
        return

    try:
        while True:
            chunk = await process.stdout.read(CHUNK_SIZE)
            if not chunk:
                break
            try:
                queue.put_nowait(chunk)
            except asyncio.QueueFull:
                _ = queue.get_nowait()
                queue.put_nowait(chunk)
    except (asyncio.CancelledError, OSError):
        raise
    except Exception:
        return


async def stream_mixed_process_audio(ws: WebSocket, process_ids: list[str]) -> None:
    processes: list[asyncio.subprocess.Process] = []
    pump_tasks: list[asyncio.Task[Any]] = []
    queues: list[asyncio.Queue[bytes]] = []
    buffers: list[bytearray] = []

    try:
        await ensure_audio_helper()

        for process_id in process_ids:
            process = await asyncio.create_subprocess_exec(
                "dotnet",
                str(HELPER_DLL),
                "stream-include",
                process_id,
                cwd=str(BASE_DIR),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=12)
            processes.append(process)
            queues.append(queue)
            buffers.append(bytearray())
            pump_tasks.append(asyncio.create_task(pump_process_audio(process, queue)))

        while not ws.closed:
            chunks: list[bytes] = []

            for index, queue in enumerate(queues):
                while True:
                    try:
                        buffers[index].extend(queue.get_nowait())
                    except asyncio.QueueEmpty:
                        break

                if len(buffers[index]) >= CHUNK_SIZE:
                    chunks.append(bytes(buffers[index][:CHUNK_SIZE]))
                    del buffers[index][:CHUNK_SIZE]

            if chunks:
                await ws.send_binary(mix_pcm16(chunks))
            else:
                await ws.send_binary(b"\x00" * CHUNK_SIZE)

            await asyncio.sleep((CHUNK_SIZE // (CHANNELS * 2)) / SAMPLE_RATE)
    except (ConnectionResetError, asyncio.IncompleteReadError, OSError):
        pass
    finally:
        for task in pump_tasks:
            task.cancel()

        for process in processes:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=3)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()

        await ws.close()


async def stream_mixed_process_wav(writer: asyncio.StreamWriter, process_ids: list[str]) -> None:
    processes: list[asyncio.subprocess.Process] = []
    pump_tasks: list[asyncio.Task[Any]] = []
    queues: list[asyncio.Queue[bytes]] = []
    buffers: list[bytearray] = []

    await write_stream_headers(writer, "audio/wav")
    writer.write(wav_header())
    await writer.drain()

    try:
        await ensure_audio_helper()

        for process_id in process_ids:
            process = await asyncio.create_subprocess_exec(
                "dotnet",
                str(HELPER_DLL),
                "stream-include",
                process_id,
                cwd=str(BASE_DIR),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=12)
            processes.append(process)
            queues.append(queue)
            buffers.append(bytearray())
            pump_tasks.append(asyncio.create_task(pump_process_audio(process, queue)))

        while True:
            chunks: list[bytes] = []

            for index, queue in enumerate(queues):
                while True:
                    try:
                        buffers[index].extend(queue.get_nowait())
                    except asyncio.QueueEmpty:
                        break

                if len(buffers[index]) >= CHUNK_SIZE:
                    chunks.append(bytes(buffers[index][:CHUNK_SIZE]))
                    del buffers[index][:CHUNK_SIZE]

            writer.write(mix_pcm16(chunks) if chunks else b"\x00" * CHUNK_SIZE)
            await writer.drain()
            await asyncio.sleep((CHUNK_SIZE // (CHANNELS * 2)) / SAMPLE_RATE)
    except (ConnectionResetError, BrokenPipeError, OSError):
        pass
    finally:
        for task in pump_tasks:
            task.cancel()

        for process in processes:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=3)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()

        writer.close()
        try:
            await writer.wait_closed()
        except (OSError, ConnectionResetError):
            pass


async def serve_selected_wav(writer: asyncio.StreamWriter, query: dict[str, list[str]] | None = None) -> None:
    query = query or {}
    if query.get("mock", ["0"])[0] == "1" or AUDIO_SELECTION["mock"]:
        pids = parse_pid_list(query.get("includePids", [""])[0]) or AUDIO_SELECTION["includePids"] or ["101", "202"]
        await stream_mock_wav(writer, pids)
        return

    include_pids = parse_pid_list(query.get("includePids", [""])[0]) or [
        str(pid) for pid in AUDIO_SELECTION["includePids"] if str(pid).isdigit()
    ]
    if not include_pids:
        writer.write(http_response("409 Conflict", b"Audio selection is disabled"))
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        return

    if len(include_pids) == 1:
        await stream_single_process_wav(writer, include_pids[0])
    else:
        await stream_mixed_process_wav(writer, include_pids)


async def upgrade_websocket(headers: dict[str, str], writer: asyncio.StreamWriter) -> None:
    key = headers.get("sec-websocket-key", "")
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
    response = "\r\n".join(
        [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Accept: {accept}",
            "",
            "",
        ]
    )
    writer.write(response.encode("ascii"))
    await writer.drain()


async def handle_ws(ws: WebSocket) -> None:
    global HOST

    role: str | None = None
    client_id = uuid4().hex

    try:
        while not ws.closed:
            raw = await ws.recv_text()
            if raw is None:
                break
            if not raw:
                continue

            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "message": "Mensagem invalida."})
                continue

            message_type = data.get("type")

            if message_type == "join":
                role = data.get("role")

                if role == "host":
                    if HOST and not HOST.closed and HOST is not ws:
                        await send_json(HOST, {"type": "host-replaced"})
                        await HOST.close()

                    HOST = ws
                    await ws.send_json({"type": "joined", "role": "host"})
                    for viewer_id, viewer in list(VIEWERS.items()):
                        if viewer.closed:
                            VIEWERS.pop(viewer_id, None)
                            continue
                        await ws.send_json({"type": "viewer-joined", "viewerId": viewer_id})
                    continue

                if role == "viewer":
                    VIEWERS[client_id] = ws
                    await ws.send_json({"type": "joined", "role": "viewer", "viewerId": client_id})
                    await send_json(HOST, {"type": "viewer-joined", "viewerId": client_id})
                    continue

                await ws.send_json({"type": "error", "message": "Papel desconhecido."})
                continue

            if message_type in {"offer", "host-ice"} and role == "host":
                viewer = VIEWERS.get(data.get("viewerId", ""))
                await send_json(viewer, data)
                continue

            if message_type in {"answer", "viewer-ice"} and role == "viewer":
                data["viewerId"] = client_id
                await send_json(HOST, data)
                continue

            await ws.send_json({"type": "error", "message": "Mensagem nao aceita."})
    except (asyncio.IncompleteReadError, ConnectionResetError, OSError):
        pass
    finally:
        if role == "host" and HOST is ws:
            HOST = None
            for viewer in list(VIEWERS.values()):
                await send_json(viewer, {"type": "host-left"})

        if role == "viewer":
            VIEWERS.pop(client_id, None)
            await send_json(HOST, {"type": "viewer-left", "viewerId": client_id})

        await ws.close()


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    request = await read_request(reader)
    if request is None:
        writer.close()
        await writer.wait_closed()
        return

    method, target, headers = request
    parsed_url = urlsplit(target)
    path = parsed_url.path

    if method == "GET" and path == "/audio/apps":
        await serve_audio_apps(writer)
        return

    if method == "GET" and path in {"/audio-current.wav", "/audio-preview.wav"}:
        await serve_selected_wav(writer, parse_qs(parsed_url.query))
        return

    if path == "/audio/selection" and method in {"GET", "POST"}:
        await serve_audio_selection(reader, method, headers, writer)
        return

    if method == "POST" and path == "/audio/mute":
        await serve_audio_mute(reader, headers, writer)
        return

    if method != "GET":
        writer.write(http_response("405 Method Not Allowed", b"Method not allowed"))
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        return

    if path == "/ws" and headers.get("upgrade", "").lower() == "websocket":
        await upgrade_websocket(headers, writer)
        await handle_ws(WebSocket(reader, writer))
        return

    if path == "/audio-stream" and headers.get("upgrade", "").lower() == "websocket":
        query = parse_qs(parsed_url.query)
        if query.get("mock", ["0"])[0] == "1":
            include_pids = parse_pid_list(query.get("includePids", ["1"])[0]) or ["1"]
            await upgrade_websocket(headers, writer)
            await generate_mock_audio(WebSocket(reader, writer), include_pids)
            return

        include_pids = parse_pid_list(query.get("includePids", [""])[0])
        legacy_exclude_pid = query.get("excludePid", [""])[0]

        if not include_pids and legacy_exclude_pid.isdigit():
            await upgrade_websocket(headers, writer)
            await stream_single_process_audio(WebSocket(reader, writer), legacy_exclude_pid, "stream-exclude")
            return

        if not include_pids:
            writer.write(http_response("400 Bad Request", b"Missing includePids"))
            await writer.drain()
            writer.close()
            await writer.wait_closed()
            return

        await upgrade_websocket(headers, writer)
        if len(include_pids) == 1:
            await stream_single_process_audio(WebSocket(reader, writer), include_pids[0], "stream-include")
        else:
            await stream_mixed_process_audio(WebSocket(reader, writer), include_pids)
        return

    if path == "/audio-stream-current" and headers.get("upgrade", "").lower() == "websocket":
        if not AUDIO_SELECTION["enabled"]:
            writer.write(http_response("409 Conflict", b"Audio selection is disabled"))
            await writer.drain()
            writer.close()
            await writer.wait_closed()
            return

        await upgrade_websocket(headers, writer)
        if AUDIO_SELECTION["mock"]:
            await generate_mock_audio(WebSocket(reader, writer), AUDIO_SELECTION["includePids"] or ["101", "202"])
        else:
            include_pids = [str(pid) for pid in AUDIO_SELECTION["includePids"] if str(pid).isdigit()]
            if len(include_pids) == 1:
                await stream_single_process_audio(WebSocket(reader, writer), include_pids[0], "stream-include")
            else:
                await stream_mixed_process_audio(WebSocket(reader, writer), include_pids)
        return

    await serve_http(path, writer)


def find_cloudflared() -> str | None:
    local_exe = BASE_DIR / "cloudflared.exe"
    if local_exe.exists():
        return str(local_exe)

    return shutil.which("cloudflared") or shutil.which("cloudflared.exe")


async def read_cloudflared_output(process: asyncio.subprocess.Process) -> None:
    url_pattern = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

    if process.stdout is None:
        return

    while True:
        line = await process.stdout.readline()
        if not line:
            break

        text = line.decode("utf-8", errors="replace").rstrip()
        if text:
            print(text)

        match = url_pattern.search(text)
        if match:
            url = match.group(0)
            TUNNEL_INFO.update(
                {
                    "status": "ready",
                    "url": url,
                    "watchUrl": f"{url}/watch",
                    "message": "Tunel pronto.",
                }
            )
            print()
            print(f"Link para enviar: {url}/watch")
            print()

    exit_code = await process.wait()
    if TUNNEL_INFO["status"] != "ready":
        TUNNEL_INFO.update(
            {
                "status": "error",
                "url": None,
                "watchUrl": None,
                "message": f"cloudflared encerrou antes de criar o link. Codigo: {exit_code}",
            }
        )
    elif exit_code != 0:
        TUNNEL_INFO["status"] = "stopped"
        TUNNEL_INFO["message"] = f"cloudflared encerrou. Codigo: {exit_code}"


async def start_cloudflared(port: int) -> None:
    global CLOUDFLARED_PROCESS

    if os.environ.get("DISABLE_TUNNEL", "").lower() in {"1", "true", "yes"}:
        TUNNEL_INFO.update(
            {
                "status": "disabled",
                "url": None,
                "watchUrl": None,
                "message": "Tunel desativado por DISABLE_TUNNEL.",
            }
        )
        return

    executable = find_cloudflared()
    if executable is None:
        TUNNEL_INFO.update(
            {
                "status": "missing",
                "url": None,
                "watchUrl": None,
                "message": "Coloque cloudflared.exe nesta pasta ou instale no PATH.",
            }
        )
        print("cloudflared.exe nao encontrado. O app local vai abrir, mas sem link publico.")
        return

    TUNNEL_INFO.update(
        {
            "status": "starting",
            "url": None,
            "watchUrl": None,
            "message": "Criando tunel publico...",
        }
    )
    CLOUDFLARED_PROCESS = await asyncio.create_subprocess_exec(
        executable,
        "tunnel",
        "--url",
        f"http://localhost:{port}",
        cwd=str(BASE_DIR),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    asyncio.create_task(read_cloudflared_output(CLOUDFLARED_PROCESS))


async def open_host_browser(port: int) -> None:
    if os.environ.get("OPEN_BROWSER", "1").lower() in {"0", "false", "no"}:
        return

    await asyncio.sleep(0.8)
    webbrowser.open(f"http://localhost:{port}/host")


async def stop_cloudflared() -> None:
    if CLOUDFLARED_PROCESS is None or CLOUDFLARED_PROCESS.returncode is not None:
        return

    CLOUDFLARED_PROCESS.terminate()
    try:
        await asyncio.wait_for(CLOUDFLARED_PROCESS.wait(), timeout=5)
    except asyncio.TimeoutError:
        CLOUDFLARED_PROCESS.kill()
        await CLOUDFLARED_PROCESS.wait()


async def main() -> None:
    port = int(os.environ.get("PORT", "3000"))
    server = await asyncio.start_server(handle_client, host="0.0.0.0", port=port)
    ip = local_ip()

    print("JANJA v0.1.0 - Janela de Acesso Nativo e Jornada Assistida")
    print(f"Host local:   http://localhost:{port}/host")
    print(f"Viewer local: http://localhost:{port}/watch")
    print(f"LAN viewer:   http://{ip}:{port}/watch")
    print()
    print("Abrindo navegador e iniciando Cloudflare Tunnel...")
    print()

    await start_cloudflared(port)
    asyncio.create_task(open_host_browser(port))

    try:
        async with server:
            await server.serve_forever()
    finally:
        await stop_cloudflared()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
