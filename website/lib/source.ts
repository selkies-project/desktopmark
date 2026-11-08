import { loader } from 'fumadocs-core/source';
import { getSlugs } from 'fumadocs-core/source/plugins/slugs';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { defineDocs } from 'fumadocs-mdx/macro';

const docs = defineDocs({
  dir: '../docs',
  docs: { schema: pageSchema },
  meta: { schema: metaSchema },
});

export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
  slugs(file) {
    const segments = getSlugs(file.path);
    if (segments.at(-1) === 'README') segments.pop();
    return segments;
  },
});
