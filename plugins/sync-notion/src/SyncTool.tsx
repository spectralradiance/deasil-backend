import React from 'react'
import {Card, Box, Heading, Text, Code} from '@sanity/ui'

const SyncTool = () => {
  return (
    <Card padding={4} tone="default">
      <Box marginBottom={4}>
        <Heading as="h2">Notion Sync</Heading>
        <Text>
          To sync all content from your Notion databases, run the following command in your
          terminal:
        </Text>
      </Box>
      <Box>
        <Card padding={3} marginTop={2} radius={2} shadow={1} style={{backgroundColor: '#f3f4f6'}}>
          <Code language="bash">npx sanity exec scripts/syncNotion.ts</Code>
        </Card>
      </Box>
    </Card>
  )
}

export default SyncTool
