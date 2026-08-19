const port = process.env.PORT || "3000";

async function publishSelection() {
  const response = await fetch(`http://localhost:${port}/audio/selection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      includePids: [101, 303],
      mock: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Selection failed with HTTP ${response.status}`);
  }

  return response.json();
}

function readCurrentStream() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${port}/audio-stream-current`);
    let bytes = 0;
    let packets = 0;

    function finish(code, message) {
      socket.close();
      setTimeout(() => (code === 0 ? resolve(message) : reject(new Error(message))), 100);
    }

    socket.addEventListener("message", async (event) => {
      const buffer = Buffer.from(await event.data.arrayBuffer());
      bytes += buffer.length;
      packets += 1;

      if (bytes >= 16384) {
        finish(0, `AUDIO_CURRENT_OK packets=${packets} bytes=${bytes}`);
      }
    });

    socket.addEventListener("error", () => {
      finish(1, `AUDIO_CURRENT_ERROR packets=${packets} bytes=${bytes}`);
    });

    setTimeout(() => {
      finish(bytes > 0 ? 0 : 1, `AUDIO_CURRENT_TIMEOUT packets=${packets} bytes=${bytes}`);
    }, 5000);
  });
}

(async () => {
  const selection = await publishSelection();
  const message = await readCurrentStream();
  console.log(`${message} version=${selection.version}`);
  process.exit(0);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
