import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChartPanel } from '../components/Common/Chart'
import { CardHeading, PageHeading, SettingsCard } from '../components/Page'
import { docsUrl } from '../help/docsUrl'
import { helpTopicForPath } from '../help/pageTopic'

describe('help links on shared headings (#2593)', () => {
  it('ChartPanel puts one link beside its heading when given a topic, none otherwise', () => {
    const { rerender } = render(
      <ChartPanel title="Cycle time" summary="s" table={null} help="analytics.flow-metrics">{() => <div />}</ChartPanel>,
    )
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('link')).toHaveAttribute('href', docsUrl('analytics.flow-metrics'))
    rerender(<ChartPanel title="Cycle time" summary="s" table={null}>{() => <div />}</ChartPanel>)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('PageHeading, CardHeading and SettingsCard render a link only with a topic', () => {
    render(
      <>
        <PageHeading title="Page" help="groups" />
        <CardHeading help="permissions">Card</CardHeading>
        <SettingsCard title="Settings" help="board.settings">x</SettingsCard>
        <SettingsCard title="Plain">x</SettingsCard>
        <CardHeading>Plain card</CardHeading>
      </>,
    )
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      docsUrl('groups'), docsUrl('permissions'), docsUrl('board.settings'),
    ])
    expect(screen.getByRole('heading', { name: 'Page' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
  })
})

describe('helpTopicForPath (#2593)', () => {
  it.each([
    ['/boards/4', 'board.overview'],
    ['/groups/2', 'groups'],
    ['/admin', 'admin.panel'],
    ['/', 'home'],
    ['/settings', 'home'],
  ] as const)('%s -> %s', (path, topic) => {
    expect(helpTopicForPath(path)).toBe(topic)
  })
})

describe('no hardcoded docs host outside the registry default (#2593)', () => {
  it('only help/docsUrl.ts names docs.visiban.com in app source', () => {
    const src = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf-8')
    for (const f of ['pages/AdminPage.tsx', 'components/Layout/UserMenu.tsx', 'components/Board/webhooks/WebhookServiceNotice.tsx']) {
      expect(src(f)).not.toContain('docs.visiban.com')
    }
    expect(src('help/docsUrl.ts')).toContain('https://docs.visiban.com')
  })
})
