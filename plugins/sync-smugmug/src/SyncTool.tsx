import React, {useCallback, useEffect, useState} from 'react'
import {useClient} from 'sanity'
import {SmugMugClient, SmugMugCredentials, SmugMugMetadata} from './smugmugApi'

const STORAGE_KEY = 'smugmug_credentials'

function loadCredentials(): Partial<SmugMugCredentials> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function saveCredentials(creds: Partial<SmugMugCredentials>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(creds))
}

type Step = 'configure' | 'authorize' | 'sync'

interface SyncResult {
  albumName: string
  status: 'pending' | 'syncing' | 'done' | 'error'
  message?: string
}

export function SyncTool() {
  const client = useClient({apiVersion: '2024-01-01'})

  // Credentials state — API key/secret seeded from .env (VITE_ prefix) if available
  const envApiKey = (import.meta as any).env?.VITE_SMUGMUG_API_KEY ?? ''
  const envApiSecret = (import.meta as any).env?.VITE_SMUGMUG_API_SECRET ?? ''
  const envUser = (import.meta as any).env?.VITE_SMUGMUG_USER ?? ''

  const [apiKey, setApiKey] = useState(envApiKey)
  const [apiSecret, setApiSecret] = useState(envApiSecret)
  const [accessToken, setAccessToken] = useState('')
  const [accessTokenSecret, setAccessTokenSecret] = useState('')
  const [username, setUsername] = useState(envUser)

  // OAuth flow state
  const [step, setStep] = useState<Step>('configure')
  const [requestToken, setRequestToken] = useState('')
  const [requestTokenSecret, setRequestTokenSecret] = useState('')
  const [authorizeUrl, setAuthorizeUrl] = useState('')
  const [verifier, setVerifier] = useState('')

  // Sync state
  const [syncResults, setSyncResults] = useState<SyncResult[]>([])
  const [isSyncing, setIsSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  // Load saved credentials on mount
  useEffect(() => {
    const saved = loadCredentials()
    if (saved.apiKey) setApiKey(saved.apiKey)
    if (saved.apiSecret) setApiSecret(saved.apiSecret)
    if (saved.accessToken) setAccessToken(saved.accessToken)
    if (saved.accessTokenSecret) setAccessTokenSecret(saved.accessTokenSecret)
    if ((saved as any).username) setUsername((saved as any).username)
    if (saved.accessToken && saved.accessTokenSecret) setStep('sync')
  }, [])

  const handleSaveConfig = useCallback(() => {
    saveCredentials({apiKey, apiSecret, accessToken, accessTokenSecret, ...(username ? {username} : {})} as any)
    if (accessToken && accessTokenSecret) {
      setStep('sync')
    } else {
      setStep('authorize')
    }
    setError(null)
    setStatus('Configuration saved.')
  }, [apiKey, apiSecret, accessToken, accessTokenSecret, username])

  const handleGetRequestToken = useCallback(async () => {
    setError(null)
    setStatus('Getting request token from SmugMug...')
    try {
      const smugmug = new SmugMugClient({apiKey, apiSecret, accessToken: '', accessTokenSecret: ''})
      const result = await smugmug.getRequestToken()
      setRequestToken(result.token)
      setRequestTokenSecret(result.tokenSecret)
      setAuthorizeUrl(result.authorizeUrl)
      setStatus('Request token obtained. Click the link below to authorize.')
    } catch (err: any) {
      setError(`Could not get request token: ${err.message}. SmugMug's OAuth endpoints block browser requests (CORS). Run "npx ts-node scripts/smugmugAuth.ts" from the project root to get your tokens, then paste them into the Configure tab.`)
      setStatus(null)
    }
  }, [apiKey, apiSecret])

  const handleGetAccessToken = useCallback(async () => {
    setError(null)
    setStatus('Exchanging verifier for access token...')
    try {
      const smugmug = new SmugMugClient({apiKey, apiSecret, accessToken: '', accessTokenSecret: ''})
      const result = await smugmug.getAccessToken(requestToken, requestTokenSecret, verifier.trim())
      setAccessToken(result.accessToken)
      setAccessTokenSecret(result.accessTokenSecret)
      saveCredentials({apiKey, apiSecret, accessToken: result.accessToken, accessTokenSecret: result.accessTokenSecret, ...(username ? {username} : {})} as any)
      setStep('sync')
      setStatus('Authentication complete! You can now sync your albums.')
    } catch (err: any) {
      setError(`Could not exchange verifier: ${err.message}`)
      setStatus(null)
    }
  }, [apiKey, apiSecret, requestToken, requestTokenSecret, verifier, username])

  const handleSync = useCallback(async () => {
    if (!username.trim()) {
      setError('Please enter your SmugMug username in the Configure tab.')
      return
    }
    setError(null)
    setIsSyncing(true)
    setStatus('Fetching albums from SmugMug...')

    const smugmug = new SmugMugClient({apiKey, apiSecret, accessToken, accessTokenSecret})

    try {
      const albums = await smugmug.getAlbums(username)
      setSyncResults(albums.map((a) => ({albumName: a.Name, status: 'pending'})))
      setStatus(`Found ${albums.length} album(s). Starting sync...`)

      for (let i = 0; i < albums.length; i++) {
        const album = albums[i]
        setSyncResults((prev) => prev.map((r, idx) => (idx === i ? {...r, status: 'syncing'} : r)))

        try {
          const photos = await smugmug.getAlbumImages(album.Uris.AlbumImages.Uri)
          const photoReferences: {_type: string; _ref: string; _key: string}[] = []

          for (const photo of photos) {
            const imageDetails = await smugmug.getImageDetails(photo.Uris.Image.Uri)

            // Fetch metadata via the versioned image URI (e.g. /api/v2/image/jPPKD2c-1)
            let metadata: SmugMugMetadata = {}
            metadata = await smugmug.getImageMetadata(photo.Uris.Image.Uri)

            // Prefer Title, then FileName without extension, then ImageKey
            const rawName = photo.Title || imageDetails.Title || photo.FileName || ''
            const title = rawName.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').trim() || photo.ImageKey

            // DateTimeOriginal is already ISO 8601 on the Image response
            const captureDateTime = imageDetails.DateTimeOriginal || undefined

            const sanityPhoto: Record<string, any> = {
              _type: 'photograph',
              _id: `smugmug-photo-${photo.ImageKey}`,
              title,
              slug: {_type: 'slug', current: photo.ImageKey},
              sourceUrl: imageDetails.ArchivedUri,
            }
            if (metadata.Aperture) sanityPhoto.aperture = `f/${metadata.Aperture}`
            if (metadata.Exposure) sanityPhoto.shutterSpeed = metadata.Exposure
            if (metadata.FocalLength) {
              const fl = parseFloat(metadata.FocalLength)
              if (!isNaN(fl)) sanityPhoto.focalLength = fl
            }
            if (metadata.Model) sanityPhoto.cameraBody = [metadata.Make, metadata.Model].filter(Boolean).join(' ')
            if (metadata.Lens) sanityPhoto.cameraLens = metadata.Lens
            if (captureDateTime) sanityPhoto.captureDateTime = captureDateTime

            await client.createOrReplace(sanityPhoto)
            photoReferences.push({_type: 'reference', _ref: sanityPhoto._id, _key: sanityPhoto._id})
          }

          const sanityAlbum = {
            _type: 'album',
            _id: `smugmug-album-${album.AlbumKey}`,
            title: album.Name,
            slug: {_type: 'slug', current: album.UrlPath.replace(/^\//, '') || album.AlbumKey},
            photographs: photoReferences,
          }

          await client.createOrReplace(sanityAlbum)
          setSyncResults((prev) =>
            prev.map((r, idx) => (idx === i ? {...r, status: 'done', message: `${photos.length} photo(s) synced`} : r)),
          )
        } catch (err: any) {
          setSyncResults((prev) =>
            prev.map((r, idx) => (idx === i ? {...r, status: 'error', message: err.message} : r)),
          )
        }
      }

      setStatus('Sync complete!')
    } catch (err: any) {
      setError(`Sync failed: ${err.message}`)
    } finally {
      setIsSyncing(false)
    }
  }, [client, apiKey, apiSecret, accessToken, accessTokenSecret, username])

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '8px 16px',
    cursor: 'pointer',
    borderBottom: active ? '2px solid #0066cc' : '2px solid transparent',
    fontWeight: active ? 600 : 400,
    background: 'none',
    border: 'none',
    borderBottom: active ? '2px solid #0066cc' : '2px solid transparent',
    fontSize: 14,
  })

  return (
    <div style={{padding: 24, maxWidth: 720, fontFamily: 'sans-serif'}}>
      <h2 style={{marginTop: 0}}>SmugMug Sync</h2>

      {/* Tabs */}
      <div style={{display: 'flex', gap: 8, borderBottom: '1px solid #ddd', marginBottom: 24}}>
        <button style={tabStyle(step === 'configure')} onClick={() => setStep('configure')}>
          1. Configure
        </button>
        <button style={tabStyle(step === 'authorize')} onClick={() => setStep('authorize')}>
          2. Authorize
        </button>
        <button style={tabStyle(step === 'sync')} onClick={() => setStep('sync')} disabled={!accessToken}>
          3. Sync
        </button>
      </div>

      {error && (
        <div style={{background: '#fff3f3', border: '1px solid #f00', borderRadius: 4, padding: 12, marginBottom: 16, color: '#c00'}}>
          {error}
        </div>
      )}
      {status && !error && (
        <div style={{background: '#f0f8ff', border: '1px solid #0066cc', borderRadius: 4, padding: 12, marginBottom: 16, color: '#004499'}}>
          {status}
        </div>
      )}

      {/* Step 1: Configure */}
      {step === 'configure' && (
        <div>
          <p style={{color: '#666', marginTop: 0}}>
            Enter your SmugMug API credentials. You can get these from{' '}
            <a href="https://api.smugmug.com/api/developer/apply" target="_blank" rel="noreferrer">
              api.smugmug.com
            </a>
            . If you already have access tokens, enter them here to skip the authorization step.
            {(envApiKey || envApiSecret || envUser) && (
              <span style={{display: 'block', marginTop: 8, color: '#088'}}>
                ✓ API credentials loaded from <code>.env</code> (VITE_SMUGMUG_* variables).
              </span>
            )}
          </p>
          {[
            ...(!envApiKey ? [{label: 'API Key', value: apiKey, setter: setApiKey, placeholder: 'Your SmugMug API key'}] : []),
            ...(!envApiSecret ? [{label: 'API Secret', value: apiSecret, setter: setApiSecret, placeholder: 'Your SmugMug API secret'}] : []),
            {label: 'Access Token (optional)', value: accessToken, setter: setAccessToken, placeholder: 'Leave blank to use OAuth flow'},
            {label: 'Access Token Secret (optional)', value: accessTokenSecret, setter: setAccessTokenSecret, placeholder: 'Leave blank to use OAuth flow'},
            ...(!envUser ? [{label: 'SmugMug Username', value: username, setter: setUsername, placeholder: 'e.g. cmacmillanmarin'}] : []),
          ].map(({label, value, setter, placeholder}) => (
            <div key={label} style={{marginBottom: 16}}>
              <label style={{display: 'block', fontWeight: 600, marginBottom: 4}}>
                {label}
              </label>
              <input
                type={label.includes('Secret') || label.includes('Token') ? 'password' : 'text'}
                value={value}
                onChange={(e) => setter(e.target.value)}
                placeholder={placeholder}
                style={{width: '100%', padding: '8px 12px', boxSizing: 'border-box', border: '1px solid #ccc', borderRadius: 4}}
              />
            </div>
          ))}
          <button
            onClick={handleSaveConfig}
            disabled={!apiKey || !apiSecret}
            style={{padding: '10px 20px', background: '#0066cc', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600}}
          >
            Save &amp; Continue →
          </button>
        </div>
      )}

      {/* Step 2: Authorize */}
      {step === 'authorize' && (
        <div>
          <p style={{color: '#666', marginTop: 0}}>
            Authorize this application to access your SmugMug account.
          </p>
          <button
            onClick={handleGetRequestToken}
            style={{padding: '10px 20px', background: '#0066cc', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', marginBottom: 16}}
          >
            Get Authorization URL
          </button>

          {authorizeUrl && (
            <div style={{marginBottom: 16}}>
              <p>
                <strong>Step 1:</strong> Open the link below and authorize the application:
              </p>
              <a href={authorizeUrl} target="_blank" rel="noreferrer" style={{wordBreak: 'break-all'}}>
                {authorizeUrl}
              </a>
              <p>
                <strong>Step 2:</strong> Enter the 6-digit verifier code from SmugMug:
              </p>
              <input
                type="text"
                value={verifier}
                onChange={(e) => setVerifier(e.target.value)}
                placeholder="Enter verifier code"
                style={{padding: '8px 12px', border: '1px solid #ccc', borderRadius: 4, marginRight: 8, width: 200}}
              />
              <button
                onClick={handleGetAccessToken}
                disabled={!verifier.trim()}
                style={{padding: '8px 16px', background: '#0066cc', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer'}}
              >
                Complete Authorization
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step 3: Sync */}
      {step === 'sync' && (
        <div>
          <p style={{color: '#666', marginTop: 0}}>
            Sync albums and photos from SmugMug user <strong>{username}</strong> into Sanity.
          </p>
          <button
            onClick={handleSync}
            disabled={isSyncing}
            style={{padding: '10px 20px', background: isSyncing ? '#999' : '#0a7c3e', color: '#fff', border: 'none', borderRadius: 4, cursor: isSyncing ? 'not-allowed' : 'pointer', fontWeight: 600, marginBottom: 24}}
          >
            {isSyncing ? 'Syncing…' : 'Start Sync'}
          </button>

          {syncResults.length > 0 && (
            <table style={{width: '100%', borderCollapse: 'collapse'}}>
              <thead>
                <tr style={{background: '#f5f5f5'}}>
                  <th style={{textAlign: 'left', padding: '8px 12px', border: '1px solid #ddd'}}>Album</th>
                  <th style={{textAlign: 'left', padding: '8px 12px', border: '1px solid #ddd'}}>Status</th>
                </tr>
              </thead>
              <tbody>
                {syncResults.map((r) => (
                  <tr key={r.albumName}>
                    <td style={{padding: '8px 12px', border: '1px solid #ddd'}}>{r.albumName}</td>
                    <td style={{padding: '8px 12px', border: '1px solid #ddd'}}>
                      {r.status === 'pending' && '⏳ Pending'}
                      {r.status === 'syncing' && '🔄 Syncing…'}
                      {r.status === 'done' && `✅ ${r.message}`}
                      {r.status === 'error' && `❌ ${r.message}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
