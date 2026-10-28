import { describe, expect, it } from "vitest";

import {
  base64ToInt16,
  floatToInt16,
  int16ToBase64,
  int16ToFloat,
  resample,
  rms,
  sampleRateFromMime,
} from "./pcm";

describe("pcm", () => {
  it("clamps and converts float samples to int16", () => {
    expect(Array.from(floatToInt16(new Float32Array([0, 1, -1, 2, -2])))).toEqual([
      0, 32767, -32768, 32767, -32768,
    ]);
  });

  it("round-trips int16 through float", () => {
    const pcm = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const back = floatToInt16(int16ToFloat(pcm));
    back.forEach((v, i) => expect(Math.abs(v - pcm[i])).toBeLessThanOrEqual(1));
  });

  it("round-trips base64 as little-endian bytes", () => {
    const pcm = new Int16Array([1, -2, 300, -32768]);
    const b64 = int16ToBase64(pcm);
    expect(Array.from(base64ToInt16(b64))).toEqual(Array.from(pcm));
    // 1 as int16 LE is bytes 01 00
    expect(atob(b64).charCodeAt(0)).toBe(1);
    expect(atob(b64).charCodeAt(1)).toBe(0);
  });

  it("encodes buffers larger than the chunk size", () => {
    const pcm = new Int16Array(100_000).map((_, i) => i % 1000);
    expect(base64ToInt16(int16ToBase64(pcm))).toEqual(pcm);
  });

  it("respects the view offset of a subarray", () => {
    const pcm = new Int16Array([9, 9, 5, 6]).subarray(2);
    expect(Array.from(base64ToInt16(int16ToBase64(pcm)))).toEqual([5, 6]);
  });

  it("resamples 48 kHz to 16 kHz with the right length", () => {
    const input = new Float32Array(4800).fill(0.5);
    const out = resample(input, 48000, 16000);
    expect(out.length).toBe(1600);
    expect(out.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });

  it("returns the input unchanged when rates match", () => {
    const input = new Float32Array([1, 2, 3]);
    expect(resample(input, 16000, 16000)).toBe(input);
  });

  it("computes rms", () => {
    expect(rms(new Float32Array([]))).toBe(0);
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
  });

  it("parses the sample rate from a mime type", () => {
    expect(sampleRateFromMime("audio/pcm;rate=24000")).toBe(24000);
    expect(sampleRateFromMime("audio/pcm")).toBe(24000);
    expect(sampleRateFromMime(undefined, 16000)).toBe(16000);
  });
});
