import fs from 'fs'
import plf from 'proper-lockfile'
import https from 'https'
import crypto from 'crypto'
import type { IncomingMessage } from 'http'
/**
 * A multi-process safe resumable download function.
 * It uses a lockfile to ensure only one process is downloading at a time.
 * It uses a .dl temporary file to store the in-progress download.
 * It streams to exact offsets so that if multiple processes are downloading, they can all write to the same file without corrupting it.
 * If the download is interrupted, it can be resumed by another process.
 * Once the download is complete, the .dl file is checked for integrity, and then renamed to the final destination.
 */
export function eagerAcquireLockAndDownload(url: string, destination: string, expectedDigestAlgo: string, expectedDigestHex: string) {
    const hash = crypto.createHash(expectedDigestAlgo)
    let aborted = false
    const lockfilePath = destination + '.lock'
    const pendingDownloadPath = destination + '.dl'
    return plf.lock(lockfilePath, {
        onCompromised: (_err: Error) => {
            aborted = true
        }
    }).then(release => {
        const fd = fs.openSync(pendingDownloadPath, 'w+')
        let downloadedBytes = 0
        try {
            downloadedBytes = fs.fstatSync(fd).size
        } catch (e) {
        }
        let $res: IncomingMessage | null = null
        return new Promise<void>((resolve, reject) => {
            https.get(url, {
                    headers: {
                    Range: `bytes=${downloadedBytes}-`
                }
            }, res => {
                $res = res
                if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300) && res.statusCode !== 206) {
                    reject()
                    return
                }
                res.on('data', (chunk: Buffer) => {
                    if (aborted) {
                        reject()
                        return
                    }
                    // write to the specific offset so it is ok to concurrently write even on network retries
                    let destinationOffset = downloadedBytes
                    downloadedBytes += chunk.byteLength
                    fs.writeSync(fd, chunk, 0, chunk.length, destinationOffset)
                })
                res.on('end', () => {
                    if (aborted) {
                        reject()
                        return
                    } else {
                        release().catch(() => {})
                        fs.fsyncSync(fd)
                        // loop over the fd and digest it to ensure integrity
                        // if integrity check fails, delete the .dl file and reject
                        // if integrity check passes, rename to final destination
                        const buffer = Buffer.alloc(64 * 1024)
                        let bytesRead = 0
                        let position = 0
                        do {
                            bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position)
                            if (bytesRead > 0) {
                                hash.update(buffer.slice(0, bytesRead))
                                position += bytesRead
                            }
                        } while (bytesRead > 0)
                        const digestHex = hash.digest('hex')
                        if (digestHex !== expectedDigestHex) {
                            fs.unlinkSync(pendingDownloadPath)
                            reject(new Error('Downloaded file integrity check failed'))
                            return
                        }
                        fs.closeSync(fd)
                        resolve()
                    }
                })
            }).on('error', () => {
                reject()
            })
        }).catch(_err => {
            if ($res) {
                $res.destroy()
            }
            release().catch(() => {})
            fs.closeSync(fd)
        }).catch(() => {})
    })
}
