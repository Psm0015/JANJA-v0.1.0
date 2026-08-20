class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.index = 0;
    // Smooth fade on underrun: 1.0 = full volume, fades toward 0 when starved
    this.gain = 1.0;

    this.port.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.queue.push(new Int16Array(event.data));
      }

      // Adaptive jitter buffer: if queue grows too large, gradually discard
      // oldest chunks instead of a single massive splice.
      // Target ~3-4 chunks (~60-80ms at 20ms/chunk), max ~8 (~160ms).
      if (this.queue.length > 8) {
        // Discard 1-2 oldest chunks per incoming message to gently drain
        const excess = this.queue.length - 6;
        const toDrop = Math.min(excess, 2);
        this.queue.splice(0, toDrop);
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];

    for (let frame = 0; frame < left.length; frame += 1) {
      if (!this.current || this.index >= this.current.length) {
        this.current = this.queue.shift() || null;
        this.index = 0;
      }

      if (!this.current || this.index + 1 >= this.current.length) {
        // Underrun: smooth fade to silence to avoid click
        this.gain = Math.max(0, this.gain - 0.002);
        left[frame] = 0;
        right[frame] = 0;
        continue;
      }

      // Recover gain smoothly when data is available
      if (this.gain < 1.0) {
        this.gain = Math.min(1.0, this.gain + 0.005);
      }

      left[frame] = (this.current[this.index] / 32768) * this.gain;
      right[frame] = (this.current[this.index + 1] / 32768) * this.gain;
      this.index += 2;
    }

    return true;
  }
}

registerProcessor("pcm-player", PcmPlayerProcessor);
