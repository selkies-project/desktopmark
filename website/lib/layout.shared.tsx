import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { repoUrl, siteName } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: <span className="font-semibold">{siteName}</span> },
    githubUrl: repoUrl,
    themeSwitch: { mode: 'light-dark-system' },
  };
}
