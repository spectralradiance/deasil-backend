import {createClient} from '@sanity/client'
import {Client} from '@notionhq/client'
import {NotionToMarkdown} from 'notion-to-md'
import {toPortableText} from 'notion-to-md/to-portable-text'
import dotenv from 'dotenv'

// Load environment variables from .env file
dotenv.config()

// Helper function to extract property values from Notion pages
const getPropertyValue = (page: any, propertyName: string, propertyType: string) => {
  const property = page.properties[propertyName]
  if (!property) return null

  switch (propertyType) {
    case 'title':
      return property.title[0]?.plain_text
    case 'rich_text':
      return property.rich_text[0]?.plain_text
    case 'url':
      return property.url
    case 'formula':
      return property.formula?.string
    case 'files':
      return property.files[0]?.file?.url
    case 'relation':
      if (property.relation.length === 0) return null
      const relations = property.relation.map((r: any) => ({_ref: r.id, _type: 'reference'}))
      return property.type === 'array' ? relations : relations[0]
    case 'people':
      if (property.people.length === 0) return null
      // This assumes you want to link to an 'author' schema in Sanity with the user's ID
      const people = property.people.map((p: any) => ({_ref: p.id, _type: 'reference'}))
      return people.length === 1 ? people[0] : people
    case 'select':
      return property.select?.name
    case 'date':
      return property.date?.start
    case 'number':
      return property.number
    default:
      return null
  }
}

async function syncType(
  type: 'writing' | 'photos',
  notion: Client,
  sanityClient: any,
  n2m: NotionToMarkdown
) {
  console.log(`\nStarting sync for '${type}'...`)

  const isWriting = type === 'writing'
  const databaseId = isWriting
    ? process.env.NOTION_DATABASE_ID_WRITING
    : process.env.NOTION_DATABASE_ID_PHOTOS
  const sanitySchemaType = isWriting ? 'post' : 'photograph'

  if (!databaseId) {
    console.error(`Error: Notion database ID for '${type}' is not set in your .env file.`)
    return // Continue to the next type instead of exiting
  }

  const {results: notionPages} = await notion.dataSources.query({
    data_source_id: databaseId,
    filter: {
      property: 'Status',
      status: {
        equals: 'Published',
      },
    },
  })

  if (notionPages.length === 0) {
    console.log('No new documents with status "Published" found in Notion.')
    return
  }

  console.log(`Found ${notionPages.length} documents to sync.`)

  let created = 0
  let updated = 0

  for (const page of notionPages) {
    // --- Author Upsert Logic ---
    if (isWriting) {
      const authorProperty = page.properties['Author']
      if (authorProperty && authorProperty.people.length > 0) {
        const notionAuthor = authorProperty.people[0]
        const authorDoc = {
          _id: notionAuthor.id, // Use Notion user ID as Sanity document ID
          _type: 'author',
          name: notionAuthor.name,
          // You can add more fields here if your 'author' schema has them
        }

        // Check if author exists, if not, create them.
        const existingAuthor = await sanityClient.fetch(`*[_id == $id][0]`, {id: authorDoc._id})
        if (!existingAuthor) {
          await sanityClient.create(authorDoc, {
            // Use ifNotExists to prevent race conditions if script is run in parallel
            ifNotExists: true,
          })
          console.log(`Created new author: ${authorDoc.name}`)
        }
      }
    }
    // --- End Author Upsert Logic ---

    const notionId = page.id
    const doc: any = {
      _type: sanitySchemaType,
      notionId: notionId,
    }

    if (isWriting) {
      doc.title = getPropertyValue(page, 'Title', 'title')
      doc.description = getPropertyValue(page, 'Description', 'rich_text')
      doc.slug = {current: getPropertyValue(page, 'Path', 'formula')}
      doc.author = getPropertyValue(page, 'Author', 'people')
      const imageUrl = getPropertyValue(page, 'Featured Image', 'url')
      if (imageUrl) {
        try {
          const imageAsset = await sanityClient.assets.upload('image', await (await fetch(imageUrl)).blob())
          doc.mainImage = {
            _type: 'image',
            asset: {
              _type: 'reference',
              _ref: imageAsset._id,
            },
          }
        } catch (err) {
          console.error(`Failed to upload image from URL: ${imageUrl}`, err)
        }
      }
      // This part for categories needs adjustment if you want to create new categories in Sanity
      const categoryName = getPropertyValue(page, 'Category', 'select')
      if (categoryName) {
        // For now, this is just illustrative. You'd need a way to find or create a category ref
        console.log(`Found category: ${categoryName}. Linking logic not yet implemented.`)
      }
      doc.publishedAt = getPropertyValue(page, 'Publish Date', 'date')
      const mdblocks = await n2m.pageToMarkdown(notionId)
      const body = await toPortableText(mdblocks)
      doc.body = body
    } else {
      doc.title = getPropertyValue(page, 'Title', 'title')
      doc.slug = {current: getPropertyValue(page, 'Path', 'formula')}
      const imageUrl = getPropertyValue(page, 'Image', 'url')
      if (imageUrl) {
        doc.image = {
          _type: 'image',
          asset: {_type: 'reference', _ref: imageUrl},
        }
      }
      doc.shutterSpeed = getPropertyValue(page, 'Shutter Speed', 'rich_text')
      doc.aperture = getPropertyValue(page, 'Aperture', 'rich_text')
      doc.focalLength = getPropertyValue(page, 'Focal Length', 'number')
      doc.cameraBody = getPropertyValue(page, 'Camera Body', 'rich_text')
      doc.cameraLens = getPropertyValue(page, 'Camera Lens', 'rich_text')
    }

    const existing = await sanityClient.fetch(
      `*[_type == "${sanitySchemaType}" && notionId == $notionId][0]`,
      {notionId}
    )

    const transaction = sanityClient.transaction()
    if (existing) {
      transaction.patch(existing._id, {set: doc})
      updated++
    } else {
      transaction.create({...doc, _id: `notion-${notionId}`})
      created++
    }
    await transaction.commit()
  }

  console.log(`Sync for '${type}' complete!`)
  console.log(`- ${created} documents created`)
  console.log(`- ${updated} documents updated`)
}

async function syncAll() {
  const notion = new Client({
    auth: process.env.NOTION_SECRET,
  })

  const sanityClient = createClient({
    projectId: process.env.SANITY_PROJECT_ID,
    dataset: process.env.SANITY_DATASET,
    token: process.env.SANITY_API_TOKEN,
    useCdn: false,
    apiVersion: '2021-10-21',
  })

  const n2m = new NotionToMarkdown({notionClient: notion})

  try {
    await syncType('writing', notion, sanityClient, n2m)
    await syncType('photos', notion, sanityClient, n2m)

    console.log('\n✅ All sync operations complete!')
  } catch (error: any) {
    console.error('\n❌ Error during sync:')
    console.error(error)
    process.exit(1)
  }
}

syncAll()
