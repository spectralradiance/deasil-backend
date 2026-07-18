/**
 * SmugMug full sync (Node.js)
 *
 * Downloads image files from SmugMug and uploads them as Sanity assets,
 * including EXIF metadata. Use this instead of the browser sync to get
 * actual image files (the browser is blocked by CDN CORS restrictions).
 *
 * Usage:
 *   npm run smugmug-sync
 *
 * Required .env vars:
 *   VITE_SMUGMUG_API_KEY
 *   VITE_SMUGMUG_API_SECRET
 *   VITE_SMUGMUG_ACCESS_TOKEN        (from: npm run smugmug-auth)
 *   VITE_SMUGMUG_ACCESS_TOKEN_SECRET (from: npm run smugmug-auth)
 *   VITE_SMUGMUG_USER
 *   SANITY_TOKEN                     (write token from manage.sanity.io → API → Tokens)
 */

import {createClient} from '@sanity/client'
import {webcrypto} from 'crypto'
import dotenv from 'dotenv'

dotenv.config()

// ── OAuth 1.0a helpers ───────────────────────────────────────────────────────

function rfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

async function hmacSha1(signingKey: string, data: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await webcrypto.subtle.importKey('raw', enc.encode(signingKey), {name: 'HMAC', hash: 'SHA-1'}, false, ['sign'])
  return Buffer.from(await webcrypto.subtle.sign('HMAC', key, enc.encode(data))).toString('base64')
}

async function buildAuthHeader(
  method: string,
  url: string,
  consumerKey: string,
  consumerSecret: string,
  token: string,
  tokenSecret: string,
): Promise<string> {
  const p: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: Math.random().toString(36).slice(2) + Date.now().toString(36),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: '1.0',
  }

  const paramStr = Object.keys(p).sort().map((k) => `${rfc3986(k)}=${rfc3986(p[k])}`).join('&')
  const base = [method.toUpperCase(), rfc3986(url), rfc3986(paramStr)].join('&')
  p.oauth_signature = await hmacSha1(`${rfc3986(consumerSecret)}&${rfc3986(tokenSecret)}`, base)

  return 'OAuth ' + Object.keys(p).map((k) => `${rfc3986(k)}="${rfc3986(p[k])}"`).join(', ')
}

// ── SmugMug API ──────────────────────────────────────────────────────────────

const API_BASE = 'https://api.smugmug.com'

interface Creds {apiKey: string; apiSecret: string; accessToken: string; accessTokenSecret: string}

async function apiGet(path: string, creds: Creds): Promise<any> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  const auth = await buildAuthHeader('GET', url, creds.apiKey, creds.apiSecret, creds.accessToken, creds.accessTokenSecret)
  const resp = await fetch(url, {headers: {Authorization: auth, Accept: 'application/json'}})
  if (!resp.ok) throw new Error(`SmugMug ${resp.status}: ${await resp.text()}`)
  return (await resp.json()).Response
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function titleFromFileName(name?: string): string {
  return name ? name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() : ''
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const required: Record<string, string | undefined> = {
    VITE_SMUGMUG_API_KEY: process.env.VITE_SMUGMUG_API_KEY,
    VITE_SMUGMUG_API_SECRET: process.env.VITE_SMUGMUG_API_SECRET,
    VITE_SMUGMUG_ACCESS_TOKEN: process.env.VITE_SMUGMUG_ACCESS_TOKEN,
    VITE_SMUGMUG_ACCESS_TOKEN_SECRET: process.env.VITE_SMUGMUG_ACCESS_TOKEN_SECRET,
    VITE_SMUGMUG_USER: process.env.VITE_SMUGMUG_USER,
    SANITY_TOKEN: process.env.SANITY_TOKEN,
  }
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`)

  const creds: Creds = {
    apiKey: process.env.VITE_SMUGMUG_API_KEY!,
    apiSecret: process.env.VITE_SMUGMUG_API_SECRET!,
    accessToken: process.env.VITE_SMUGMUG_ACCESS_TOKEN!,
    accessTokenSecret: process.env.VITE_SMUGMUG_ACCESS_TOKEN_SECRET!,
  }
  const username = process.env.VITE_SMUGMUG_USER!

  const sanity = createClient({
    projectId: 'ijvdggci',
    dataset: 'production',
    apiVersion: '2024-01-01',
    token: process.env.SANITY_TOKEN,
    useCdn: false,
  })

  console.log(`Fetching albums for ${username}...`)
  const albumsData = await apiGet(`/api/v2/user/${username}!albums`, creds)
  const albums: any[] = albumsData.Album ?? []
  console.log(`Found ${albums.length} album(s)\n`)

  for (const album of albums) {
    console.log(`Album: ${album.Name}`)

    const photosData = await apiGet(album.Uris.AlbumImages.Uri, creds)
    const photos: any[] = photosData.AlbumImage ?? []
    if (photos.length === 0) {
      console.log('  (empty)\n')
      continue
    }
    console.log(`  ${photos.length} photo(s)`)

    const photoRefs: {_type: string; _ref: string; _key: string}[] = []

    for (const photo of photos) {
      const label = photo.Title || photo.FileName || photo.ImageKey
      try {
        // Image details (includes EXIF URI)
        const imageData = await apiGet(photo.Uris.Image.Uri, creds)
        const image = imageData.Image

        // Metadata via versioned image URI (e.g. /api/v2/image/jPPKD2c-1!metadata)
        let meta: any = {}
        try {
          const metaData = await apiGet(`${photo.Uris.Image.Uri}!metadata`, creds)
          meta = metaData.ImageMetadata ?? {}
        } catch {/* no metadata available */}

        // Human-readable title
        const title =
          (photo.Title || image.Title || titleFromFileName(image.FileName || photo.FileName) || photo.ImageKey)

        // Download image binary (no CORS in Node.js)
        const imgResp = await fetch(image.ArchivedUri)
        if (!imgResp.ok) throw new Error(`Download failed: ${imgResp.status}`)
        const imgBuffer = Buffer.from(await imgResp.arrayBuffer())

        // Upload to Sanity
        const asset = await sanity.assets.upload('image', imgBuffer, {
          filename: image.FileName || `${photo.ImageKey}.jpg`,
        })

        // Build document
        const doc: Record<string, any> = {
          _type: 'photograph',
          _id: `smugmug-photo-${photo.ImageKey}`,
          title,
          slug: {_type: 'slug', current: photo.ImageKey},
          image: {_type: 'image', asset: {_type: 'reference', _ref: asset._id}},
          sourceUrl: image.ArchivedUri,
        }
        if (meta.Aperture) doc.aperture = `f/${meta.Aperture}`
        if (meta.Exposure) doc.shutterSpeed = meta.Exposure
        if (meta.FocalLength) {
          const fl = parseFloat(meta.FocalLength)
          if (!isNaN(fl)) doc.focalLength = fl
        }
        if (meta.Model) doc.cameraBody = [meta.Make, meta.Model].filter(Boolean).join(' ')
        if (meta.Lens) doc.cameraLens = meta.Lens
        if (image.DateTimeOriginal) doc.captureDateTime = image.DateTimeOriginal

        await sanity.createOrReplace(doc)
        photoRefs.push({_type: 'reference', _ref: doc._id, _key: doc._id})
        console.log(`  ✓ ${title}`)
      } catch (err: any) {
        console.error(`  ✗ ${label}: ${err.message}`)
      }
    }

    await sanity.createOrReplace({
      _type: 'album',
      _id: `smugmug-album-${album.AlbumKey}`,
      title: album.Name,
      slug: {_type: 'slug', current: album.UrlPath.replace(/^\//, '') || album.AlbumKey},
      photographs: photoRefs,
    })
    console.log(`  Album saved.\n`)
  }

  console.log('Sync complete!')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
