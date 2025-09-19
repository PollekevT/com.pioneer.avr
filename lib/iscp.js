// lib/iscp.js
'use strict';

const net = require('net');
const EventEmitter = require('events');

class ISCPClient extends EventEmitter {
  /**
   * @param {string} host - IP of the device
   * @param {number} port - default 60128 (some models may use 8102)
   */
  constructor(host, port = 60128) {
    super();
    this.host = host;
    this.port = port;
    this.client = null;
    this.connected = false;
    this.buffer = '';
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.connected) return resolve();

      this.client = new net.Socket();
      this.client.setEncoding('utf8');

      this.client.on('connect', () => {
        this.connected = true;
        resolve();
      });

      this.client.on('data', (data) => this._onData(data));
      this.client.on('close', () => {
        this.connected = false;
        this.emit('close');
      });

      this.client.on('error', (err) => {
        this.connected = false;
        this.emit('error', err);
      });

      this.client.connect(this.port, this.host);
    });
  }

  _onData(data) {
    this.buffer += data;

    // eISCP messages end with \x1a (ISCP end byte)
    let messages = this.buffer.split('\x1a');
    while (messages.length > 1) {
      const msg = messages.shift();
      this._parseMessage(msg);
    }
    this.buffer = messages[0]; // keep remainder
  }

  _parseMessage(msg) {
    // Basic parsing: strip ISCP header if present
    // Most messages look like: ISCP\x00\x00\x00\x10!1PWR01\x1a
    const commandMatch = msg.match(/!1([A-Z]{3})(.*)/);
    if (commandMatch) {
      const command = commandMatch[1];
      const value = commandMatch[2];
      this.emit('message', { command, value });
    }
  }

  /**
   * Send a command
   * @param {string} command - e.g., PWR01 (power on), MVL50 (volume 50)
   */
  sendCommand(command) {
    if (!this.connected) throw new Error('Not connected to device');

    // Minimal ISCP header (24 bytes): 'ISCP' + 4-byte header + payload length + payload + terminator
    const payload = `!1${command}\x0D`; // 0x0D = carriage return
    const length = Buffer.byteLength(payload);
    const header = Buffer.alloc(16);
    header.write('ISCP');          // 4 bytes
    header.writeUInt32BE(length, 8); // 4 bytes payload length at offset 8

    const packet = Buffer.concat([header, Buffer.from(payload, 'ascii')]);
    this.client.write(packet);
  }

  disconnect() {
    if (this.client) this.client.end();
    this.connected = false;
  }
}

module.exports = ISCPClient;
