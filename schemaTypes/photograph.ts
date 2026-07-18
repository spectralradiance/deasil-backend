import {defineField, defineType} from 'sanity'

export default defineType({
  name: 'photograph',
  title: 'Photograph',
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
        source: 'name',
        maxLength: 96,
      },
    }),
    defineField({
      name: 'image',
      title: 'Image',
      type: 'image',
      options: {
        hotspot: true,
      },
    }),
    defineField({
      name: 'shutterSpeed',
      title: 'Shutter Speed',
      type: 'string',
    }),
    defineField({
      name: 'aperture',
      title: 'Aperture',
      type: 'string',
    }),
    defineField({
      name: 'focalLength',
      title: 'Focal Length',
      type: 'number',
    }),
    defineField({
      name: 'cameraBody',
      title: 'Camera Body',
      type: 'string',
    }),
    defineField({
      name: 'cameraLens',
      title: 'Camera Lens',
      type: 'string',
    }),
    defineField({
      name: 'captureDateTime',
      title: 'Capture Date & Time',
      type: 'datetime',
    }),
    defineField({
      name: 'sourceUrl',
      title: 'Source URL',
      type: 'url',
      description: 'External image URL (e.g. from SmugMug)',
      hidden: true,
    }),
    defineField({
      name: 'notionId',
      title: 'Notion ID',
      type: 'string',
      hidden: true,
    }),
  ],
  preview: {
    select: {
      title: 'title',
      media: 'image',
    },
  },
})
