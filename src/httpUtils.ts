import https from 'node:https'
import { URL } from 'node:url'
import type { IncomingMessage } from 'node:http'

export interface HttpGetOptions {
  headers?: Record<string, string>
  maxRedirects?: number
  userAgent?: string
}

export async function httpsGet(url: string, options: HttpGetOptions = {}): Promise<IncomingMessage> {
  const { headers = {}, maxRedirects = 5, userAgent } = options
  
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const opts = {
      headers: {
        ...(userAgent && { 'User-Agent': userAgent }),
        ...headers
      }
    }
    
    https.get(u, opts, (res: IncomingMessage) => {
      const { statusCode, headers: h } = res
      if (statusCode === undefined) {
        return reject(new Error(`GET ${url} failed with no status code`))
      }
      if (statusCode >= 300 && statusCode < 400 && h.location && maxRedirects > 0) {
        res.resume()
        return resolve(httpsGet(h.location, { ...options, maxRedirects: maxRedirects - 1 }))
      }
      if (statusCode < 200 || statusCode >= 300) {
        res.resume()
        return reject(new Error(`GET ${url} failed with ${statusCode}`))
      }
      resolve(res)
    }).on('error', reject)
  })
}

export async function httpsGetWithRange(url: string, startByte: number, options: HttpGetOptions = {}): Promise<IncomingMessage> {
  const rangeHeaders = {
    Range: `bytes=${startByte}-`,
    ...options.headers
  }
  
  return httpsGet(url, {
    ...options,
    headers: rangeHeaders
  })
}

export async function getText(url: string, options: HttpGetOptions = {}): Promise<string> {
  const res = await httpsGet(url, options)
  return new Promise<string>((resolve, reject) => {
    let data = ""
    res.setEncoding("utf8")
    res.on("data", (c) => { data += c; })
    res.on("end", () => resolve(data))
    res.on("error", reject)
  })
}

export async function getJSON(url: string, options: HttpGetOptions = {}): Promise<any> {
  const s = await getText(url, options)
  return JSON.parse(s)
}
