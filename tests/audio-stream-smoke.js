const port = process.env.PORT || "3000";
const mode = process.argv[2] || "mock";
const target =
  mode === "mock"
    ? `ws://localhost:${port}/audio-stream?mock=1`
    : `ws://localhost:${port}/audio-stream?includePids=${encodeURIComponent(process.argv[2] || "")}`;

const socket = new WebSocket(target);
let bytes = 0;
let packets = 0;

function finish(code, message) {
  if (message) {
    console.log(message);
  }
  socket.close();
  setTimeout(() => process.exit(code), 150);
}

socket.addEventListener("message", async (event) => {
  const buffer = Buffer.from(await event.data.arrayBuffer());
  bytes += buffer.length;
  packets += 1;

  if (bytes >= 16384) {
    finish(0, `AUDIO_STREAM_OK mode=${mode} packets=${packets} bytes=${bytes}`);
  }
});

socket.addEventListener("error", () => {
  finish(1, `AUDIO_STREAM_ERROR mode=${mode} packets=${packets} bytes=${bytes}`);
});

setTimeout(() => {
  finish(bytes > 0 ? 0 : 1, `AUDIO_STREAM_TIMEOUT mode=${mode} packets=${packets} bytes=${bytes}`);
}, 5000);
