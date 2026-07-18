import {defineConfig} from 'sanity'
import {deskTool} from 'sanity/desk'
import {visionTool} from '@sanity/vision'
import {schemaTypes} from './schemaTypes'
import {syncSmugmug} from './plugins/sync-smugmug/src'
import {notionSync} from './plugins/sync-notion/src'

export default defineConfig({
  name: 'default',
  title: 'deasil-sanity',

  projectId: 'ijvdggci',
  dataset: 'production',

  plugins: [deskTool(), visionTool(), syncSmugmug(), notionSync()],

  schema: {
    types: schemaTypes,
  },
})