import { createRelativeLink } from 'fumadocs-ui/mdx';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  EditOnGitHub,
} from 'fumadocs-ui/layouts/spacious/page';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import { gitConfig, siteName } from '@/lib/shared';
import { source } from '@/lib/source';

function editUrl(path: string) {
  const { user, repo, branch, dir } = gitConfig;
  return `https://github.com/${user}/${repo}/edit/${branch}/${dir}/${path}`;
}

export default async function Page(props: PageProps<'/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const edit = <EditOnGitHub href={editUrl(page.path)} />;

  return (
    <DocsPage
      toc={page.data.toc}
      full={page.data.full}
      tableOfContent={{ footer: edit }}
      tableOfContentPopover={{ footer: edit }}
    >
      <div className="mb-6 flex flex-col gap-4 border-b border-fd-border pb-6">
        <DocsTitle>{page.data.title}</DocsTitle>
        <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      </div>
      <DocsBody>
        <MDX components={getMDXComponents({ a: createRelativeLink(source, page) })} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<'/[[...slug]]'>): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.url === '/' ? { absolute: siteName } : page.data.title,
    description: page.data.description,
  };
}
