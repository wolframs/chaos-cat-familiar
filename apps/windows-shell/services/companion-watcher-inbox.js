import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// The launcher/supervisor owns the actual watcher process. This class owns only
// bounded JSONL transfer, durable receipts and idle-turn wake delivery.
export class CompanionWatcherInbox extends EventEmitter {
  constructor({ delivery, backend, maxLineBytes = 64 * 1024, maxPendingBytes = 256 * 1024 } = {}) {
    super(); Object.assign(this, { delivery, backend, maxLineBytes, maxPendingBytes });
    this.work = Promise.resolve(); this.buffer = Buffer.alloc(0); this.transport = null; this.closed = false;
    this.changed = () => this.#enqueue(() => this.#drain());
    backend.on('change', this.changed);
  }
  #enqueue(operation) {
    this.work = this.work.then(operation).catch(error => this.emit('fault', error));
  }
  connect(transport) {
    if (this.transport || this.closed) throw new Error('Watcher inbox already connected or stopped.');
    this.transport = transport;
    this.data = chunk => {
      if (this.closed) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (this.buffer.length + bytes.length > this.maxPendingBytes) { this.#fault('Watcher pending byte limit exceeded.'); return; }
      this.buffer = Buffer.concat([this.buffer, bytes]);
      if (this.buffer.indexOf(10) < 0 && this.buffer.length > this.maxLineBytes) { this.#fault('Watcher JSONL line limit exceeded.'); return; }
      transport.readable.pause();
      this.#enqueue(async () => {
        try {
          let newline;
          while ((newline = this.buffer.indexOf(10)) >= 0) {
            if (newline > this.maxLineBytes) { this.#fault('Watcher JSONL line limit exceeded.'); return; }
            const line = this.buffer.subarray(0, newline).toString('utf8'); this.buffer = this.buffer.subarray(newline + 1);
            if (!line.trim()) continue;
            const snapshot = this.backend.getSnapshot();
            if (snapshot.backend !== 'codex' || !snapshot.conversationId || !snapshot.generation) throw new Error('Watcher has no owning Codex conversation.');
            const receipt = this.delivery.receive(JSON.parse(line), snapshot);
            // receive returns only after the atomic durable commit. A write failure
            // sends no receipt, so the unchanged source ID can be replayed safely.
            transport.writable.write(`${JSON.stringify(receipt)}\n`);
          }
          await this.#drain();
        } finally { if (!this.closed) transport.readable.resume(); }
      });
    };
    this.failed = error => this.emit('fault', error);
    this.ended = () => this.emit('fault', new Error('Watcher disconnected; retained source outbox needs supervised reconnect.'));
    transport.readable.on('data', this.data);
    transport.readable.on('error', this.failed);
    transport.readable.on('end', this.ended);
    transport.writable.on('error', this.failed);
  }
  #fault(message) { this.closed = true; this.transport?.readable.pause(); this.buffer = Buffer.alloc(0); this.emit('fault', new Error(message)); }
  async #drain() {
    if (this.closed) return;
    const snapshot = this.backend.getSnapshot();
    if (snapshot.backend !== 'codex' || !snapshot.connected || snapshot.phase !== 'idle') return;
    const events = this.delivery.nextBatch(snapshot);
    if (!events.length) return;
    const result=await this.backend.submit({ id: randomUUID(), text: `Watcher observations (${snapshot.generation}):\n${events.map(event =>
      `[${event.severity}] ${event.source} (${event.id}, observed ${event.occurredAt}): ${event.payload?.text ?? JSON.stringify(event.payload)}`).join('\n')}`,
      eventIds: events.map(event => event.id), attachments: [], source: 'watcher' });
    if(result?.state==='rejected') this.emit('fault',new Error(`Watcher delivery paused after rejection: ${result.reason??'backend rejected input'}`));
  }
  async idle() { let previous; do { previous = this.work; await previous; await new Promise(setImmediate); } while (previous !== this.work); }
  async stop() {
    this.closed = true; this.backend.off('change', this.changed);
    const transport = this.transport; this.transport = null;
    if (transport) {
      transport.readable.off('data', this.data); transport.readable.off('error', this.failed); transport.readable.off('end', this.ended);
      transport.writable.off('error', this.failed);
      await transport.stop();
    }
    await this.idle(); this.buffer = Buffer.alloc(0);
  }
}
