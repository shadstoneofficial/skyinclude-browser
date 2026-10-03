const fs = require('fs');
const path = require('path');

// The caller supplies already-redacted lines. Disk work is serialized off the main thread.
class AsyncLogWriter {
    constructor({
        filePath,
        fileSystem = fs.promises,
        maxFileBytes = 2 * 1024 * 1024,
        maxPendingBytes = 512 * 1024,
        batchBytes = 32 * 1024,
        onError = error => console.error('Failed to write SkyInclude log:', error)
    } = {}) {
        if (!filePath) throw new TypeError('A log filePath is required');
        if (![maxFileBytes, maxPendingBytes, batchBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
            throw new TypeError('Log limits must be positive integer byte counts');
        }
        this.filePath = filePath;
        this.backupPath = `${filePath}.1`;
        this.fileSystem = fileSystem;
        this.maxFileBytes = maxFileBytes;
        this.maxPendingBytes = maxPendingBytes;
        this.batchBytes = Math.min(batchBytes, maxFileBytes);
        this.onError = onError;
        this.queue = [];
        this.pendingBytes = 0;
        this.droppedLines = 0;
        this.fileBytes = null;
        this.writePromise = null;
    }

    append(line) {
        const text = String(line);
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes === 0) return true;
        if (bytes > this.maxFileBytes || bytes + this.pendingBytes > this.maxPendingBytes) {
            this.droppedLines += 1;
            return false;
        }
        this.queue.push({ text, bytes });
        this.pendingBytes += bytes;
        void this.startDrain();
        return true;
    }

    startDrain() {
        if (this.writePromise) return this.writePromise;
        this.writePromise = this.drain().then(success => {
            this.writePromise = null;
            if (success && this.queue.length > 0) return this.startDrain();
            return success;
        });
        return this.writePromise;
    }

    async initialize() {
        await this.fileSystem.mkdir(path.dirname(this.filePath), { recursive: true });
        try {
            this.fileBytes = (await this.fileSystem.stat(this.filePath)).size;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            this.fileBytes = 0;
        }
    }

    async rotate() {
        try {
            await this.fileSystem.unlink(this.backupPath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        try {
            await this.fileSystem.rename(this.filePath, this.backupPath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        this.fileBytes = 0;
    }

    async drain() {
        try {
            if (this.queue.length === 0) return true;
            if (this.fileBytes === null) await this.initialize();
            while (this.queue.length > 0) {
                let count = 0;
                let bytes = 0;
                while (count < this.queue.length) {
                    const next = this.queue[count];
                    if (count > 0 && bytes + next.bytes > this.batchBytes) break;
                    bytes += next.bytes;
                    count += 1;
                }
                const text = this.queue.slice(0, count).map(entry => entry.text).join('');
                if (this.fileBytes + bytes > this.maxFileBytes) await this.rotate();
                await this.fileSystem.appendFile(this.filePath, text, { encoding: 'utf8', mode: 0o600 });
                this.fileBytes += bytes;
                this.queue.splice(0, count);
                this.pendingBytes -= bytes;
            }
            return true;
        } catch (error) {
            // Keep the bounded queue so an explicit flush or subsequent append can retry it.
            this.fileBytes = null;
            try { this.onError(error); } catch (_) { /* Do not reject a fire-and-forget append. */ }
            return false;
        }
    }

    async flush() {
        let success;
        do {
            success = await this.startDrain();
        } while (success && this.queue.length > 0);
        return success;
    }
}

module.exports = { AsyncLogWriter };
