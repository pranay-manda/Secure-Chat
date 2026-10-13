/**
 * expo-file-system (new File/Directory API) on the real file system. Each simulated device has
 * its own root (`globalThis.__device.fsRoot`) with `files/` (Paths.document) and `cache/`
 * (Paths.cache), so app data survives a "relaunch" (jest.resetModules) like on a phone.
 *
 * Network transfers go to `globalThis.__blobServer(request)`, which a test installs:
 *   ({ method, url, headers, body?: Buffer }) => { status, body?: Buffer } (or throws: offline)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function deviceRoot() {
  const device = globalThis.__device;
  if (!device.fsRoot) {
    device.fsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-device-'));
    fs.mkdirSync(path.join(device.fsRoot, 'files'));
    fs.mkdirSync(path.join(device.fsRoot, 'cache'));
  }
  return device.fsRoot;
}

const toUri = (p) => `file://${p.replace(/\\/g, '/')}`;
const fromUri = (uri) => (uri.startsWith('file://') ? decodeURI(uri.slice(7)) : uri);

function resolve(parts) {
  let current = '';
  for (const part of parts) {
    if (part && typeof part === 'object' && 'path' in part) current = part.path;
    else if (typeof part === 'string') {
      current =
        part.startsWith('file://') || path.isAbsolute(part)
          ? fromUri(part)
          : path.join(current, part);
    }
  }
  return path.normalize(current);
}

class Directory {
  constructor(...parts) {
    this.path = resolve(parts);
  }
  get uri() {
    return `${toUri(this.path)}/`;
  }
  get name() {
    return path.basename(this.path);
  }
  get exists() {
    return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory();
  }
  create() {
    fs.mkdirSync(this.path, { recursive: true });
  }
  delete() {
    fs.rmSync(this.path, { recursive: true, force: true });
  }
  list() {
    return fs.readdirSync(this.path).map((name) => {
      const full = path.join(this.path, name);
      return fs.statSync(full).isDirectory() ? new Directory(full) : new File(full);
    });
  }
}

function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

class File {
  constructor(...parts) {
    this.path = resolve(parts);
  }
  get uri() {
    return toUri(this.path);
  }
  get name() {
    return path.basename(this.path);
  }
  get exists() {
    return fs.existsSync(this.path) && fs.statSync(this.path).isFile();
  }
  get size() {
    return fs.statSync(this.path).size;
  }
  delete() {
    fs.rmSync(this.path);
  }
  async move(destination) {
    fs.renameSync(this.path, destination.path);
    this.path = destination.path;
  }
  createUploadTask(url, options = {}) {
    const file = this;
    return {
      async uploadAsync() {
        if (options.signal?.aborted) throw abortError();
        const body = fs.readFileSync(file.path);
        globalThis.__transfers?.push({ method: options.httpMethod ?? 'POST', url });
        const res = await globalThis.__blobServer({
          method: options.httpMethod ?? 'POST',
          url,
          headers: options.headers ?? {},
          body,
        });
        options.onProgress?.({ bytesSent: body.length, totalBytes: body.length });
        return { status: res.status, body: '', headers: {} };
      },
      release() {},
    };
  }
  static createDownloadTask(url, destination, options = {}) {
    return {
      async downloadAsync() {
        globalThis.__transfers?.push({ method: 'GET', url });
        const res = await globalThis.__blobServer({
          method: 'GET',
          url,
          headers: options.headers ?? {},
        });
        if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
        const body = res.body ?? Buffer.alloc(0);
        // Streams in two halves so progress (and the size cap) are exercised.
        const half = Math.ceil(body.length / 2);
        fs.writeFileSync(destination.path, body.subarray(0, half));
        options.onProgress?.({ bytesWritten: half, totalBytes: body.length });
        if (options.signal?.aborted) {
          fs.rmSync(destination.path, { force: true });
          throw abortError();
        }
        fs.appendFileSync(destination.path, body.subarray(half));
        options.onProgress?.({ bytesWritten: body.length, totalBytes: body.length });
        if (options.signal?.aborted) {
          fs.rmSync(destination.path, { force: true });
          throw abortError();
        }
        return destination;
      },
      release() {},
    };
  }
}

const Paths = {
  get document() {
    return new Directory(path.join(deviceRoot(), 'files'));
  },
  get cache() {
    return new Directory(path.join(deviceRoot(), 'cache'));
  },
};

module.exports = { File, Directory, Paths, deviceRoot };
