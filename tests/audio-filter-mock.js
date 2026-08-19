const port = process.env.PORT || "3000";

async function readBytes(query) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${port}/audio-stream?${query}`);
    const chunks = [];
    let bytes = 0;

    socket.addEventListener("message", async (event) => {
      const buffer = Buffer.from(await event.data.arrayBuffer());
      chunks.push(buffer);
      bytes += buffer.length;

      if (bytes >= 32768) {
        socket.close();
        resolve(Buffer.concat(chunks));
      }
    });

    socket.addEventListener("error", () => {
      reject(new Error(`WebSocket error for ${query}`));
    });

    setTimeout(() => {
      socket.close();
      if (bytes > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`Timeout for ${query}`));
      }
    }, 5000);
  });
}

function rms(buffer) {
  let sum = 0;
  let count = 0;
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    const value = buffer.readInt16LE(index);
    sum += value * value;
    count += 1;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

(async () => {
  const all = await readBytes("mock=1&includePids=101,202,303");
  const filtered = await readBytes("mock=1&includePids=101,303");

  if (all.equals(filtered)) {
    throw new Error("Filtered mock is identical to all-source mock.");
  }

  const allRms = rms(all);
  const filteredRms = rms(filtered);

  if (allRms <= 0 || filteredRms <= 0) {
    throw new Error(`Unexpected silent mock. all=${allRms} filtered=${filteredRms}`);
  }

  console.log(
    `FILTER_MOCK_OK allBytes=${all.length} filteredBytes=${filtered.length} allRms=${allRms.toFixed(1)} filteredRms=${filteredRms.toFixed(1)}`
  );
  process.exit(0);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
