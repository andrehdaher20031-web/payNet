const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const { crc32 } = require('node:zlib');

// The official S3 archive also works where the CDN returns a regional 403.
// Read the ZIP through yauzl's range API to avoid downloading debug symbols.
async function windowsBinary(version) {
  if (!/^7\.0\.\d+$/.test(version)) throw new Error('Unsupported monitoring test binary version');
  const directory = path.join(os.tmpdir(), 'paynet-monitoring-mongo', version);
  const target = path.join(directory, 'mongod.exe');
  if (fs.existsSync(target)) return target;
  const url = `https://s3.amazonaws.com/downloads.mongodb.org/windows/mongodb-windows-x86_64-${version}.zip`;
  const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`MongoDB archive returned ${response.status}`);
  const size = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('Invalid MongoDB archive size');
  class ArchiveReader extends yauzl.RandomAccessReader {
    _readStreamForRange(start, end) {
      return Readable.from((async function* () {
        const result = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal: AbortSignal.timeout(600000) });
        if (result.status !== 206) throw new Error('MongoDB archive does not support range requests');
        for await (const chunk of result.body) yield Buffer.from(chunk);
      })());
    }
  }
  const zip = await new Promise((resolve, reject) => yauzl.fromRandomAccessReader(new ArchiveReader(), size, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
  try {
    const entry = await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', () => reject(new Error('MongoDB executable missing from archive')));
      zip.on('entry', item => /\/bin\/mongod\.exe$/.test(item.fileName) ? resolve(item) : zip.readEntry());
      zip.readEntry();
    });
    console.log(`Preparing isolated MongoDB: ${(entry.compressedSize / 1048576).toFixed(1)} MB`);
    const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
    fs.mkdirSync(directory, { recursive: true });
    const partial = `${target}.partial`;
    let checksum = 0;
    const check = new Transform({ transform(chunk, _encoding, callback) { checksum = crc32(chunk, checksum); callback(null, chunk); } });
    try {
      await pipeline(stream, check, fs.createWriteStream(partial));
      if (checksum !== entry.crc32) throw new Error('MongoDB executable checksum mismatch');
      fs.renameSync(partial, target);
    } catch (error) { fs.rmSync(partial, { force: true }); throw error; }
    return target;
  } finally { zip.close(); }
}
module.exports = { windowsBinary };
