import { render, screen } from '@testing-library/react'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
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
    ['/groups', 'groups'],
    ['/admin', 'admin.panel'],
    ['/', 'home'],
    ['/settings', 'home'],
  ] as const)('%s -> %s', (path, topic) => {
    expect(helpTopicForPath(path)).toBe(topic)
  })
})

describe('no hardcoded docs host outside the registry default (#2593)', () => {
  it('only help/docsUrl.ts names docs.visiban.com in app source', () => {
    const root = resolve(__dirname, '..')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = join(dir, e.name)
        if (e.isDirectory()) return e.name === 'test' ? [] : walk(full)
        return /\.(ts|tsx)$/.test(e.name) ? [full] : []
      })
    const files = walk(root).filter((f) => relative(root, f) !== join('help', 'docsUrl.ts'))
    expect(files.length).toBeGreaterThan(50)
    const offenders = files.filter((f) => readFileSync(f, 'utf-8').includes('docs.visiban.com')).map((f) => relative(root, f))
    expect(offenders).toEqual([])
    expect(readFileSync(join(root, 'help/docsUrl.ts'), 'utf-8')).toContain('https://docs.visiban.com')
  })
})
