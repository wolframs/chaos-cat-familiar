import { PassThrough } from 'node:stream';
/** In-memory executable boundary; never starts a model or reads user state. */
export function createFakeCodexServer(handler = () => undefined) {
  const readable = new PassThrough(); const writable = new PassThrough(); const frames = [];
  let pending = '';
  const server = {readable,writable,frames, closed:false,
    emit(frame) { readable.write(JSON.stringify(frame)+'\n'); },
    async stop() { server.closed = true; readable.end(); writable.end(); }};
  writable.on('data', chunk => {
    pending += String(chunk); let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const frame = JSON.parse(pending.slice(0,newline)); pending = pending.slice(newline+1); frames.push(frame);
      Promise.resolve(handler(frame,server)).catch(error => readable.destroy(error));
    }
  });
  return server;
}
