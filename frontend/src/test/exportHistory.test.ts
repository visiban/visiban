import { describe, it, expect } from 'vitest'
import { formatExportFormatLabel, formatExportRowCount, isMovementsExport } from '../utils/exportHistory'

describe('exportHistory helpers (#1499)', () => {
  it('keeps plain card formats uppercased', () => {
    expect(formatExportFormatLabel('csv')).toBe('CSV')
    expect(formatExportFormatLabel('json')).toBe('JSON')
  })
  it('renders movement exports as Movements (FMT)', () => {
    expect(formatExportFormatLabel('movements_csv')).toBe('Movements (CSV)')
    expect(formatExportFormatLabel('movements_json')).toBe('Movements (JSON)')
  })
  it('falls back to uppercase for unknown or empty-suffix values', () => {
    expect(formatExportFormatLabel('xlsx')).toBe('XLSX')
    expect(formatExportFormatLabel('movements_')).toBe('MOVEMENTS_')
  })
  it('detects movement exports', () => {
    expect(isMovementsExport('movements_csv')).toBe(true)
    expect(isMovementsExport('csv')).toBe(false)
  })
  it('uses the right noun and plural for row counts', () => {
    expect(formatExportRowCount('csv', 12)).toBe('12 cards')
    expect(formatExportRowCount('csv', 1)).toBe('1 card')
    expect(formatExportRowCount('movements_csv', 3)).toBe('3 movements')
    expect(formatExportRowCount('movements_csv', 1)).toBe('1 movement')
  })
})
