'use strict';

const Homey = require('homey');
const net = require('net');
const EventEmitter = require('events');

/**
 * eISCP TCP client for Pioneer/Onkyo devices
 */
class ISCPClient extends EventEmitter {
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

    // eISCP messages end with 0x1A
    let messages = this.buffer.split('\x1a');
    while (messages.length > 1) {
      const msg = messages.shift();
      this._parseMessage(msg);
    }
    this.buffer = messages[0]; // remainder
  }

  _parseMessage(msg) {
    const commandMatch = msg.match(/!1([A-Z]{3})(.*)/);
    if (commandMatch) {
      const command = commandMatch[1];
      const value = commandMatch[2];
      this.emit('message', { command, value });
    }
  }

  sendCommand(command) {
    if (!this.connected) throw new Error('Not connected');
    const payload = `!1${command}\x0D`; // carriage return
    const length = Buffer.byteLength(payload);
    const header = Buffer.alloc(16);
    header.write('ISCP');              // 4 bytes
    header.writeUInt32BE(length, 8);   // 4-byte payload length at offset 8
    const packet = Buffer.concat([header, Buffer.from(payload, 'ascii')]);
    this.client.write(packet);
  }

  disconnect() {
    if (this.client) this.client.end();
    this.connected = false;
  }
}

/**
 * Homey Device class
 */
class PioneerDevice extends Homey.Device {
  async onInit() {
    this._host = this.getSetting('host') || (this.getData && this.getData().host);
    this._iscp = new ISCPClient(this._host);

    this._iscp.on('message', (msg) => this._onMessage(msg));
    this._iscp.on('close', () => this._onDisconnect());
    this._iscp.on('error', (err) => this._onError(err));

    await this._connect();
  }

  async _connect() {
    if (!this._host) {
      this.setUnavailable('no_host');
      return;
    }

    try {
      await this._iscp.connect();
      this.setAvailable();
      this.log(`Connected to ${this.getName()} at ${this._host}`);
    } catch (err) {
      this.setUnavailable(err.message);
      this.log(`Connection failed for ${this.getName()}: ${err.message}`);
      setTimeout(() => this._connect(), 10000); // retry
    }
  }

  _onMessage({ command, value }) {
    switch (command) {
      case 'PWR':
        this.setCapabilityValue('onoff', value === '01');
        break;
      case 'MVL':
        this.setCapabilityValue('volume', parseInt(value, 10));
        break;
      case 'AMT':
        this.setCapabilityValue('mute', value === '01');
        break;
      case 'SLT':
        this.setCapabilityValue('input', value);
        break;
      default:
        this.log('Unhandled ISCP message:', command, value);
    }
  }

  _onDisconnect() {
    this.setUnavailable('connection_closed');
    this.log(`Disconnected from ${this.getName()}`);
    setTimeout(() => this._connect(), 10000);
  }

  _onError(err) {
    this.setUnavailable(err.message || 'iscp_error');
    this.log(`ISCP error for ${this.getName()}:`, err);
  }

  async _ensureConnected() {
    if (!this._iscp.connected) {
      await this._connect();
      if (!this._iscp.connected) throw new Error('Not connected');
    }
  }

  async setPower(on) {
    await this._ensureConnected();
    this._iscp.sendCommand(`PWR${on ? '01' : '00'}`);
  }

  async setVolume(value) {
    await this._ensureConnected();
    const vol = Math.max(0, Math.min(100, value));
    this._iscp.sendCommand(`MVL${vol.toString().padStart(2, '0')}`);
  }

  async setMute(mute) {
    await this._ensureConnected();
    this._iscp.sendCommand(`AMT${mute ? '01' : '00'}`);
  }

  async setInput(inputCode) {
    await this._ensureConnected();
    this._iscp.sendCommand(`SLT${inputCode}`);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('host') && newSettings.host !== oldSettings.host) {
      this._host = newSettings.host;
      this._iscp.disconnect();
      this._iscp = new ISCPClient(this._host);
      this._iscp.on('message', (msg) => this._onMessage(msg));
      this._iscp.on('close', () => this._onDisconnect());
      this._iscp.on('error', (err) => this._onError(err));
      await this._connect();
    }
  }

  async onDeleted() {
    if (this._iscp) this._iscp.disconnect();
  }
}

module.exports = PioneerDevice;
