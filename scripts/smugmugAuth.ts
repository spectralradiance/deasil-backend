/**
 * SmugMug OAuth 1.0a token helper
 *
 * Runs the full OAuth handshake from Node.js, bypassing browser CORS restrictions.
 *
 * Usage:
 *   npx ts-node scripts/smugmugAuth.ts
 *
 * Reads VITE_SMUGMUG_API_KEY and VITE_SMUGMUG_API_SECRET from .env if present.
 * Prints your access token and secret at the end — paste them into the
 * Configure tab of the SmugMug Sync tool (or add to your .env).
 */

import {createInterface} from 'readline/promises'
import {webcrypto} from 'crypto'
import dotenv from 'dotenv'

dotenv.config()

const OAUTH_BASE = 'https://api.smugmug.com/services/oauth/1.0a'

async function hmacSha1(signingKey: string, data: string): Promise<string> {
  const encoder = new TextEncoder()
  const cryptoKey = await webcrypto.subtle.importKey(
    'raw',
    encoder.encode(signingKey),
    {name: 'HMAC', hash: {name: 'SHA-1'}},
    false,
    ['sign'],
  )
  const sig = await webcrypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data))
  return Buffer.from(sig).toString('base64')
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

  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`)
    .join('&')

  const signatureBase = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(paramString)].join('&')
  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret ?? '')}`
  oauthParams.oauth_signature = await hmacSha1(signingKey, signatureBase)

  return (
    'OAuth ' +
    Object.keys(oauthParams)
      .map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
      .join(', ')
  )
}

function parseOAuthResponse(text: string): Record<string, string> {
  return Object.fromEntries(text.split('&').map((pair) => pair.split('=').map(decodeURIComponent)))
}

async function prompt(rl: Awaited<ReturnType<typeof createInterface>>, question: string): Promise<string> {
  return rl.question(question)
}

async function main() {
  const rl = createInterface({input: process.stdin, output: process.stdout})

  try {
    const apiKey =
      process.env.VITE_SMUGMUG_API_KEY || (await prompt(rl, 'SmugMug API Key: '))
    const apiSecret =
      process.env.VITE_SMUGMUG_API_SECRET || (await prompt(rl, 'SmugMug API Secret: '))

    // Step 1 — get request token
    console.log('\nRequesting token from SmugMug...')
    const requestTokenUrl = `${OAUTH_BASE}/getRequestToken`
    const requestHeader = await buildAuthHeader('POST', requestTokenUrl, apiKey, apiSecret, undefined, undefined, {
      oauth_callback: 'oob',
    })

    const tokenResp = await fetch(requestTokenUrl, {
      method: 'POST',
      headers: {Authorization: requestHeader, Accept: 'application/json'},
    })

    if (!tokenResp.ok) {
      throw new Error(`getRequestToken failed: ${tokenResp.status} ${await tokenResp.text()}`)
    }

    const tokenData = parseOAuthResponse(await tokenResp.text())
    const requestToken = tokenData.oauth_token
    const requestTokenSecret = tokenData.oauth_token_secret

    // Step 2 — direct user to authorize
    const authorizeUrl = `${OAUTH_BASE}/authorize?oauth_token=${requestToken}&Access=Full&Permissions=Modify`
    console.log(`\nOpen this URL in your browser to authorize the app:\n\n  ${authorizeUrl}\n`)

    const verifier = (await prompt(rl, 'Paste the 6-digit PIN from SmugMug: ')).trim()

    // Step 3 — exchange for access token
    console.log('\nExchanging PIN for access token...')
    const accessTokenUrl = `${OAUTH_BASE}/getAccessToken`
    const accessHeader = await buildAuthHeader(
      'GET',
      accessTokenUrl,
      apiKey,
      apiSecret,
      requestToken,
      requestTokenSecret,
      {oauth_verifier: verifier},
    )

    const accessResp = await fetch(accessTokenUrl, {
      headers: {Authorization: accessHeader, Accept: 'application/json'},
    })

    if (!accessResp.ok) {
      throw new Error(`getAccessToken failed: ${accessResp.status} ${await accessResp.text()}`)
    }

    const accessData = parseOAuthResponse(await accessResp.text())

    console.log('\n=== Your SmugMug Access Tokens ===')
    console.log(`VITE_SMUGMUG_ACCESS_TOKEN=${accessData.oauth_token}`)
    console.log(`VITE_SMUGMUG_ACCESS_TOKEN_SECRET=${accessData.oauth_token_secret}`)
    console.log('\nPaste these into your .env file or into the Configure tab of the SmugMug Sync tool.')
  } finally {
    rl.close()
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
