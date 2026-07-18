import {definePlugin} from 'sanity'
import {SyncTool} from './SyncTool'

export const syncSmugmug = definePlugin({
  name: 'sanity-plugin-sync-smugmug',
  tools: [
    {
      name: 'sync-smugmug',
      title: 'Sync SmugMug',
      component: SyncTool,
    },
  ],
})