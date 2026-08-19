class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.index = 0;

    this.port.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.queue.push(new Int16Array(event.data));
      }

      if (this.queue.length > 120) {
        this.queue.splice(0, this.queue.length - 120);
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
        left[frame] = 0;
        right[frame] = 0;
        continue;
      }

      left[frame] = this.current[this.index] / 32768;
      right[frame] = this.current[this.index + 1] / 32768;
      this.index += 2;
    }

    return true;
  }
}

registerProcessor("pcm-player", PcmPlayerProcessor);
