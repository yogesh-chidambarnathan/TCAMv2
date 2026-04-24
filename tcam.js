/**
 * TCAM ACL Simulator – Pure JavaScript TCAM engine.
 *
 * Mirrors the C++ TCAM core: entries store value/mask as BigInt pairs,
 * lookup scans top-down for first match, implicit deny at last index.
 */

class TCAMError extends Error { constructor(msg) { super(msg); this.name = 'TCAMError'; } }
class OutOfRangeError extends TCAMError { constructor(msg) { super(msg); this.name = 'OutOfRangeError'; } }
class EntryOccupiedError extends TCAMError { constructor(msg) { super(msg); this.name = 'EntryOccupiedError'; } }
class InvalidWidthError extends TCAMError { constructor(msg) { super(msg); this.name = 'InvalidWidthError'; } }
class SizeMismatchError extends TCAMError { constructor(msg) { super(msg); this.name = 'SizeMismatchError'; } }
class EntryNotValidError extends TCAMError { constructor(msg) { super(msg); this.name = 'EntryNotValidError'; } }

class TCAM {
    constructor(width, depth) {
        if (width < 64 || width % 8 !== 0) {
            throw new InvalidWidthError(
                `Invalid width ${width}: must be a multiple of 8 and at least 64`
            );
        }
        if (depth < 2) {
            throw new TCAMError('Depth must be at least 2 (one user slot + implicit deny)');
        }
        this._width = width;
        this._depth = depth;
        this._wordsPerEntry = Math.ceil(width / 64);
        this._entries = [];
        for (let i = 0; i < depth; i++) {
            this._entries.push({
                value: new Array(this._wordsPerEntry).fill(0n),
                mask: new Array(this._wordsPerEntry).fill(0n),
                action: 'deny',
                valid: false,
            });
        }
    }

    get width() { return this._width; }
    get depth() { return this._depth; }
    get wordsPerEntry() { return this._wordsPerEntry; }

    _checkIndex(index) {
        if (index < 0 || index >= this._depth) {
            throw new OutOfRangeError(`Index ${index} out of range [0, ${this._depth})`);
        }
    }

    isValid(index) {
        this._checkIndex(index);
        return this._entries[index].valid;
    }

    getEntry(index) {
        this._checkIndex(index);
        return this._entries[index];
    }

    program(index, value, mask, action) {
        this._checkIndex(index);
        if (value.length !== this._wordsPerEntry || mask.length !== this._wordsPerEntry) {
            throw new SizeMismatchError(
                `Size mismatch: TCAM expects ${this._wordsPerEntry} word(s) but got value=${value.length}, mask=${mask.length}`
            );
        }
        if (this._entries[index].valid) {
            throw new EntryOccupiedError(`Entry at index ${index} is already occupied`);
        }
        const entry = this._entries[index];
        entry.mask = [...mask];
        entry.value = value.map((v, i) => v & mask[i]);
        entry.action = action;
        entry.valid = true;
    }

    update(index, value, mask, action) {
        this._checkIndex(index);
        if (value.length !== this._wordsPerEntry || mask.length !== this._wordsPerEntry) {
            throw new SizeMismatchError(
                `Size mismatch: TCAM expects ${this._wordsPerEntry} word(s) but got value=${value.length}, mask=${mask.length}`
            );
        }
        if (!this._entries[index].valid) {
            throw new EntryNotValidError(`Entry at index ${index} is not valid`);
        }
        const entry = this._entries[index];
        entry.mask = [...mask];
        entry.value = value.map((v, i) => v & mask[i]);
        entry.action = action;
    }

    invalidate(index) {
        this._checkIndex(index);
        this._entries[index].valid = false;
    }

    lookup(key) {
        if (key.length !== this._wordsPerEntry) {
            throw new SizeMismatchError(
                `Size mismatch: TCAM width requires ${this._wordsPerEntry} word(s) but key has ${key.length}`
            );
        }
        for (let i = 0; i < this._depth; i++) {
            const e = this._entries[i];
            if (!e.valid) continue;
            let match = true;
            for (let w = 0; w < this._wordsPerEntry; w++) {
                if ((key[w] & e.mask[w]) !== e.value[w]) {
                    match = false;
                    break;
                }
            }
            if (match) {
                return { index: i, action: e.action };
            }
        }
        return null;
    }

    /** Pack SIP (u32) + DIP (u32) into a single BigInt word. */
    static packSipDip(sip, dip) {
        return [(BigInt(sip) << 32n) | BigInt(dip)];
    }

    /** Convenience lookup for 64-bit SIP+DIP TCAMs. */
    lookupSipDip(sip, dip) {
        if (this._wordsPerEntry !== 1) {
            throw new SizeMismatchError('SIP/DIP convenience lookup requires a 64-bit TCAM');
        }
        return this.lookup(TCAM.packSipDip(sip, dip));
    }
}

// ---------------------------------------------------------------------------
// IP helpers
// ---------------------------------------------------------------------------

function ipToInt(s) {
    const parts = s.trim().split('.');
    if (parts.length !== 4) throw new Error(`Invalid IPv4 address: ${s}`);
    let n = 0;
    for (let i = 0; i < 4; i++) {
        const octet = parseInt(parts[i], 10);
        if (isNaN(octet) || octet < 0 || octet > 255) throw new Error(`Invalid IPv4 address: ${s}`);
        n = (n * 256) + octet;
    }
    return n;
}

function intToIp(v) {
    return [
        (v >>> 24) & 0xFF,
        (v >>> 16) & 0xFF,
        (v >>> 8) & 0xFF,
        v & 0xFF,
    ].join('.');
}
