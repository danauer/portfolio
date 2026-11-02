import { config, collection, singleton, fields } from '@keystatic/core';

// Shared field builders ------------------------------------------------------

const tags = fields.multiRelationship({
  label: 'Tags',
  collection: 'tags',
});

const credits = fields.array(
  fields.object({
    person: fields.relationship({
      label: 'Person',
      collection: 'people',
      validation: { isRequired: true },
    }),
    role: fields.text({ label: 'Role', description: 'e.g. "Research lead", "Developer", "Model"' }),
  }),
  {
    label: 'Credits',
    description: 'People who contributed, and what they did.',
    itemLabel: (props) => {
      const person = props.fields.person.value ?? 'Unassigned';
      const role = props.fields.role.value;
      return role ? `${person} — ${role}` : person;
    },
  },
);

const projectImageDir = {
  directory: 'src/assets/images/projects',
  publicPath: '../../assets/images/projects/',
};

// Config ---------------------------------------------------------------------

export default config({
  storage: { kind: 'local' },

  ui: {
    brand: { name: 'Portfolio' },
    navigation: {
      Work: ['projects'],
      Photography: ['photos', 'photoGroups'],
      Career: ['positions', 'organizations'],
      Reference: ['people', 'tags'],
      Site: ['settings'],
    },
  },

  collections: {
    projects: collection({
      label: 'Projects',
      slugField: 'title',
      path: 'src/content/projects/*',
      format: { contentField: 'body' },
      entryLayout: 'content',
      columns: ['title', 'discipline', 'status'],
      schema: {
        title: fields.slug({ name: { label: 'Title' } }),
        discipline: fields.select({
          label: 'Discipline',
          description: 'Which section of the site this appears in.',
          options: [
            { label: 'UX design', value: 'ux' },
            { label: 'Visual design', value: 'visual' },
            { label: 'Art', value: 'art' },
          ],
          defaultValue: 'ux',
        }),
        status: fields.select({
          label: 'Status',
          description: 'Drafts are visible in local dev only — never on the published site.',
          options: [
            { label: 'Draft', value: 'draft' },
            { label: 'Published', value: 'published' },
          ],
          defaultValue: 'draft',
        }),
        featured: fields.checkbox({ label: 'Feature on home page' }),
        summary: fields.text({
          label: 'Summary',
          description: 'One or two sentences shown on cards and at the top of the page.',
          multiline: true,
        }),
        cover: fields.image({ label: 'Cover image', ...projectImageDir }),
        coverAlt: fields.text({ label: 'Cover image alt text' }),
        client: fields.relationship({ label: 'Client', collection: 'organizations' }),
        position: fields.relationship({
          label: 'Position',
          description: 'The job you held while doing this work. Links the project into the career timeline.',
          collection: 'positions',
        }),
        role: fields.text({ label: 'My role', description: 'e.g. "Lead product designer"' }),
        startDate: fields.date({ label: 'Start date' }),
        endDate: fields.date({ label: 'End date' }),
        outcomes: fields.array(fields.text({ label: 'Outcome' }), {
          label: 'Key outcomes',
          description: 'Short, scannable results — metrics, launches, awards.',
          itemLabel: (props) => props.value,
        }),
        medium: fields.text({ label: 'Medium', description: 'Art only — e.g. "Oil on canvas"' }),
        dimensions: fields.text({ label: 'Dimensions', description: 'Art only — e.g. "24 × 36 in"' }),
        gallery: fields.array(
          fields.object({
            image: fields.image({ label: 'Image', ...projectImageDir, validation: { isRequired: true } }),
            alt: fields.text({ label: 'Alt text' }),
            caption: fields.text({ label: 'Caption', multiline: true }),
          }),
          {
            label: 'Gallery',
            description: 'Screenshots or images shown after the case study text.',
            itemLabel: (props) => props.fields.caption.value || props.fields.alt.value || 'Image',
          },
        ),
        credits,
        tags,
        body: fields.markdoc({
          label: 'Case study',
          options: { image: projectImageDir },
        }),
      },
    }),

    organizations: collection({
      label: 'Organizations',
      slugField: 'name',
      path: 'src/content/organizations/*',
      format: 'yaml',
      columns: ['name', 'industry'],
      schema: {
        name: fields.slug({ name: { label: 'Name' } }),
        kinds: fields.multiselect({
          label: 'Relationship',
          description: 'An organization can be both an employer and a client.',
          options: [
            { label: 'Employer', value: 'employer' },
            { label: 'Client', value: 'client' },
          ],
        }),
        industry: fields.text({ label: 'Industry' }),
        location: fields.text({ label: 'Location' }),
        website: fields.url({ label: 'Website' }),
        logo: fields.image({
          label: 'Logo',
          directory: 'src/assets/images/organizations',
          publicPath: '../../assets/images/organizations/',
        }),
        description: fields.text({ label: 'Description', multiline: true }),
        tags,
      },
    }),

    positions: collection({
      label: 'Positions',
      slugField: 'title',
      path: 'src/content/positions/*',
      format: 'yaml',
      columns: ['title', 'organization', 'startDate'],
      schema: {
        title: fields.slug({
          name: { label: 'Job title' },
          slug: {
            label: 'Slug',
            description: 'Must be unique — include the company, e.g. "acme-senior-designer".',
          },
        }),
        organization: fields.relationship({
          label: 'Organization',
          collection: 'organizations',
          validation: { isRequired: true },
        }),
        employmentType: fields.select({
          label: 'Employment type',
          options: [
            { label: 'Full-time', value: 'full-time' },
            { label: 'Part-time', value: 'part-time' },
            { label: 'Contract', value: 'contract' },
            { label: 'Freelance', value: 'freelance' },
            { label: 'Internship', value: 'internship' },
          ],
          defaultValue: 'full-time',
        }),
        roleType: fields.select({
          label: 'Role type',
          description: 'Sets the color coding on the career timeline.',
          options: [
            { label: 'Management', value: 'management' },
            { label: 'Split role (50/50 management/IC)', value: 'split' },
            { label: 'Lead contributor', value: 'lead' },
            { label: 'Individual contributor', value: 'individual' },
            { label: 'Contractor', value: 'contractor' },
            { label: 'Personal work (non-career focus)', value: 'personal' },
          ],
          defaultValue: 'individual',
        }),
        startDate: fields.date({ label: 'Start date', validation: { isRequired: true } }),
        endDate: fields.date({ label: 'End date', description: 'Leave empty if this is your current role.' }),
        location: fields.text({ label: 'Location' }),
        summary: fields.text({ label: 'Summary', multiline: true }),
        highlights: fields.array(fields.text({ label: 'Highlight' }), {
          label: 'Highlights',
          itemLabel: (props) => props.value,
        }),
        tags,
      },
    }),

    people: collection({
      label: 'People',
      slugField: 'name',
      path: 'src/content/people/*',
      format: 'yaml',
      columns: ['name', 'title'],
      schema: {
        name: fields.slug({ name: { label: 'Name' } }),
        title: fields.text({ label: 'Title', description: 'e.g. "Product manager at Acme"' }),
        website: fields.url({ label: 'Website or profile URL' }),
        tags,
      },
    }),

    photos: collection({
      label: 'Photos',
      slugField: 'title',
      path: 'src/content/photos/*',
      format: 'yaml',
      columns: ['title', 'takenAt'],
      schema: {
        title: fields.slug({ name: { label: 'Title' } }),
        cloudinaryId: fields.text({
          label: 'Cloudinary public ID',
          description: 'e.g. "portfolio/photos/harbor-at-dusk". Filled in automatically by `npm run photos:import`.',
          validation: { length: { min: 1 } },
        }),
        width: fields.integer({ label: 'Original width (px)' }),
        height: fields.integer({ label: 'Original height (px)' }),
        alt: fields.text({ label: 'Alt text' }),
        caption: fields.text({ label: 'Caption', multiline: true }),
        takenAt: fields.date({ label: 'Date taken' }),
        location: fields.text({ label: 'Location' }),
        camera: fields.text({ label: 'Camera' }),
        lens: fields.text({ label: 'Lens' }),
        exposure: fields.text({ label: 'Exposure', description: 'e.g. "35mm · ƒ/2.8 · 1/250s · ISO 400"' }),
        credits,
        tags,
      },
    }),

    photoGroups: collection({
      label: 'Photo groups',
      slugField: 'title',
      path: 'src/content/photo-groups/*',
      format: 'yaml',
      columns: ['title', 'date'],
      schema: {
        title: fields.slug({ name: { label: 'Title' } }),
        status: fields.select({
          label: 'Status',
          options: [
            { label: 'Draft', value: 'draft' },
            { label: 'Published', value: 'published' },
          ],
          defaultValue: 'draft',
        }),
        date: fields.date({ label: 'Date', description: 'Used for sorting.' }),
        description: fields.text({ label: 'Description', multiline: true }),
        cover: fields.relationship({
          label: 'Cover photo',
          description: 'Defaults to the first photo.',
          collection: 'photos',
        }),
        photos: fields.array(
          fields.relationship({ label: 'Photo', collection: 'photos', validation: { isRequired: true } }),
          {
            label: 'Photos',
            description: 'Drag to reorder.',
            itemLabel: (props) => props.value ?? 'Select a photo',
          },
        ),
        tags,
      },
    }),

    tags: collection({
      label: 'Tags',
      slugField: 'name',
      path: 'src/content/tags/*',
      format: 'yaml',
      columns: ['name', 'category'],
      schema: {
        name: fields.slug({ name: { label: 'Name' } }),
        category: fields.select({
          label: 'Category',
          options: [
            { label: 'Skill', value: 'skill' },
            { label: 'Tool', value: 'tool' },
            { label: 'Industry', value: 'industry' },
            { label: 'Medium', value: 'medium' },
            { label: 'Theme', value: 'theme' },
            { label: 'Other', value: 'other' },
          ],
          defaultValue: 'skill',
        }),
        description: fields.text({ label: 'Description', multiline: true }),
      },
    }),
  },

  singletons: {
    settings: singleton({
      label: 'Site settings',
      path: 'src/content/site/settings',
      format: 'yaml',
      schema: {
        name: fields.text({ label: 'Your name' }),
        headline: fields.text({ label: 'Headline', description: 'Shown on the home page.' }),
        bio: fields.text({ label: 'Bio', multiline: true, description: 'Shown on the About page. Separate paragraphs with a blank line.' }),
        portrait: fields.image({
          label: 'Portrait',
          description: 'Shown on the About page.',
          directory: 'src/assets/images/about',
          publicPath: '../../assets/images/about/',
        }),
        portraitAlt: fields.text({ label: 'Portrait alt text' }),
        email: fields.text({ label: 'Contact email' }),
        location: fields.text({ label: 'Location' }),
        links: fields.array(
          fields.object({
            label: fields.text({ label: 'Label' }),
            url: fields.url({ label: 'URL' }),
          }),
          { label: 'Links', itemLabel: (props) => props.fields.label.value },
        ),
        experience: fields.array(
          fields.object({
            name: fields.text({ label: 'Organization', validation: { isRequired: true } }),
            years: fields.text({
              label: 'Years',
              description: 'Comma-separated, e.g. "2015, 2016, ..., 2020, 2021".',
            }),
          }),
          {
            label: 'In-house experience',
            description: 'Listed on the About page, in this order.',
            itemLabel: (props) => props.fields.name.value,
          },
        ),
        clients: fields.array(
          fields.object({
            category: fields.text({ label: 'Category', validation: { isRequired: true } }),
            names: fields.text({ label: 'Clients', description: 'One per line.', multiline: true }),
          }),
          {
            label: 'Select freelance clients',
            description: 'Grouped by category on the About page.',
            itemLabel: (props) => props.fields.category.value,
          },
        ),
      },
    }),
  },
});
