// OAuth 1.0a implementation using the browser's Web Crypto API

async function hmacSha1(signingKey: string, data: string): Promise<string> {
  const encoder = new TextEncoder()
  const keyBytes = encoder.encode(signingKey)
  const dataBytes = encoder.encode(data)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    {name: 'HMAC', hash: {name: 'SHA-1'}},
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataBytes)
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
}

async function buildAuthHeader(
  method: string,
  url: string,
  consumerKey: string,
  consumerSecret: string,
  token?: string,
  tokenSecret?: string,
  extraParams: Record<string, string> = {},
): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: Math.random().toString(36).slice(2) + Date.now().toString(36),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
    ...extraParams,
  }
  if (token) oauthParams.oauth_token = token

  const allParams = {...oauthParams}
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(allParams[k])}`)
    .join('&')

  const signatureBase = [method.toUpperCase(), rfc3986(url), rfc3986(paramString)].join('&')

  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret ?? '')}`
  oauthParams.oauth_signature = await hmacSha1(signingKey, signatureBase)

  return (
    'OAuth ' +
    Object.keys(oauthParams)
      .map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
      .join(', ')
  )
}

// encodeURIComponent leaves !'()* unencoded; OAuth 1.0a requires strict RFC 3986
function rfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function parseOAuthResponse(text: string): Record<string, string> {
  return Object.fromEntries(text.split('&').map((pair) => pair.split('=').map(decodeURIComponent)))
}

export interface SmugMugCredentials {
  apiKey: string
  apiSecret: string
  accessToken: string
  accessTokenSecret: string
}

export interface SmugMugAlbum {
  AlbumKey: string
  Name: string
  UrlPath: string
  Uris: {AlbumImages: {Uri: string}}
}

export interface SmugMugMetadata {
  Aperture?: number       // e.g. 2.8
  Exposure?: string       // shutter speed, e.g. "1/250"
  FocalLength?: string    // e.g. "115.0 mm"
  ISO?: number
  Make?: string
  Model?: string
  Lens?: string           // lens model
  DateTimeCreated?: string
}

export interface SmugMugPhoto {
  ImageKey: string
  Title: string
  FileName?: string
  Uris: {Image: {Uri: string}}
}

export interface SmugMugImage {
  ArchivedUri: string
  FileName: string
  Title?: string
  DateTimeOriginal?: string
  Uris?: {ImageExif?: {Uri: string}}
}

export class SmugMugClient {
  private readonly BASE = 'https://api.smugmug.com'
  private readonly OAUTH_BASE = 'https://api.smugmug.com/services/oauth/1.0a'

  constructor(private creds: SmugMugCredentials) {}

  // Step 1: Get a request token (signed POST)
  async getRequestToken(): Promise<{token: string; tokenSecret: string; authorizeUrl: string}> {
    const url = `${this.OAUTH_BASE}/getRequestToken`
    const authHeader = await buildAuthHeader('POST', url, this.creds.apiKey, this.creds.apiSecret, undefined, undefined, {
      oauth_callback: 'oob',
    })

    const resp = await fetch(url, {
      method: 'POST',
      headers: {Authorization: authHeader, Accept: 'application/json'},
    })

    if (!resp.ok) throw new Error(`Failed to get request token: ${resp.status} ${await resp.text()}`)

    const parsed = parseOAuthResponse(await resp.text())
    const token = parsed.oauth_token
    const tokenSecret = parsed.oauth_token_secret
    const authorizeUrl = `${this.OAUTH_BASE}/authorize?oauth_token=${token}&Access=Full&Permissions=Modify`
    return {token, tokenSecret, authorizeUrl}
  }

  // Step 3: Exchange request token + verifier for access token
  async getAccessToken(
    requestToken: string,
    requestTokenSecret: string,
    verifier: string,
  ): Promise<{accessToken: string; accessTokenSecret: string}> {
    const url = `${this.OAUTH_BASE}/getAccessToken`
    const authHeader = await buildAuthHeader(
      'GET',
      url,
      this.creds.apiKey,
      this.creds.apiSecret,
      requestToken,
      requestTokenSecret,
      {oauth_verifier: verifier},
    )

    const resp = await fetch(url, {
      headers: {Authorization: authHeader, Accept: 'application/json'},
    })

    if (!resp.ok) throw new Error(`Failed to get access token: ${resp.status} ${await resp.text()}`)

    const parsed = parseOAuthResponse(await resp.text())
    return {
      accessToken: parsed.oauth_token,
      accessTokenSecret: parsed.oauth_token_secret,
    }
  }

  // Generic signed GET request to the SmugMug API v2
  async get(path: string): Promise<any> {
    const url = path.startsWith('http') ? path : `${this.BASE}${path}`
    const authHeader = await buildAuthHeader(
      'GET',
      url,
      this.creds.apiKey,
      this.creds.apiSecret,
      this.creds.accessToken,
      this.creds.accessTokenSecret,
    )

    const resp = await fetch(url, {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    })

    if (!resp.ok) throw new Error(`SmugMug API error: ${resp.status} ${await resp.text()}`)

    const json = await resp.json()
    return json.Response
  }

  async getAlbums(username: string): Promise<SmugMugAlbum[]> {
    const data = await this.get(`/api/v2/user/${username}!albums`)
    return data.Album ?? []
  }

  async getAlbumImages(albumImagesUri: string): Promise<SmugMugPhoto[]> {
    const data = await this.get(albumImagesUri)
    return data.AlbumImage ?? []
  }

  async getImageDetails(imageUri: string): Promise<SmugMugImage> {
    const data = await this.get(imageUri)
    return data.Image
  }

  async getImageMetadata(imageUri: string): Promise<SmugMugMetadata> {
    try {
      const data = await this.get(`${imageUri}!metadata`)
      return data.ImageMetadata ?? {}
    } catch {
      return {}
    }
  }
}
