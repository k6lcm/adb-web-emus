/*
 * AudioWorkletProcessor for the Compucorp 665 Web emulator.
 * Streams 48 kHz mono audio synthesized by the emulator core from a circular
 * ring buffer, capping queued samples at 0.1 s (4800 samples) so fast mode
 * never builds audio lag.
 */

const RING_SIZE = 8192; // power of two (~170 ms at 48 kHz)
const RING_MASK = RING_SIZE - 1;
const MAX_BUFFERED = 4800; // 0.1 s at 48 kHz (RATE / 10)

class Cc665AudioProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.ring = new Float32Array(RING_SIZE);
		this.readIdx = 0;
		this.writeIdx = 0;
		this.count = 0;

		this.port.onmessage = (event) => {
			const data = event.data;
			if (!data) return;

			if (data.type === 'clear') {
				this.readIdx = 0;
				this.writeIdx = 0;
				this.count = 0;
				return;
			}

			const samples = data.samples || data;
			if (samples instanceof Int16Array) {
				const n = samples.length;
				if (this.count + n > MAX_BUFFERED) {
					return;
				}
				let w = this.writeIdx;
				for (let i = 0; i < n; i++) {
					this.ring[w] = samples[i] / 32768.0;
					w = (w + 1) & RING_MASK;
				}
				this.writeIdx = w;
				this.count += n;
			} else if (samples instanceof Float32Array || Array.isArray(samples)) {
				const n = samples.length;
				if (this.count + n > MAX_BUFFERED) {
					return;
				}
				let w = this.writeIdx;
				for (let i = 0; i < n; i++) {
					this.ring[w] = samples[i];
					w = (w + 1) & RING_MASK;
				}
				this.writeIdx = w;
				this.count += n;
			}
		};
	}

	process(_inputs, outputs) {
		const output = outputs[0];
		if (!output || !output[0]) return true;

		const channel = output[0];
		const len = channel.length;
		let r = this.readIdx;
		let avail = this.count;

		for (let i = 0; i < len; i++) {
			if (avail > 0) {
				channel[i] = this.ring[r];
				r = (r + 1) & RING_MASK;
				avail--;
			} else {
				channel[i] = 0;
			}
		}

		this.readIdx = r;
		this.count = avail;

		// Copy mono output to any additional channels if present
		for (let c = 1; c < output.length; c++) {
			output[c].set(channel);
		}

		return true;
	}
}

registerProcessor('cc665-audio', Cc665AudioProcessor);
