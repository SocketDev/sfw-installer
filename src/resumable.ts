import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';

import plf from 'proper-lockfile';

import { httpsGetWithRange } from './httpUtils.ts';
import { swallowError } from './util.ts';

function checkIntegrity(fd: number, hash: crypto.Hash, expectedDigestHex: string): boolean {
  const buffer = Buffer.alloc(64 * 1024);
  let bytesRead = 0;
  let position = 0;
  do {
    bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } while (bytesRead > 0);
  const digestHex = hash.digest('hex');
  return digestHex === expectedDigestHex;
}

function saveToDisk(
  res: IncomingMessage,
  fd: number,
  bytesAlreadyDownloaded: number,
  aborted: () => boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let currentOffset = bytesAlreadyDownloaded;

    res.on('data', (chunk: Buffer) => {
      if (aborted()) {
        return reject();
      }
      const currentChunkOffset = currentOffset;
      currentOffset += chunk.byteLength;
      fs.writeSync(fd, chunk, 0, chunk.length, currentChunkOffset);
    });

    res.on('end', () => {
      if (aborted()) {
        return reject();
      }
      resolve();
    });

    res.on('error', reject);
  });
}

async function downloadWithResume(
  url: string,
  fd: number,
  bytesAlreadyDownloaded: number,
  aborted: () => boolean,
  hash: crypto.Hash,
  expectedDigestHex: string,
  pendingDownloadPath: string,
): Promise<IncomingMessage | null> {
  const res = await httpsGetWithRange(url, bytesAlreadyDownloaded);

  await saveToDisk(res, fd, bytesAlreadyDownloaded, aborted);
  fs.fsyncSync(fd);

  if (!checkIntegrity(fd, hash, expectedDigestHex)) {
    fs.unlinkSync(pendingDownloadPath);
    throw new Error('Downloaded file integrity check failed');
  }
  fs.closeSync(fd);

  return res;
}

function getSizeOnDisk(fd: number) {
  let sizeOnDisk = 0;
  try {
    sizeOnDisk = fs.fstatSync(fd).size;
  } catch (_e) {}
  return sizeOnDisk;
}

export async function eagerAcquireLockAndDownload(
  url: string,
  destination: string,
  expectedDigestAlgo: string,
  expectedDigestHex: string,
) {
  const hash = crypto.createHash(expectedDigestAlgo);
  let aborted = false;
  const lockfilePath = `${destination}.lock`;
  const pendingDownloadPath = `${destination}.dl`;

  const release = await plf.lock(lockfilePath, {
    realpath: false,
    onCompromised: (_err: Error) => {
      aborted = true;
    },
  });

  const fd = fs.openSync(pendingDownloadPath, 'w+');
  const bytesAlreadyDownloaded = getSizeOnDisk(fd);

  let response: IncomingMessage | null = null;
  try {
    response = await downloadWithResume(
      url,
      fd,
      bytesAlreadyDownloaded,
      () => aborted,
      hash,
      expectedDigestHex,
      pendingDownloadPath,
    );
  } finally {
    response?.destroy();
    await swallowError(() => release());
    swallowError(() => fs.closeSync(fd));
  }

  fs.renameSync(pendingDownloadPath, destination);
}
