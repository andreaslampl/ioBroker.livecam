'use strict';

/**
 * Splits a byte stream of concatenated JPEG images (ffmpeg image2pipe, MJPEG
 * multipart bodies) into single frames using the SOI (FF D8) and EOI (FF D9)
 * markers. Bytes between frames, such as multipart headers, are skipped.
 */
class JpegSplitter {
    constructor(onFrame, { maxFrameSize = 8 * 1024 * 1024 } = {}) {
        this.onFrame = onFrame;
        this.maxFrameSize = maxFrameSize;
        this.buf = Buffer.alloc(0);
        this.searchFrom = 0;
    }

    push(chunk) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        for (;;) {
            const start = this.buf.indexOf(SOI);
            if (start < 0) {
                // Keep a trailing 0xFF in case the marker is split across chunks.
                this.buf = this.buf.subarray(Math.max(0, this.buf.length - 1));
                this.searchFrom = 0;
                return;
            }
            if (start > 0) {
                this.buf = this.buf.subarray(start);
                this.searchFrom = 0;
            }
            const end = this.buf.indexOf(EOI, Math.max(2, this.searchFrom));
            if (end < 0) {
                if (this.buf.length > this.maxFrameSize) {
                    // Garbage or a truncated frame: drop it and resync.
                    this.buf = this.buf.subarray(2);
                    this.searchFrom = 0;
                    continue;
                }
                this.searchFrom = Math.max(2, this.buf.length - 1);
                return;
            }
            const frame = Buffer.from(this.buf.subarray(0, end + 2));
            this.buf = this.buf.subarray(end + 2);
            this.searchFrom = 0;
            this.onFrame(frame);
        }
    }

    reset() {
        this.buf = Buffer.alloc(0);
        this.searchFrom = 0;
    }
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

module.exports = { JpegSplitter };
