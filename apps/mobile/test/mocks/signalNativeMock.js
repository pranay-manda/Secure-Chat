/**
 * Test double for the SignalProtocol native module. Forwards every call over IPC to a child
 * Node process (signalBridge.mjs) that runs the official libsignal Node build, because Jest
 * cannot load libsignal's ES-module native addon in-process. Tests therefore exercise REAL
 * Signal cryptography with exactly the contract of SignalProtocolModule.kt.
 */
const { fork } = require('node:child_process');
const path = require('node:path');

let child;
let nextId = 0;
const pending = new Map();

function worker() {
  if (child) return child;
  child = fork(path.join(__dirname, 'signalBridge.mjs'), [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.on('message', ({ id, result, error }) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    if (error) {
      const err = new Error(error.message);
      err.code = error.code;
      call.reject(err);
    } else {
      call.resolve(result);
    }
  });
  // Do not keep Jest alive because of the worker.
  child.unref();
  child.channel?.unref();
  return child;
}

const call =
  (method) =>
  (...args) =>
    new Promise((resolve, reject) => {
      const id = (nextId += 1);
      pending.set(id, { resolve, reject });
      worker().send({ id, method, args });
    });

const signalNativeMock = Object.fromEntries(
  [
    'generateIdentity',
    'generateSignedPreKey',
    'generateKyberPreKey',
    'generatePreKeys',
    'preKeyMessageInfo',
    'processPreKeyBundle',
    'encrypt',
    'decrypt',
    'securityCode',
  ].map((name) => [name, call(name)]),
);

module.exports = { signalNativeMock };
