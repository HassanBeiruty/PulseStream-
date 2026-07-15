// ---------------------------------------------------------------------------
// Hub socket adapter (DataFeed port -> our WebSocket distribution server)
//
// Wraps a real WebSocket connection to OUR OWN server (the distribution
// layer) and translates between the wire protocol and the DataFeed port:
//
//   port method            ->  client->server JSON message
//   server->client message ->  port event
//
// Serialization is an ADAPTER concern: the JSON protocol strings live here
// (imported from shared/protocol.js — the same constants the server uses),
// never in the UI. See feed/index.js for the port definition.
// ---------------------------------------------------------------------------

import { Emitter } from '../../../shared/emitter.js';
import { ClientMsg, ServerMsg } from '../../../shared/protocol.js';

export class HubSocketFeed {
  constructor(url) {
    this.url = url;
    this.emitter = new Emitter();
    this.ws = null;
  }

  // --- lifecycle -------------------------------------------------------------

  connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => this.emitter.emit('open');
    ws.onclose = () => this.emitter.emit('close');
    ws.onerror = (err) => this.emitter.emit('error', err);

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        console.error('[hub-feed] failed to parse server message', err);
        return;
      }
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case ServerMsg.UPDATE:
          if (msg.data) this.emitter.emit('update', msg.data);
          break;
        case ServerMsg.FEED_STATUS:
          this.emitter.emit('feedStatus', {
            status: msg.status,
            attempt: msg.attempt,
            delay: msg.delay,
          });
          break;
        case ServerMsg.ALERT_CONFIRMED:
          if (msg.data) this.emitter.emit('alertConfirmed', msg.data);
          break;
        case ServerMsg.ALERT_REMOVED:
          if (msg.data) this.emitter.emit('alertRemoved', msg.data);
          break;
        case ServerMsg.ALERT_TRIGGERED:
          if (msg.data) this.emitter.emit('alertTriggered', msg.data);
          break;
        default:
          break;
      }
    };
  }

  close() {
    if (this.ws) this.ws.close();
  }

  isOpen() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  on(event, callback) {
    return this.emitter.on(event, callback);
  }

  // --- port methods -> wire messages ------------------------------------------

  subscribe(symbol) {
    this.sendMessage({ type: ClientMsg.SUBSCRIBE, symbol });
  }

  unsubscribe(symbol) {
    this.sendMessage({ type: ClientMsg.UNSUBSCRIBE, symbol });
  }

  setAlert({ id, symbol, value, condition }) {
    this.sendMessage({ type: ClientMsg.SET_ALERT, id, symbol, value, condition });
  }

  removeAlert(id) {
    this.sendMessage({ type: ClientMsg.REMOVE_ALERT, id });
  }

  sendMessage(msg) {
    if (this.isOpen()) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
