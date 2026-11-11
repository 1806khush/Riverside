// MediaRecorder writes an EBML header, a Segment, and Clusters containing blocks.
// An interrupted stream may end in a header or payload. Preserve the last whole
// element, descending into the unknown-sized Segment and Clusters Chrome writes.
export class WebmBoundary {
  private header = new Uint8Array(12)
  private headerLength = 0
  private next = 0
  private payload = false
  private valid = true
  private safe = 0

  push(bytes: Uint8Array, offset: number): number | undefined {
    if (!this.valid) return undefined
    const limit = offset + bytes.length
    if (this.next > limit) return this.safe
    if (this.payload) {
      this.safe = this.next
      this.payload = false
    }

    while (this.next < limit) {
      this.header[this.headerLength++] = bytes[this.next++ - offset]
      const idLength = markerWidth(this.header[0])
      if (!idLength || idLength > 4) return this.invalidate()
      if (this.headerLength <= idLength) continue
      const sizeLength = markerWidth(this.header[idLength])
      if (!sizeLength) return this.invalidate()
      if (this.headerLength < idLength + sizeLength) continue

      let id = 0
      for (let i = 0; i < idLength; i++) id = id * 256 + this.header[i]
      const sizeMask = 0xff >> sizeLength
      let size = this.header[idLength] & sizeMask
      let unknown = size === sizeMask
      for (let i = idLength + 1; i < this.headerLength; i++) {
        size = size * 256 + this.header[i]
        unknown &&= this.header[i] === 0xff
      }
      if (this.next === this.headerLength && id !== 0x1a45dfa3) return this.invalidate()
      this.headerLength = 0
      if (unknown) {
        if (id !== 0x18538067 && id !== 0x1f43b675) return this.invalidate()
        continue
      }

      this.next += size
      if (!Number.isSafeInteger(this.next)) return this.invalidate()
      if (this.next > limit) {
        this.payload = true
        break
      }
      this.safe = this.next
    }
    return this.safe
  }

  private invalidate() {
    this.valid = false
    return undefined
  }
}

function markerWidth(byte: number) {
  for (let length = 1, bit = 0x80; bit; length++, bit >>= 1) {
    if (byte & bit) return length
  }
  return 0
}

export async function trimInterruptedWebm(blob: Blob, safeEnd?: number) {
  if (safeEnd === undefined && blob.type.startsWith('video/webm')) {
    const scanner = new WebmBoundary()
    const reader = blob.stream().getReader()
    let offset = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        safeEnd = scanner.push(value, offset)
        if (safeEnd === undefined) break
        offset += value.length
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  return safeEnd !== undefined ? blob.slice(0, safeEnd, blob.type) : blob
}
