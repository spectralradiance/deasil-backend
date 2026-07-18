import {definePlugin, Tool} from 'sanity'
import {SyncIcon} from '@sanity/icons'
import SyncTool from './SyncTool'

export const notionSync = definePlugin({
  name: 'notion-sync',
  title: 'Notion Sync',

  tools: (prev: Tool[]): Tool[] => {
    return [
      ...prev,
      {
        name: 'notion-sync',
        title: 'Notion Sync',
        component: SyncTool,
        icon: SyncIcon,
      },
    ]
  },
})
