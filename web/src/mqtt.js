/* Minimal MQTT v5 client over a WebSocket. MIT, original code for Nautilus Craft.
 *
 * The game VM runs Mosquitto with `listener 9001` + `protocol websockets`;
 * nginx proxies /mqtt to it. This client supports exactly what the level needs:
 * CONNECT (with a retained presence will), SUBSCRIBE, PUBLISH QoS 0/1,
 * PUBACK, PINGREQ and QoS 1 delivery acknowledgements. MQTT v5 properties are
 * read and skipped, not interpreted.
 */
(function () {
  'use strict';

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function utf8(s) { return enc.encode(String(s)); }

  function varint(n) {
    const out = [];
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      out.push(b);
    } while (n > 0);
    return out;
  }

  function str(s) {
    const b = utf8(s);
    return [(b.length >> 8) & 0xff, b.length & 0xff, ...b];
  }

  function packet(first, body) {
    return new Uint8Array([first, ...varint(body.length), ...body]);
  }

  class MqttV5 {
    constructor(opts) {
      this.url = opts.url;
      this.clientId = opts.clientId || ('nc-' + Math.random().toString(36).slice(2, 10));
      this.keepalive = opts.keepalive || 30;
      this.willTopic = opts.willTopic || '';
      this.onConnect = opts.onConnect || (() => {});
      this.onMessage = opts.onMessage || (() => {});
      this.onOffline = opts.onOffline || (() => {});
      this.onLog = opts.onLog || (() => {});
      this.ws = null;
      this.connected = false;
      this.rx = new Uint8Array(0);
      this.nextId = 1;
      this.pingTimer = 0;
      this.retry = 0;
      this.closed = false;
    }

    connect() {
      if (this.closed) return;
      let ws;
      try {
        ws = new WebSocket(this.url, 'mqtt');
      } catch (e) {
        this.onOffline('bad url');
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => this.sendConnect();
      ws.onmessage = (ev) => this.onData(new Uint8Array(ev.data));
      ws.onerror = () => {};
      ws.onclose = () => {
        this.connected = false;
        clearInterval(this.pingTimer);
        this.onOffline();
        if (!this.closed) {
          this.retry = Math.min(10000, 500 + this.retry * 2);
          setTimeout(() => this.connect(), this.retry);
        }
      };
    }

    sendConnect() {
      const flags = 0x02 | (this.willTopic ? 0x04 | 0x08 | 0x20 : 0);
      const body = [
        ...str('MQTT'), 5, flags,
        (this.keepalive >> 8) & 0xff, this.keepalive & 0xff,
        0, // properties
        ...str(this.clientId)
      ];
      if (this.willTopic) {
        body.push(0); // will properties
        body.push(...str(this.willTopic));
        body.push(0, 0); // empty retained payload clears presence
      }
      this.raw(packet(0x10, body));
    }

    subscribe(filters) {
      const id = this.nextId++ & 0xffff || 1;
      const body = [(id >> 8) & 0xff, id & 0xff, 0];
      for (const f of filters) {
        body.push(...str(f.topic));
        body.push(f.qos | 0);
      }
      this.raw(packet(0x82, body));
      return id;
    }

    publish(topic, payload, qos, retain) {
      const q = qos || 0;
      const id = q ? (this.nextId++ & 0xffff || 1) : 0;
      const body = [...str(topic)];
      if (q) body.push((id >> 8) & 0xff, id & 0xff);
      body.push(0); // properties
      const bytes = typeof payload === 'string' ? utf8(payload) : payload;
      for (const b of bytes) body.push(b);
      const first = 0x30 | (q << 1) | (retain ? 1 : 0);
      this.raw(packet(first, body));
      return id;
    }

    disconnect() {
      this.closed = true;
      clearInterval(this.pingTimer);
      if (this.ws && this.ws.readyState === 1) {
        this.raw(new Uint8Array([0xe0, 0x00]));
      }
      try { this.ws && this.ws.close(); } catch (e) {}
    }

    raw(bytes) {
      if (!this.ws || this.ws.readyState !== 1) return;
      this.ws.send(bytes);
    }

    onData(chunk) {
      const merged = new Uint8Array(this.rx.length + chunk.length);
      merged.set(this.rx, 0);
      merged.set(chunk, this.rx.length);
      this.rx = merged;
      for (;;) {
        if (this.rx.length < 2) return;
        let mult = 1, len = 0, pos = 1, b;
        do {
          if (pos >= this.rx.length) return;
          b = this.rx[pos++];
          len += (b & 0x7f) * mult;
          mult *= 128;
          if (mult > 128 * 128 * 128) { this.rx = new Uint8Array(0); return; }
        } while (b & 0x80);
        if (this.rx.length < pos + len) return;
        const first = this.rx[0];
        const body = this.rx.subarray(pos, pos + len);
        this.rx = this.rx.subarray(pos + len);
        this.handle(first, body);
      }
    }

    handle(first, body) {
      const type = first >> 4;
      if (type === 2) { // CONNACK
        const reason = body.length > 1 ? body[1] : 1;
        if (reason !== 0) {
          this.onLog('connack ' + reason);
          this.onOffline();
          return;
        }
        this.connected = true;
        this.retry = 0;
        this.pingTimer = setInterval(() => this.raw(new Uint8Array([0xc0, 0x00])), Math.max(5, this.keepalive / 2) * 1000);
        this.onConnect();
        return;
      }
      if (type === 3) { // PUBLISH
        const qos = (first >> 1) & 3;
        let pos = 0;
        const tl = (body[pos] << 8) | body[pos + 1]; pos += 2;
        const topic = dec.decode(body.subarray(pos, pos + tl)); pos += tl;
        let id = 0;
        if (qos > 0) { id = (body[pos] << 8) | body[pos + 1]; pos += 2; }
        // v5 properties: skip by length
        let mult = 1, plen = 0, b;
        do { b = body[pos++]; plen += (b & 0x7f) * mult; mult *= 128; } while (b & 0x80);
        pos += plen;
        const payload = body.subarray(pos);
        if (qos === 1) this.raw(new Uint8Array([0x40, 0x02, (id >> 8) & 0xff, id & 0xff]));
        this.onMessage(topic, payload, (first & 1) === 1);
        return;
      }
      if (type === 9) { // SUBACK
        return;
      }
      if (type === 13) { // PINGRESP
        return;
      }
      if (type === 14) { // DISCONNECT
        this.closed = true;
        try { this.ws.close(); } catch (e) {}
      }
    }
  }

  window.MqttV5 = MqttV5;
})();
