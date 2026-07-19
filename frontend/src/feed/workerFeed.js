// ---------------------------------------------------------------------------
// Worker feed adapter (DataFeed port -> feed.worker.js)
//
// Fulfils the same DataFeed port as the other adapters, but the actual
// pipeline runs inside a Web Worker (see feed.worker.js). This adapter is a
// thin bridge: port methods become postMessage commands, worker messages
// become port events. App.jsx cannot tell the difference — that's the point
// of the port.
// ---------------------------------------------------------------------------

import { Emitter } from '../../../shared/emitter.js';

export class WorkerFeed {
  constructor() {
    this.emitter = new Emitter();
    this.worker = null;
    this.opened = false;
    this.closeEmitted = false;
  }

  connect() {
    this.worker = new Worker(new URL('./feed.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const { event, payload } = e.data || {};
      if (!event) return;
      if (event === 'open') this.opened = true;
      if (event === 'close') {
        this.opened = false;
        this.closeEmitted = true;
      }
      this.emitter.emit(event, payload);
    };
    this.worker.onerror = (err) => {
      console.error('[worker-feed] worker error', err);
      this.emitter.emit('error', err);
    };
    this.worker.postMessage({ cmd: 'connect' });
  }

  close() {
    if (!this.worker) return;
    this.worker.postMessage({ cmd: 'close' });
    // Give the worker a beat to emit its own async 'close', then terminate
    setTimeout(() => {
      this.worker.terminate();
      this.worker = null;
      if (!this.closeEmitted) {
        this.closeEmitted = true;
        this.opened = false;
        this.emitter.emit('close');
      }
    }, 100);
  }

  isOpen() {
    return this.opened;
  }

  on(event, callback) {
    return this.emitter.on(event, callback);
  }

  send(cmd, args) {
    if (this.worker) this.worker.postMessage({ cmd, args });
  }

  subscribe(symbol) {
    this.send('subscribe', [symbol]);
  }

  unsubscribe(symbol) {
    this.send('unsubscribe', [symbol]);
  }

  setAlert(alert) {
    this.send('setAlert', [alert]);
  }

  removeAlert(id) {
    this.send('removeAlert', [id]);
  }
}
