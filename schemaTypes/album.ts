import {defineField, defineType} from 'sanity'

export default defineType({
  name: 'album',
  title: 'Album',
  type: 'document',
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      options: {
        source: 'title',
        maxLength: 96,
      },
    }),
    defineField({
      name: 'photographs',
      title: 'Photographs',
      type: 'array',
      of: [{type: 'reference', to: {type: 'photograph'}}],
    }),
  ],
  preview: {
    select: {
      title: 'title',
    },
  },
})
