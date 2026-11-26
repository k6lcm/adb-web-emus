/*
 * AudioWorkletProcessor for the Agfa 9000PS VERA audio engine.
 * Streams 48 kHz interleaved stereo int16 samples (PSG + PCM) from a circular
 * ring buffer, capping queued frames at ~100 ms so Fast mode never builds lag.
 */

const RING_FRAMES = 16384; // power of two (~341 ms at 48 kHz)
const RING_MASK = RING_FRAMES - 1;
const MAX_BUFFERED = 4800; // 0.1 s at 48 kHz

class Agfa9000AudioProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.left = new Float32Array(RING_FRAMES);
		this.right = new Float32Array(RING_FRAMES);
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
				const frames = samples.length >> 1;
				if (frames <= 0 || this.count + frames > MAX_BUFFERED) {
					return;
				}
				let w = this.writeIdx;
				for (let i = 0; i < frames; i++) {
					this.left[w] = samples[i * 2] / 32768.0;
					this.right[w] = samples[i * 2 + 1] / 32768.0;
					w = (w + 1) & RING_MASK;
				}
				this.writeIdx = w;
				this.count += frames;
			}
		};
	}

	process(_inputs, outputs) {
		const output = outputs[0];
		if (!output || !output[0]) return true;

		const outL = output[0];
		const outR = output[1] || null;
		const len = outL.length;
		let r = this.readIdx;
		let avail = this.count;

		for (let i = 0; i < len; i++) {
			if (avail > 0) {
				if (outR) {
					outL[i] = this.left[r];
					outR[i] = this.right[r];
				} else {
					outL[i] = (this.left[r] + this.right[r]) * 0.5;
				}
				r = (r + 1) & RING_MASK;
				avail--;
			} else {
				outL[i] = 0;
				if (outR) outR[i] = 0;
			}
		}

		this.readIdx = r;
		this.count = avail;
		return true;
	}
}

registerProcessor('agfa9000-audio', Agfa9000AudioProcessor);
